"""CrowdSec 封禁与解封。

读走 SQLite(见 collectors/crowdsec.py)，写必须走 LAPI：直接改库不会通知
bouncer，规则不会真正下到 iptables。LAPI 的 bouncer key 只有读权限，写需要
machine 凭据，复用 crowdsec agent 自己的 local_api_credentials.yaml
(compose 里只读挂载)，这样密钥不进版本库，也不用另外注册 machine。

封禁的实际生效链路:
  POST /v1/alerts -> LAPI 落库 -> firewall-bouncer 轮询(约 10s) -> iptables
所以点下按钮到真正拦截，最长有十几秒延迟。
"""
import ipaddress
import threading
import time
from datetime import datetime, timedelta, timezone

import httpx
import yaml

DEFAULT_CREDENTIALS = "/etc/crowdsec/local_api_credentials.yaml"
ORIGIN = "cscli"          # 用 cscli 而非自定义值，cscli decisions list 才认得
SCENARIO = "manual 'ban' from 'homelab-dashboard'"

# 封了这些等于把自己锁在门外。默认硬保护，config 里只能加不能减。
PROTECTED_NETS = [
    "127.0.0.0/8",
    "10.0.0.0/8",
    "172.16.0.0/12",
    "192.168.0.0/16",
    "100.64.0.0/10",      # Tailscale CGNAT 段
    "::1/128",
    "fc00::/7",
]

DURATIONS = {
    "15m": "15 分钟", "1h": "1 小时", "4h": "4 小时", "24h": "24 小时",
    "7d": "7 天", "30d": "30 天", "8760h": "永久(1 年)",
}


class FirewallError(Exception):
    """带用户可读文案的操作失败"""


def _parse_duration(text):
    """'4h' -> timedelta。CrowdSec 只认 h/m/s，天要换算成小时"""
    text = (text or "").strip().lower()
    if text not in DURATIONS:
        raise FirewallError(f"不支持的时长: {text}")
    unit, value = text[-1], int(text[:-1])
    if unit == "d":
        return timedelta(days=value), f"{value * 24}h"
    if unit == "h":
        return timedelta(hours=value), text
    return timedelta(minutes=value), text


def _validate_target(value, protected):
    """返回 (规范化字符串, scope)。scope 决定 CrowdSec 按单 IP 还是网段匹配"""
    value = (value or "").strip()
    if not value:
        raise FirewallError("请填写 IP")
    try:
        net = ipaddress.ip_network(value, strict=False)
    except ValueError:
        raise FirewallError(f"不是合法的 IP 或网段: {value}") from None

    for cidr in protected:
        try:
            guard = ipaddress.ip_network(cidr, strict=False)
        except ValueError:
            continue
        if net.version == guard.version and net.subnet_of(guard):
            raise FirewallError(
                f"{value} 属于受保护网段 {cidr}，封了会把自己关在门外，已拒绝")

    scope = "Ip" if net.prefixlen == net.max_prefixlen else "Range"
    return (str(net.network_address) if scope == "Ip" else str(net)), scope


class LapiClient:
    """LAPI machine 会话。JWT 有效期约 1 小时，过期自动重登"""

    def __init__(self, cfg):
        ccfg = (cfg or {}).get("crowdsec") or {}
        self.url = ccfg.get("lapi_url", "http://127.0.0.1:8080").rstrip("/")
        self.cred_path = ccfg.get("credentials_file", DEFAULT_CREDENTIALS)
        extra = ccfg.get("protected_networks") or []
        self.protected = PROTECTED_NETS + [str(x) for x in extra]
        self._token = None
        self._expire = 0.0
        self._lock = threading.Lock()

    # ---------- 会话 ----------

    def _credentials(self):
        try:
            with open(self.cred_path, encoding="utf-8") as fp:
                data = yaml.safe_load(fp) or {}
        except FileNotFoundError:
            raise FirewallError(
                f"读不到 LAPI 凭据 {self.cred_path}。"
                "compose 里需要只读挂载该文件，容器才能执行封禁") from None
        except PermissionError:
            raise FirewallError(f"无权读取 {self.cred_path}") from None
        except IsADirectoryError:
            # 宿主机上该文件不存在时，docker 会把挂载点建成空目录
            raise FirewallError(
                f"{self.cred_path} 是个目录，说明宿主机上这个文件不存在，"
                "docker 把挂载点建成了空目录。确认 CrowdSec 的凭据文件真实路径") from None
        except (OSError, yaml.YAMLError) as exc:
            raise FirewallError(f"解析 {self.cred_path} 失败: {exc}") from None

        login, password = data.get("login"), data.get("password")
        if not login or not password:
            raise FirewallError(f"{self.cred_path} 里没有 login/password")
        return login, password

    def _login(self):
        login, password = self._credentials()
        try:
            resp = httpx.post(f"{self.url}/v1/watchers/login",
                              json={"machine_id": login, "password": password,
                                    "scenarios": []},
                              timeout=10)
        except httpx.RequestError as exc:
            raise FirewallError(f"连不上 LAPI {self.url}: {exc}") from None
        if resp.status_code != 200:
            raise FirewallError(
                f"LAPI 登录失败 HTTP {resp.status_code}: {resp.text[:120]}")
        token = (resp.json() or {}).get("token")
        if not token:
            raise FirewallError("LAPI 未返回 token")
        self._token = token
        self._expire = time.time() + 3000     # 留 10 分钟余量

    def _headers(self):
        with self._lock:
            if not self._token or time.time() >= self._expire:
                self._login()
            return {"Authorization": f"Bearer {self._token}"}

    def _request(self, method, path, **kw):
        """401 视为 token 失效，重登一次再试"""
        for attempt in (1, 2):
            try:
                resp = httpx.request(method, f"{self.url}{path}",
                                     headers=self._headers(), timeout=15, **kw)
            except httpx.RequestError as exc:
                raise FirewallError(f"请求 LAPI 失败: {exc}") from None
            if resp.status_code == 401 and attempt == 1:
                with self._lock:
                    self._token = None
                continue
            return resp
        return resp

    # ---------- 操作 ----------

    def ban(self, value, duration="4h", reason=""):
        target, scope = _validate_target(value, self.protected)
        delta, api_duration = _parse_duration(duration)

        now = datetime.now(timezone.utc)
        stamp = now.strftime("%Y-%m-%dT%H:%M:%S.000Z")
        note = (reason or "").strip()[:200] or "面板手动封禁"

        payload = [{
            "scenario": SCENARIO,
            "scenario_hash": "",
            "scenario_version": "",
            "message": f"手动封禁 {target} {DURATIONS[duration]} — {note}",
            "events": [],
            "events_count": 1,
            "start_at": stamp,
            "stop_at": stamp,
            "capacity": 0,
            "leakspeed": "0",
            "simulated": False,
            "labels": None,
            "source": {"scope": scope, "value": target},
            "decisions": [{
                "duration": api_duration,
                "origin": ORIGIN,
                "scenario": SCENARIO,
                "scope": scope,
                "type": "ban",
                "value": target,
            }],
        }]

        resp = self._request("POST", "/v1/alerts", json=payload)
        if resp.status_code not in (200, 201):
            raise FirewallError(
                f"封禁失败 HTTP {resp.status_code}: {resp.text[:160]}")
        return {
            "ok": True,
            "ip": target,
            "scope": scope,
            "duration": duration,
            "duration_label": DURATIONS[duration],
            "until": (now + delta).isoformat(timespec="seconds"),
            "reason": note,
        }

    def unban(self, value):
        target = (value or "").strip()
        if not target:
            raise FirewallError("请填写要解封的 IP")
        try:
            ipaddress.ip_network(target, strict=False)
        except ValueError:
            raise FirewallError(f"不是合法的 IP 或网段: {target}") from None

        # ip= 只匹配单 IP，range= 匹配网段，两个都试一遍
        removed = 0
        errors = []
        for param in ("ip", "range"):
            resp = self._request("DELETE", "/v1/decisions",
                                 params={param: target})
            if resp.status_code == 200:
                body = resp.json() or {}
                try:
                    removed += int(body.get("nbDeleted") or 0)
                except (TypeError, ValueError):
                    pass
            elif resp.status_code not in (404, 422):
                errors.append(f"HTTP {resp.status_code}: {resp.text[:100]}")

        if removed == 0:
            if errors:
                raise FirewallError("解封失败 " + "; ".join(errors))
            raise FirewallError(
                f"{target} 不在本地封禁列表里。"
                "若它来自社区黑名单(origin 为 lists/CAPI)，删了也会被同步回来，"
                "需要改用白名单处理")
        return {"ok": True, "ip": target, "removed": removed}


class Whitelist:
    """面板层白名单。

    没有用 CrowdSec 原生的 whitelist：那是 parser 层的 yaml 配置，改完要
    reload crowdsec，而面板跑在容器里既没有配置目录的写权限，也没法重启
    宿主机上的 systemd 服务。

    换成"看门"式实现：每轮采集后比对封禁列表，白名单里的 IP 一出现就立刻
    调 LAPI 解封。代价是 IP 仍会被封一下（最多 30 秒，一个采集周期），
    换来的是不碰 CrowdSec 任何配置、即时生效、能从面板增删。

    社区黑名单(kind=community)也能这样捞回来——CAPI 同步进来多少次就解多少次。
    """

    def __init__(self, cfg, history, lapi):
        self.history = history
        self.lapi = lapi
        self.enabled = bool(((cfg or {}).get("firewall") or {})
                            .get("whitelist_enabled", True))

    def entries(self):
        return self.history.whitelist()

    def add(self, ip, note=""):
        target = (ip or "").strip()
        if not target:
            raise FirewallError("请填写 IP")
        try:
            net = ipaddress.ip_network(target, strict=False)
        except ValueError:
            raise FirewallError(f"不是合法的 IP 或网段: {target}") from None
        normalized = (str(net.network_address)
                      if net.prefixlen == net.max_prefixlen else str(net))
        self.history.whitelist_add(normalized, (note or "").strip()[:200])
        # 加进来时如果正被封着，立刻放出来，不用等下一轮
        freed = 0
        try:
            freed = self.lapi.unban(normalized).get("removed", 0)
        except FirewallError:
            pass
        return {"ok": True, "ip": normalized, "released": freed}

    def remove(self, ip):
        removed = self.history.whitelist_remove((ip or "").strip())
        if not removed:
            raise FirewallError(f"{ip} 不在白名单里")
        return {"ok": True, "ip": ip}

    def _match(self, ip, patterns):
        try:
            addr = ipaddress.ip_address(ip)
        except ValueError:
            return None
        for text, net in patterns:
            if addr.version == net.version and addr in net:
                return text
        return None

    def enforce(self, decisions):
        """比对封禁列表，命中白名单的立刻解封。返回本轮放行的 IP"""
        if not self.enabled or not decisions:
            return []
        entries = self.entries()
        if not entries:
            return []
        patterns = []
        for e in entries:
            try:
                patterns.append((e["ip"], ipaddress.ip_network(e["ip"], strict=False)))
            except ValueError:
                continue

        released = []
        seen = set()
        for d in decisions:
            ip = d.get("ip")
            if not ip or ip in seen:
                continue
            seen.add(ip)
            hit = self._match(ip, patterns)
            if not hit:
                continue
            try:
                self.lapi.unban(ip)
            except FirewallError:
                continue
            self.history.whitelist_hit(hit)
            released.append({"ip": ip, "rule": hit,
                             "origin": d.get("origin"), "kind": d.get("kind")})
        return released
