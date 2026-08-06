"""告警规则与状态机。

每轮采集后评估一遍，得到当前"处于异常的" key 集合，与上一轮对比：
  新出现  -> 记事件 + 推送
  已消失  -> 记恢复事件 + 推送恢复
持续存在的不重复推，除非超过 repeat_hours。

抖动抑制：规则可设 sustain_seconds，异常必须连续存在这么久才真正告警，
避免服务探针偶发超时就把你吵醒。
"""
import logging
import time

log = logging.getLogger("homelab.alerts")

LEVEL_TEXT = {"warn": "警告", "crit": "严重", "info": "提示"}

# 前端据此自动渲染设置表单。加新规则只改这里，不用两头对齐字段
RULE_SCHEMA = [
    {"key": "storage", "name": "磁盘容量", "desc": "卷使用率超过阈值",
     "fields": [{"key": "warn", "label": "警告", "unit": "%", "min": 50, "max": 99},
                {"key": "crit", "label": "严重", "unit": "%", "min": 50, "max": 99}]},
    {"key": "service", "name": "服务掉线", "desc": "健康探针连续失败", "fields": []},
    {"key": "cert", "name": "证书到期", "desc": "HTTPS 证书剩余天数",
     "fields": [{"key": "warn_days", "label": "警告", "unit": "天", "min": 1, "max": 90},
                {"key": "crit_days", "label": "严重", "unit": "天", "min": 1, "max": 30}]},
    {"key": "host", "name": "主机负载", "desc": "CPU / 内存 / 温度持续高位",
     "fields": [{"key": "cpu_percent", "label": "CPU", "unit": "%", "min": 50, "max": 100},
                {"key": "mem_percent", "label": "内存", "unit": "%", "min": 50, "max": 100},
                {"key": "temp_c", "label": "温度", "unit": "°C", "min": 40, "max": 95}]},
    {"key": "disk", "name": "硬盘健康", "desc": "坏道立刻报；服役年限只提醒一次即可关掉",
     "fields": []},
    {"key": "new_ban", "name": "新增封禁", "desc": "本地检出的攻击者被封时提醒",
     "fields": []},
    {"key": "collector", "name": "采集器失败", "desc": "面板自身某个采集器报错",
     "fields": []},
]
SCHEMA_BY_KEY = {r["key"]: r for r in RULE_SCHEMA}


class AlertEngine:
    def __init__(self, cfg, history, notifier):
        acfg = (cfg or {}).get("alerts") or {}
        self.enabled = bool(acfg.get("enabled", True))
        self.cfg = acfg
        # 推送标题的前缀。手机上同时收几台机器的告警时，靠它区分是哪台
        self.site_name = str((cfg or {}).get("site_name") or "Homelab")
        self.history = history
        self.notifier = notifier
        self.repeat_hours = float(acfg.get("repeat_hours", 12))
        self.sustain = int(acfg.get("sustain_seconds", 120))
        self.base_rules = acfg.get("rules") or {}
        # key -> {"level","title","detail","first_seen","alerted_at"}
        self._active = {}
        self._known_bans = None       # 首轮只做基线，不为存量封禁刷屏
        self._overrides = {}          # 面板改的规则，覆盖 config 里的默认值
        self._muted = {}              # 告警 key -> 静音到期时间戳(0 表示永久)
        self.reload_settings()

    # ---------- 运行时配置 ----------

    def reload_settings(self):
        """从历史库读回面板做的调整。config.yaml 出默认值，这里出覆盖"""
        st = self.history.get_settings() if self.history else {}
        self._overrides = st.get("alert_rules") or {}
        self._muted = st.get("alert_muted") or {}
        g = st.get("alert_global") or {}
        acfg = self.cfg
        self.enabled = bool(g.get("enabled", acfg.get("enabled", True)))
        self.repeat_hours = float(g.get("repeat_hours", acfg.get("repeat_hours", 12)))
        self.sustain = int(g.get("sustain_seconds", acfg.get("sustain_seconds", 120)))

    @property
    def rules(self):
        """config 默认值叠加面板覆盖。逐规则深合并，只改一个字段不会清掉其他字段"""
        merged = {}
        for key in set(self.base_rules) | set(self._overrides) | set(SCHEMA_BY_KEY):
            base = self.base_rules.get(key)
            over = self._overrides.get(key)
            if isinstance(base, dict) or isinstance(over, dict):
                item = dict(base if isinstance(base, dict) else {})
                item.update(over if isinstance(over, dict) else {})
                merged[key] = item
            elif over is not None:
                merged[key] = over
            elif base is not None:
                merged[key] = base
        return merged

    def is_muted(self, key):
        until = self._muted.get(key)
        if until is None:
            return False
        if until == 0:                    # 0 = 永久静音
            return True
        if time.time() < until:
            return True
        self._muted.pop(key, None)        # 到期自动解除
        self.history.set_setting("alert_muted", self._muted)
        return False

    def mute(self, key, hours=None):
        self._muted[key] = 0 if not hours else time.time() + hours * 3600
        self.history.set_setting("alert_muted", self._muted)
        return self._muted[key]

    def unmute(self, key):
        if self._muted.pop(key, None) is None:
            return False
        self.history.set_setting("alert_muted", self._muted)
        return True

    def update_rules(self, patch, global_patch=None):
        merged = dict(self._overrides)
        for key, val in (patch or {}).items():
            if isinstance(val, dict):
                item = dict(merged.get(key) or {})
                item.update(val)
                merged[key] = item
            else:
                merged[key] = val
        self._overrides = merged
        self.history.set_setting("alert_rules", merged)
        if global_patch:
            st = self.history.get_settings().get("alert_global") or {}
            st.update(global_patch)
            self.history.set_setting("alert_global", st)
        self.reload_settings()

    def _on(self, name, default=True):
        rule = self.rules.get(name)
        if rule is None:
            return default
        if isinstance(rule, bool):
            return rule
        return bool(rule.get("enabled", True))

    def _num(self, name, field, default):
        rule = self.rules.get(name)
        if isinstance(rule, dict) and rule.get(field) is not None:
            try:
                return float(rule[field])
            except (TypeError, ValueError):
                return default
        return default

    # ---------- 规则评估 ----------

    def _evaluate(self, sections):
        """返回 {key: (level, title, detail)}，代表此刻处于异常的项"""
        found = {}

        storage = (sections.get("storage") or {}).get("data") or {}
        if self._on("storage"):
            for vol in storage.get("volumes") or []:
                if not vol.get("ok") or vol.get("percent") is None:
                    continue
                pct, label = vol["percent"], vol.get("label", "?")
                crit = self._num("storage", "crit", vol.get("crit") or 90)
                warn = self._num("storage", "warn", vol.get("warn") or 80)
                if pct >= crit:
                    found[f"storage:{label}"] = (
                        "crit", f"{label} 已用 {pct}%",
                        f"超过严重阈值 {crit:.0f}%，剩余空间告急")
                elif pct >= warn:
                    found[f"storage:{label}"] = (
                        "warn", f"{label} 已用 {pct}%",
                        f"超过警告阈值 {warn:.0f}%")

        svc = (sections.get("services") or {}).get("data") or {}
        if self._on("service"):
            for item in svc.get("items") or []:
                if not item.get("ok"):
                    found[f"service:{item.get('name')}"] = (
                        "crit", f"服务掉线: {item.get('name')}",
                        str(item.get("error") or item.get("status_code") or "探针失败"))

        certs = (sections.get("certs") or {}).get("data") or {}
        if self._on("cert"):
            crit_days = self._num("cert", "crit_days", 7)
            warn_days = self._num("cert", "warn_days", 30)
            for c in certs.get("items") or []:
                if not c.get("ok") or c.get("days_left") is None:
                    continue
                name = c.get("subject") or c.get("target")
                if c["days_left"] <= crit_days:
                    found[f"cert:{name}"] = (
                        "crit", f"证书 {c['days_left']} 天后到期: {name}", "需要尽快续签")
                elif c["days_left"] <= warn_days:
                    found[f"cert:{name}"] = (
                        "warn", f"证书 {c['days_left']} 天后到期: {name}", "")

        host = (sections.get("host") or {}).get("data") or {}
        if self._on("host") and host.get("ok"):
            mem = (host.get("memory") or {}).get("percent")
            mem_crit = self._num("host", "mem_percent", 92)
            if mem is not None and mem >= mem_crit:
                found["host:mem"] = ("warn", f"内存占用 {mem}%",
                                     f"持续超过 {mem_crit:.0f}%")
            cpu = host.get("cpu_percent")
            cpu_crit = self._num("host", "cpu_percent", 90)
            if cpu is not None and cpu >= cpu_crit:
                found["host:cpu"] = ("warn", f"CPU 占用 {cpu}%",
                                     f"持续超过 {cpu_crit:.0f}%")
            temp = host.get("temperature")
            temp_crit = self._num("host", "temp_c", 75)
            if temp is not None and temp >= temp_crit:
                found["host:temp"] = ("warn", f"CPU 温度 {temp} °C", "")

        disks = (sections.get("disks") or {}).get("data") or {}
        if self._on("disk") and disks.get("ok"):
            for d in disks.get("items") or []:
                if d.get("level") == "crit":
                    found[f"disk:{d['device']}"] = (
                        "crit", f"硬盘 {d['device']} 出现坏道",
                        f"{d.get('model') or ''} {'；'.join(d.get('issues') or [])}"
                        "。无冗余，尽快备份数据并更换")
                elif d.get("level") == "warn":
                    found[f"disk:{d['device']}"] = (
                        "warn", f"硬盘 {d['device']} 已服役 {d.get('years')} 年",
                        f"{d.get('model') or ''}，机械盘到这个岁数建议提前准备替换")

        for name, sec in sections.items():
            if self._on("collector") and sec and sec.get("error"):
                found[f"collector:{name}"] = (
                    "warn", f"采集器 {name} 失败", str(sec["error"])[:300])

        return found

    def _new_bans(self, sections):
        """新增封禁单独走，它是一次性事件不是持续状态"""
        if not self._on("new_ban"):
            return []
        cs = (sections.get("crowdsec") or {}).get("data") or {}
        decisions = cs.get("decisions")
        if decisions is None:
            return []
        # 只报本地检出的。社区黑名单每次同步上千条会刷屏；手动封禁是你自己点的，
        # API 层已经记过事件，这里再报一次就是同一件事出现两条
        current = {d["ip"]: d for d in decisions
                   if d.get("ip") and d.get("kind") == "detected"}
        if self._known_bans is None:
            self._known_bans = set(current)
            return []
        fresh = [current[ip] for ip in current if ip not in self._known_bans]
        self._known_bans = set(current)
        return fresh

    # ---------- 主流程 ----------

    def process(self, sections):
        if not self.enabled:
            return
        now = time.time()
        try:
            found = self._evaluate(sections)
        except Exception as exc:  # noqa: BLE001  告警自身不能拖垮采集
            log.warning("规则评估异常: %s", exc)
            return

        for key, (level, title, detail) in found.items():
            state = self._active.get(key)
            if state is None:
                self._active[key] = {"level": level, "title": title, "detail": detail,
                                     "first_seen": now, "alerted_at": None}
                continue
            state["level"], state["title"], state["detail"] = level, title, detail
            if now - state["first_seen"] < self.sustain:
                continue          # 还没坐实，再等等
            if self.is_muted(key):
                continue
            last = state["alerted_at"]
            if last is None or now - last >= self.repeat_hours * 3600:
                state["alerted_at"] = now
                self._fire(key, level, title, detail, repeat=last is not None)

        for key in [k for k in self._active if k not in found]:
            state = self._active.pop(key)
            if state.get("alerted_at"):
                self._fire(key, "info", f"已恢复: {state['title']}", "", recovered=True)

        for ban in self._new_bans(sections):
            if self.is_muted(f"ban:{ban['ip']}"):
                continue
            where = " ".join(filter(None, [ban.get("country"), ban.get("as_name")]))
            self._fire(f"ban:{ban['ip']}", "warn", f"新封禁 {ban['ip']}",
                       f"{(ban.get('reason') or '').split('/')[-1]}"
                       f"{'  ' + where if where else ''}", kind="ban")

    def _fire(self, key, level, title, detail, kind="alert",
              recovered=False, repeat=False):
        self.history.record_event(kind, level, key, title, detail)
        log.info("[%s] %s %s", level, title, detail or "")

        if not self.notifier.should_send(level) and not recovered:
            return
        if recovered and not self.cfg.get("notify_recovery", True):
            return

        tag = "恢复" if recovered else LEVEL_TEXT.get(level, level)
        subject = f"[{self.site_name}·{tag}] {title}"
        body = detail or ""
        if repeat:
            body += f"\n\n> 该问题已持续超过 {self.repeat_hours:g} 小时，仍未解决"
        body += f"\n\n时间 {time.strftime('%Y-%m-%d %H:%M:%S')}"
        err = self.notifier.send(subject, body)
        if err and err != "推送未启用":
            log.warning("推送失败 [%s]: %s", title, err)

    # ---------- 给面板看的 ----------

    def snapshot(self):
        now = time.time()
        items = []
        for key, s in self._active.items():
            muted_until = self._muted.get(key)
            items.append({
                "key": key, "level": s["level"], "title": s["title"],
                "detail": s["detail"], "since": s["first_seen"],
                "duration": round(now - s["first_seen"]),
                "notified": s["alerted_at"] is not None,
                "pending": now - s["first_seen"] < self.sustain,
                "muted": self.is_muted(key),
                "muted_until": muted_until if muted_until else None,
            })
        items.sort(key=lambda x: (x["muted"],
                                  {"crit": 0, "warn": 1}.get(x["level"], 2),
                                  -x["duration"]))
        live = [i for i in items if not i["muted"]]
        return {"enabled": self.enabled, "active": items,
                "crit": sum(1 for i in live if i["level"] == "crit"),
                "warn": sum(1 for i in live if i["level"] == "warn"),
                "muted": sum(1 for i in items if i["muted"]),
                "notify_enabled": self.notifier.enabled,
                "sustain_seconds": self.sustain,
                "repeat_hours": self.repeat_hours}

    def settings_view(self):
        """给设置页用：每条规则的当前值、默认值、是否被改过"""
        rules = self.rules
        out = []
        for spec in RULE_SCHEMA:
            key = spec["key"]
            cur = rules.get(key)
            cur = cur if isinstance(cur, dict) else {}
            base = self.base_rules.get(key)
            base = base if isinstance(base, dict) else {}
            fields = []
            for f in spec["fields"]:
                fields.append({**f,
                               "value": cur.get(f["key"], base.get(f["key"])),
                               "default": base.get(f["key"])})
            out.append({"key": key, "name": spec["name"], "desc": spec["desc"],
                        "enabled": self._on(key),
                        "overridden": key in self._overrides,
                        "fields": fields})
        return {
            "rules": out,
            "global": {"enabled": self.enabled,
                       "sustain_seconds": self.sustain,
                       "repeat_hours": self.repeat_hours},
            "muted": [{"key": k, "until": v or None} for k, v in self._muted.items()],
            "notify_enabled": self.notifier.enabled,
        }
