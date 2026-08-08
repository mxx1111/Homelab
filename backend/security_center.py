"""统一安全中心。

这个模块刻意不成为“又一套防火墙”。它把已有的 CrowdSec、端口采集、节点
bouncer 和 1Panel WAF 归一成三个稳定视图：覆盖面、事件、应用防护。底层实现
可以替换，API 和前端不必跟着变。
"""
import ipaddress
import json
import os
import sqlite3
import time
from collections import defaultdict
from pathlib import Path

import httpx


DANGEROUS_PORTS = {
    3306: "MySQL", 5432: "PostgreSQL", 6379: "Redis", 27017: "MongoDB",
    9200: "Elasticsearch", 11211: "Memcached", 2375: "Docker API",
}
INCIDENT_STATUS = {"open", "investigating", "resolved", "ignored"}


def _data(sections, name):
    return ((sections or {}).get(name) or {}).get("data") or {}


def _severity_rank(level):
    return {"crit": 0, "warn": 1, "info": 2, "ok": 3}.get(level, 9)


def _service_baseline(sections):
    services = _data(sections, "services")
    items = services.get("items") or []
    return {str(x.get("name")): bool(x.get("ok")) for x in items if x.get("name")}


class OnePanelWafAdapter:
    """只读 1Panel OpenResty WAF 数据目录；挂载不存在时安静降级。"""

    def __init__(self, cfg):
        scfg = (cfg or {}).get("security_center") or {}
        wcfg = scfg.get("onepanel_waf") or {}
        self.path = Path(wcfg.get("path") or "/app/security/1panel-waf")

    @staticmethod
    def _json(path):
        try:
            with path.open(encoding="utf-8") as fp:
                return json.load(fp)
        except (OSError, ValueError, TypeError):
            return None

    @staticmethod
    def _count(path, table, where=""):
        try:
            conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=2)
            try:
                return conn.execute(f"SELECT COUNT(*) FROM {table} {where}").fetchone()[0]
            finally:
                conn.close()
        except sqlite3.Error:
            return None

    def snapshot(self):
        if not self.path.is_dir():
            return {"adapter": "onepanel", "available": False,
                    "mode": "not-mounted", "path": str(self.path),
                    "message": "未挂载 1Panel WAF 数据目录；不影响现有代理和防护"}
        db = self.path / "db" / "waf"
        global_cfg = self._json(self.path / "conf" / "global.json")
        sites_cfg = self._json(self.path / "conf" / "sites.json")
        enabled_rules = []
        disabled_rules = []
        if isinstance(global_cfg, dict):
            for key, value in global_cfg.items():
                enabled = None
                if isinstance(value, dict):
                    enabled = value.get("enable", value.get("enabled"))
                    if enabled is None and "state" in value:
                        enabled = str(value.get("state") or "").lower() == "on"
                if enabled is True:
                    enabled_rules.append(key)
                elif enabled is False:
                    disabled_rules.append(key)
        attack_total = self._count(db / "attack_logs.db", "attack_logs")
        blocked_total = self._count(db / "attack_logs.db", "attack_logs", "WHERE is_block=1")
        request_total = self._count(db / "nginx_logs.db", "nginx_logs")
        site_count = len(sites_cfg) if isinstance(sites_cfg, (dict, list)) else None
        return {
            "adapter": "onepanel", "available": True, "mode": "active-readonly",
            "path": str(self.path), "site_count": site_count,
            "request_rows": request_total, "attack_rows": attack_total,
            "blocked_rows": blocked_total, "enabled_rules": sorted(enabled_rules),
            "disabled_rules": sorted(disabled_rules),
            "capabilities": {
                "waf": any(x in enabled_rules for x in ("waf", "sql", "xss")),
                "rate_limit": any(x in enabled_rules for x in ("cc", "urlcc", "attackCount")),
                "bot": "bot" in enabled_rules,
                "geo": "geoRestrict" in enabled_rules,
                "allow_deny": any(x in enabled_rules for x in
                                  ("ipWhite", "ipBlack", "urlWhite", "urlBlack")),
            },
            "message": "数据以只读方式读取，面板不会修改 1Panel WAF 配置",
        }


class CrowdSecAppSecAdapter:
    """展示 AppSec 是否存在。默认不把它插入已有 OpenResty 请求链。"""

    def __init__(self, cfg):
        scfg = (cfg or {}).get("security_center") or {}
        acfg = scfg.get("crowdsec_appsec") or {}
        self.enabled = bool(acfg.get("enabled", False))
        self.listen = acfg.get("listen")

    def snapshot(self):
        return {
            "adapter": "crowdsec-appsec", "configured": self.enabled,
            "mode": "observe" if self.enabled else "standby",
            "listen": self.listen,
            "message": ("已配置为观察模式" if self.enabled else
                        "待命：当前由 1Panel WAF 保护 Web 链路，避免双 WAF 叠加"),
        }


class SecurityCenter:
    def __init__(self, cfg, history):
        self.cfg = cfg or {}
        self.history = history
        scfg = self.cfg.get("security_center") or {}
        self.enabled = bool(scfg.get("enabled", True))
        self.cti_key = os.environ.get("HOMELAB_CROWDSEC_CTI_KEY") or ""
        self.cti_ttl = int((scfg.get("cti") or {}).get("cache_seconds", 21600))
        self.map_cfg = scfg.get("map") or {}
        self.onepanel = OnePanelWafAdapter(cfg)
        self.appsec_adapter = CrowdSecAppSecAdapter(cfg)
        self.sensitive_ports = dict(DANGEROUS_PORTS)
        for port, label in (scfg.get("sensitive_ports") or {}).items():
            try:
                self.sensitive_ports[int(port)] = str(label)
            except (TypeError, ValueError):
                continue
        for item in os.environ.get("HOMELAB_SENSITIVE_PORTS", "").split(","):
            port, sep, label = item.strip().partition(":")
            if not sep:
                continue
            try:
                self.sensitive_ports[int(port)] = label.strip() or f"敏感服务 {port}"
            except ValueError:
                continue

    def map_options(self):
        """前端底图配置。攻击点不发给瓦片服务，只在浏览器本地叠加。"""
        try:
            max_zoom = max(3, min(19, int(self.map_cfg.get("max_zoom", 12))))
        except (TypeError, ValueError):
            max_zoom = 12
        return {
            "tile_url": str(self.map_cfg.get("tile_url") or
                            "https://tile.openstreetmap.org/{z}/{x}/{y}.png"),
            "attribution": str(self.map_cfg.get("attribution") or
                               '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'),
            "max_zoom": max_zoom,
        }

    def coverage(self, sections):
        ports = _data(sections, "ports")
        crowdsec = _data(sections, "crowdsec")
        nodes = _data(sections, "nodes")
        services = _data(sections, "services")
        issues = []
        assets = []

        def issue(level, code, title, detail, machine="本机", target=None):
            issues.append({"level": level, "code": code, "title": title,
                           "detail": detail, "machine": machine, "target": target})

        for p in ports.get("items") or []:
            if not p.get("public"):
                continue
            assets.append({"machine": "本机", "kind": "port", "target": p.get("port"),
                           "owner": p.get("owner"), "protection": "CrowdSec/宿主机防火墙",
                           "state": "listening"})
            if not p.get("owner"):
                issue("warn", "public-unowned", f"公网端口 {p.get('port')} 未认领",
                      "在 ports.labels 或 services 中标注服务归属", target=p.get("port"))
            if p.get("port") in self.sensitive_ports:
                issue("crit", "dangerous-public", f"{self.sensitive_ports[p['port']]} 端口对公网声明开放",
                      "数据库和管理端口应只走内网/VPN或明确来源白名单", target=p.get("port"))
        listening = {p.get("port") for p in ports.get("items") or []}
        for port in ports.get("declared_public") or []:
            if port not in listening:
                issue("warn", "declared-not-listening", f"声明的公网端口 {port} 未监听",
                      "可能是服务停止，也可能是 public_ports 配置已过期", target=port)

        central_bans = int(crowdsec.get("active_bans") or 0)
        for n in nodes.get("items") or []:
            name = n.get("name") or "未知节点"
            if not n.get("ok"):
                issue("crit", "node-offline", f"节点 {name} 无法采集",
                      n.get("error") or "SSH 采集失败", machine=name)
                continue
            cs = n.get("crowdsec") or {}
            observed_appsec = n.get("appsec") or {}
            if cs.get("agent") not in ("active", None):
                issue("crit", "agent-inactive", f"{name} CrowdSec agent 未运行",
                      f"当前状态 {cs.get('agent')}", machine=name)
            if cs.get("bouncer") not in ("active", None):
                issue("crit", "bouncer-inactive", f"{name} 防火墙 bouncer 未运行",
                      f"当前状态 {cs.get('bouncer')}", machine=name)
            if observed_appsec.get("available"):
                assets.append({"machine": name, "kind": "waf",
                               "target": f"{observed_appsec.get('site_count') or 0} 个站点",
                               "owner": "1Panel WAF", "protection": "OpenResty 1PWAF",
                               "state": "active"})
            local = cs.get("ipset_entries")
            if central_bans and isinstance(local, int) and local == 0:
                issue("crit", "delivery-gap", f"{name} 未落地中央封禁",
                      f"中央有 {central_bans} 条决策，本机 ipset 为 0", machine=name)
            for p in (n.get("ports") or {}).get("items") or []:
                assets.append({"machine": name, "kind": "listener", "target": p.get("port"),
                               "owner": p.get("proc"), "protection": "CrowdSec bouncer",
                               "state": "listening"})
                if p.get("port") in self.sensitive_ports and p.get("addr") in ("0.0.0.0", "::", "*"):
                    issue("warn", "dangerous-listener",
                          f"{name} 的 {self.sensitive_ports[p['port']]} 监听所有网卡",
                          f"{p.get('addr')}:{p.get('port')}，需确认仅内网可达",
                          machine=name, target=p.get("port"))

        for svc in services.get("items") or []:
            if svc.get("public") or str(svc.get("url") or "").startswith("https://"):
                assets.append({"machine": "本机", "kind": "service",
                               "target": svc.get("url"), "owner": svc.get("name"),
                               "protection": "OpenResty/WAF", "state": "up" if svc.get("ok") else "down"})
                if not svc.get("ok"):
                    issue("crit", "public-service-down", f"公网服务 {svc.get('name')} 不健康",
                          svc.get("error") or "探针失败", target=svc.get("url"))

        nodes_total = int(nodes.get("configured") or 0)
        nodes_online = int(nodes.get("online") or 0)
        if nodes_total and nodes_online != nodes_total:
            enforcement = "degraded"
        elif any(x["level"] == "crit" for x in issues):
            enforcement = "degraded"
        else:
            enforcement = "healthy"
        hit_packets = sum(int(((n.get("crowdsec") or {}).get("blocked_packets") or 0))
                          for n in nodes.get("items") or [] if n.get("ok"))
        pipeline = [
            {"stage": "detected", "label": "攻击检出", "value": crowdsec.get("alerts_24h", 0)},
            {"stage": "decision", "label": "中央决策", "value": central_bans},
            {"stage": "delivered", "label": "节点在线", "value": f"{nodes_online}/{nodes_total}" if nodes_total else "本机"},
            {"stage": "active", "label": "bouncer 生效", "value": enforcement},
            {"stage": "hit", "label": "节点拦截包", "value": hit_packets},
        ]
        issues.sort(key=lambda x: (_severity_rank(x["level"]), x["machine"], x["title"]))
        unique_issues = []
        seen_issues = set()
        for item in issues:
            key = (item["code"], item["machine"], str(item.get("target")))
            if key in seen_issues:
                continue
            seen_issues.add(key)
            unique_issues.append(item)
        issues = unique_issues
        return {"enabled": self.enabled, "status": enforcement, "assets": assets,
                "issues": issues, "counts": {
                    "assets": len(assets), "crit": sum(x["level"] == "crit" for x in issues),
                    "warn": sum(x["level"] == "warn" for x in issues),
                    "nodes_online": nodes_online, "nodes_total": nodes_total,
                }, "pipeline": pipeline, "generated_at": int(time.time())}

    def incidents(self, sections, hours=168, limit=100):
        crowdsec = _data(sections, "crowdsec")
        grouped = defaultdict(lambda: {"source": "crowdsec", "count": 0,
                                       "event_count": 0, "scenarios": set(),
                                       "machines": set(), "first_age_hours": 0,
                                       "last_age_hours": None})
        for alert in crowdsec.get("alerts") or []:
            age = alert.get("age_hours")
            if age is None or age > hours or not alert.get("ip"):
                continue
            key = f"crowdsec:{alert['ip']}"
            slot = grouped[key]
            slot.update({"key": key, "ip": alert["ip"], "country": alert.get("country"),
                         "as_name": alert.get("as_name"),
                         "latitude": alert.get("latitude"),
                         "longitude": alert.get("longitude")})
            slot["count"] += 1
            slot["event_count"] += int(alert.get("events_count") or 0)
            slot["first_age_hours"] = max(slot["first_age_hours"], age)
            slot["last_age_hours"] = age if slot["last_age_hours"] is None else min(slot["last_age_hours"], age)
            if alert.get("scenario_cn") or alert.get("scenario"):
                slot["scenarios"].add(alert.get("scenario_cn") or alert.get("scenario"))
            if alert.get("machine"):
                slot["machines"].add(alert["machine"])
        items = []
        annotations = self.history.incident_annotations(grouped.keys())
        decisions = {x.get("ip") for x in crowdsec.get("decisions") or []}
        for key, slot in grouped.items():
            slot["scenarios"] = sorted(slot["scenarios"])
            slot["machines"] = sorted(slot["machines"])
            slot["blocked"] = slot.get("ip") in decisions
            slot.update(annotations.get(key) or {"status": "open", "note": "",
                                                 "false_positive": False})
            items.append(slot)
        items.sort(key=lambda x: (x.get("false_positive", False),
                                  x.get("status") == "resolved",
                                  x.get("last_age_hours") or 0))
        return {"hours": hours, "items": items[:limit], "total": len(items),
                "open": sum(x.get("status") not in ("resolved", "ignored") for x in items),
                "blocked": sum(bool(x.get("blocked")) for x in items)}

    def incident_update(self, key, status, note, false_positive):
        if not key.startswith(("crowdsec:", "waf:")):
            raise ValueError("未知事件标识")
        if status not in INCIDENT_STATUS:
            raise ValueError("status 必须是 open/investigating/resolved/ignored")
        return self.history.incident_update(key, status, note, false_positive)

    def appsec(self, sections=None):
        onepanel = self.onepanel.snapshot()
        remote = []
        for node in _data(sections, "nodes").get("items") or []:
            observed = node.get("appsec") or {}
            if node.get("ok") and observed.get("available"):
                remote.append({**observed, "machine": node.get("name"),
                               "mode": "active-readonly",
                               "message": "由节点受限脚本只读采集，不传站点或请求明细"})
        if remote and not onepanel.get("available"):
            onepanel = {**remote[0], "remote_nodes": remote}
        appsec = self.appsec_adapter.snapshot()
        active = "onepanel" if onepanel.get("available") else (
            "crowdsec-appsec" if appsec.get("configured") else "none")
        return {"active_adapter": active, "onepanel": onepanel,
                "crowdsec_appsec": appsec,
                "safe_mode": "readonly-observe",
                "double_waf_avoided": bool(onepanel.get("available") and not appsec.get("configured"))}

    def cti(self, ip):
        try:
            addr = ipaddress.ip_address(str(ip).strip())
        except ValueError as exc:
            raise ValueError("IP 格式不正确") from exc
        if not addr.is_global:
            raise ValueError("CTI 只查询公网 IP")
        cached = self.history.cti_get(str(addr))
        if cached:
            return {"enabled": True, "ip": str(addr), **cached}
        if not self.cti_key:
            return {"enabled": False, "ip": str(addr),
                    "message": "未配置 HOMELAB_CROWDSEC_CTI_KEY，未访问外部 CTI"}
        response = httpx.get(f"https://cti.api.crowdsec.net/v2/smoke/{addr}",
                             headers={"x-api-key": self.cti_key}, timeout=8)
        response.raise_for_status()
        data = response.json()
        self.history.cti_put(str(addr), data, self.cti_ttl)
        return {"enabled": True, "ip": str(addr), "data": data,
                "cached": False, "fetched_at": int(time.time())}

    @staticmethod
    def preflight(sections):
        return {"services": _service_baseline(sections),
                "nodes": {n.get("name"): bool(n.get("ok"))
                          for n in _data(sections, "nodes").get("items") or []},
                "captured_at": int(time.time())}

    @staticmethod
    def regressions(before, sections):
        after_services = _service_baseline(sections)
        after_nodes = {n.get("name"): bool(n.get("ok"))
                       for n in _data(sections, "nodes").get("items") or []}
        problems = []
        for name, was_ok in (before.get("services") or {}).items():
            if was_ok and after_services.get(name) is False:
                problems.append(f"服务 {name} 从正常变为异常")
        for name, was_ok in (before.get("nodes") or {}).items():
            if was_ok and after_nodes.get(name) is False:
                problems.append(f"节点 {name} 从在线变为离线")
        return problems
