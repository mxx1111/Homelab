"""演示模式：所有采集器改用仿真数据，完全不读宿主机。

存在的理由有两个，安全只是其中之一：

  1. 公开的面板实例会把宿主机的端口清单、容器名、服务拓扑、访客 IP 全暴露出去，
     那正是攻击者最想要的侦察报告。演示模式下容器不挂任何宿主机路径，
     即使被攻破，里面也只有假数据。
  2. 真实数据其实演示效果很差。一台健康的机器没有攻击、没有告警、硬盘全绿、
     曲线是直线——看不出这面板有什么用。仿真数据可以刻意编排出
     "正在被爆破、两块盘老化、一个服务刚掉线、容量 30 天后写满"的场景，
     把功能一次讲完。

写操作走内存沙盒：点封禁真的会多出一条记录，重启容器真的会看到状态变化，
但都只改这里的内存状态，且每小时重置一次，防止被玩坏。

启用方式：环境变量 HOMELAB_DEMO=1，或 config.yaml 里 demo: true
"""
import ipaddress
import math
import os
import random
import threading
import time

from .asn_names import pretty_as

RESET_SECONDS = 3600

# 固定种子：每次启动生成同一套"世界"，截图和文档才对得上。
# 随时间变化的部分（CPU 波动、连接数）另用时间函数，不吃这个种子
_rng = random.Random(20260807)

_START = time.time()
_lock = threading.RLock()


def _wave(period, lo, hi, phase=0.0, jitter=0.0):
    """按真实时间走的正弦波，让曲线看着像活的而不是死数据"""
    t = time.time()
    base = (math.sin(t / period * 2 * math.pi + phase) + 1) / 2
    val = lo + base * (hi - lo)
    if jitter:
        val += random.uniform(-jitter, jitter)
    return max(lo, min(hi, val))


# ---------------- 沙盒状态 ----------------

class Sandbox:
    """写操作落在这里。每小时重置，回到初始剧本"""

    def __init__(self):
        self.reset()

    def reset(self):
        with _lock:
            self.extra_bans = []          # 访客封的 IP
            self.unbanned = set()         # 访客解封的 IP
            self.container_state = {}     # name -> running?
            self.reset_at = time.time()

    def maybe_reset(self):
        if time.time() - self.reset_at > RESET_SECONDS:
            self.reset()
            return True
        return False


SANDBOX = Sandbox()


# ---------------- 剧本里的固定角色 ----------------

ATTACKERS = [
    ("45.132.193.87", "RU", "Chang Way Technologies", "俄罗斯", 412,
     ["crowdsecurity/ssh-bf", "crowdsecurity/ssh-slow-bf"]),
    ("103.149.28.51", "VN", "Viettel Group", "越南", 287,
     ["crowdsecurity/http-probing", "crowdsecurity/http-sensitive-files"]),
    ("185.243.96.114", "NL", "Alviva Holding Limited", "荷兰", 196,
     ["crowdsecurity/http-crawl-non_statics"]),
    ("222.186.30.76", "CN", "China Unicom Jiangsu Province Network", "中国", 154,
     ["crowdsecurity/ssh-bf"]),
    ("92.63.197.153", "RU", "Petersburg Internet Network", "俄罗斯", 98,
     ["crowdsecurity/http-admin-interface-probing"]),
    ("167.94.138.20", "US", "Censys, Inc.", "美国", 61,
     ["crowdsecurity/http-probing"]),
    ("20.65.193.42", "US", "Microsoft Corporation", "美国", 44,
     ["crowdsecurity/http-cve-2021-41773"]),
    ("139.59.42.118", "IN", "DigitalOcean, LLC", "印度", 33,
     ["crowdsecurity/ssh-bf"]),
]

# 演示地图使用的固定 GeoLite2 风格坐标（纬度, 经度）。真实部署直接读取
# CrowdSec alerts.source_latitude/source_longitude，不走这里。
ATTACKER_GEO = {
    "45.132.193.87": (59.93, 30.31),
    "103.149.28.51": (21.03, 105.85),
    "185.243.96.114": (52.37, 4.90),
    "222.186.30.76": (32.06, 118.80),
    "92.63.197.153": (55.75, 37.62),
    "167.94.138.20": (42.28, -83.74),
    "20.65.193.42": (37.43, -78.66),
    "139.59.42.118": (12.97, 77.59),
}

ATTACKER_PLACE = {
    "45.132.193.87": "俄罗斯圣彼得堡",
    "103.149.28.51": "越南河内市",
    "185.243.96.114": "荷兰阿姆斯特丹",
    "222.186.30.76": "江苏省南京市",
    "92.63.197.153": "俄罗斯莫斯科",
    "167.94.138.20": "美国密歇根州安娜堡",
    "20.65.193.42": "美国弗吉尼亚州",
    "139.59.42.118": "印度卡纳塔克邦班加罗尔",
}

CONTAINERS = [
    ("nginx-proxy", True, 0.8, 42),
    ("nextcloud", True, 3.2, 512),
    ("postgres", True, 1.4, 386),
    ("redis", True, 0.3, 28),
    ("jellyfin", True, 12.6, 724),
    ("qbittorrent", True, 2.1, 168),
    ("vaultwarden", True, 0.2, 34),
    ("homelab-dashboard", True, 0.6, 58),
    ("photoprism", True, 1.9, 445),
    ("watchtower", True, 0.1, 12),
    ("backup-runner", False, 0.0, 0),
]

SERVICES = [
    ("NAS 面板", "https://127.0.0.1:5001/", True, 200, 18.4),
    ("Nextcloud", "http://127.0.0.1:8080/", True, 302, 44.1),
    ("Jellyfin", "http://127.0.0.1:8096/", True, 302, 31.7),
    ("Vaultwarden", "http://127.0.0.1:8222/", True, 200, 12.3),
    ("Grafana", "http://127.0.0.1:3000/api/health", True, 200, 9.8),
    # 剧本里刻意留一个挂掉的，好让"服务健康"卡片有内容可展示
    ("PhotoPrism", "http://127.0.0.1:2342/", False, 0, None),
]

PORTS = [
    (22, "tcp", ["0.0.0.0"], "sshd", None, True, False, "lan", "SSH"),
    (80, "tcp", ["0.0.0.0"], "nginx-proxy", "nginx-proxy", True, True, "public", "HTTP 入口"),
    (443, "tcp", ["0.0.0.0"], "nginx-proxy", "nginx-proxy", True, True, "public", "HTTPS 入口"),
    (445, "tcp", ["0.0.0.0"], "smbd", None, True, False, "lan", "SMB"),
    (3000, "tcp", ["127.0.0.1"], "grafana", "grafana", False, False, "safe", "Grafana"),
    (5432, "tcp", ["127.0.0.1"], "postgres", "postgres", False, False, "safe", "PostgreSQL"),
    (6379, "tcp", ["127.0.0.1"], "redis", "redis", False, False, "safe", "Redis"),
    (8080, "tcp", ["0.0.0.0"], "nextcloud", "nextcloud", True, False, "lan", "Nextcloud"),
    (8096, "tcp", ["0.0.0.0"], "jellyfin", "jellyfin", True, False, "lan", "Jellyfin"),
    (8222, "tcp", ["127.0.0.1"], "vaultwarden", "vaultwarden", False, False, "safe", "Vaultwarden"),
    (8770, "tcp", ["0.0.0.0"], "homelab-dashboard", "homelab-dashboard", True, False, "lan", "Homelab 面板"),
    (9090, "tcp", ["127.0.0.1"], "prometheus", None, False, False, "safe", "Prometheus"),
]

PEERS = [
    ("203.0.113.45", 443, True, 6, "已建立", "live", "CN", "China Telecom Guangdong", "电信 广东"),
    ("198.51.100.22", 443, True, 3, "已建立", "live", "US", "Cloudflare, Inc.", "Cloudflare"),
    ("45.132.193.87", 22, True, 14, "握手中", "odd", "RU", "Chang Way Technologies", "Chang Way Technologies"),
    ("192.0.2.180", 8096, True, 2, "已建立", "live", "JP", "Amazon.com, Inc.", "AWS"),
    ("203.0.113.91", 80, True, 8, "等待回收", "idle", "CN", "China Unicom Beijing", "联通 北京"),
    ("104.18.32.7", 443, False, 2, "已建立", "live", "CA", "Cloudflare, Inc.", "Cloudflare"),
    ("140.82.121.4", 443, False, 1, "已建立", "live", "US", "GitHub, Inc.", "GitHub"),
    ("208.67.222.222", 53, False, 1, "已建立", "live", "US", "Cisco OpenDNS", "Cisco OpenDNS"),
]

STATE_DESC = {
    "已建立": "连接活跃，正在收发数据",
    "等待回收": "连接已结束，系统按规范等约 60 秒再回收端口，防止残留数据包串到新连接上。完全正常",
    "握手中": "对方正在连入但握手没完成。大量堆积可能是 SYN 洪水或扫描",
}


# ---------------- 各采集器 ----------------

def host(cfg):
    cpu = _wave(420, 4, 34, jitter=2.5)
    mem_total = 32 * 1024 ** 3
    mem_pct = _wave(900, 38, 52, phase=1.2, jitter=1.0)
    used = int(mem_total * mem_pct / 100)
    load = round(cpu / 100 * 8 * 0.7, 2)
    return {
        "ok": True,
        "cpu_percent": round(cpu, 1),
        "cpu_cores": 8,
        "memory": {"total": mem_total, "available": mem_total - used,
                   "used": used, "percent": round(mem_pct, 1)},
        "load": [load, round(load * 0.92, 2), round(load * 0.85, 2)],
        "uptime_seconds": int(time.time() - 1751000000),
        "temperature": round(_wave(1500, 41, 55, jitter=1.5), 1),
        "ts": time.time(),
    }


def network(cfg):
    return {
        "ok": True, "interface": "eth0",
        "rx_bytes_per_sec": round(_wave(300, 12_000, 2_400_000, jitter=40_000), 1),
        "tx_bytes_per_sec": round(_wave(300, 8_000, 900_000, phase=2.1, jitter=20_000), 1),
        "rx_total": 8_842_119_004_112, "tx_total": 1_204_558_930_221,
        "public_ip": "203.0.113.10",     # RFC 5737 文档专用段，不是真实地址
        "ts": time.time(),
    }


def storage(cfg):
    # 数据盘刻意设成缓慢增长，让容量预测能给出结论
    grow = (time.time() - _START) / 86400 * 0.4
    vols = [
        ("系统盘", "/hostfs", 480, 31.2 + grow * 0.1),
        ("数据盘", "/hostfs/mnt/data", 7300, 68.4 + grow),
        ("备份盘", "/hostfs/mnt/backup", 3600, 82.7 + grow * 0.5),
    ]
    out = []
    for label, path, gb, pct in vols:
        pct = min(97.0, pct)
        total = gb * 1024 ** 3
        used = int(total * pct / 100)
        level = "crit" if pct >= 90 else "warn" if pct >= 80 else "ok"
        out.append({"ok": True, "path": path, "label": label, "total": total,
                    "used": used, "free": total - used,
                    "percent": round(pct, 1), "level": level})
    worst = max(out, key=lambda v: v["percent"])
    return {"ok": True, "volumes": out, "level": worst["level"]}


def services(cfg):
    items = []
    for name, url, ok, code, lat in SERVICES:
        items.append({"name": name, "url": url, "ok": ok, "status_code": code,
                      "latency_ms": round(lat + random.uniform(-3, 6), 1) if lat else None})
    up = sum(1 for i in items if i["ok"])
    return {"ok": True, "total": len(items), "up": up,
            "down": len(items) - up, "items": items}


def containers(cfg):
    items = []
    running = 0
    for name, default_run, cpu, mem_mb in CONTAINERS:
        run = SANDBOX.container_state.get(name, default_run)
        running += 1 if run else 0
        items.append({
            "name": name,
            "status": "Up 6 days" if run else "Exited (0) 2 hours ago",
            "running": run,
            "cpu_percent": round(cpu * (0.6 + random.random() * 0.8), 2) if run else 0.0,
            "memory_bytes": float(mem_mb * 1024 ** 2) if run else 0.0,
        })
    return {"ok": True, "total": len(items), "running": running,
            "stopped": len(items) - running, "items": items}


def _bans():
    """封禁列表 = 剧本里的固定条目 + 访客在沙盒里封的 - 访客解封的"""
    out = []
    for ip, cc, asn, _cn, _n, scen in ATTACKERS[:5]:
        out.append({"ip": ip, "reason": scen[0], "action": "ban", "origin": "crowdsec",
                    "until": None, "expires_in": 3600 * 3, "scope": "Ip",
                    "kind": "detected", "country": cc, "as_name": asn,
                    "as_label": None})
    out.append({"ip": "198.18.44.9", "reason": "manual 'ban'", "action": "ban",
                "origin": "cscli", "until": None, "expires_in": 3600 * 20,
                "scope": "Ip", "kind": "manual", "country": "US",
                "as_name": "Example Hosting", "as_label": "Example Hosting"})
    for b in SANDBOX.extra_bans:
        out.append(dict(b))
    for i, ip in enumerate(("62.204.41.%d" % (10 + i) for i in range(24))):
        out.append({"ip": ip, "reason": "crowdsecurity/community-blocklist",
                    "action": "ban", "origin": "lists", "until": None,
                    "expires_in": 3600 * 24 * 6, "scope": "Ip", "kind": "community",
                    "country": "RU", "as_name": "Community blocklist", "as_label": None})
    return [d for d in out if d["ip"] not in SANDBOX.unbanned]


def crowdsec(cfg):
    decisions = _bans()
    now = time.time()
    alerts = []
    aid = 90000
    for ip, cc, asn, _cn, count, scen in ATTACKERS:
        for k, s in enumerate(scen):
            aid += 1
            age = 0.4 + k * 1.7 + ATTACKERS.index((ip, cc, asn, _cn, count, scen)) * 2.2
            alerts.append({"id": aid, "created_at": None, "scenario": s,
                           "ip": ip, "country": cc, "as_name": asn,
                           "as_label": pretty_as(asn),
                           "location_name": ATTACKER_PLACE[ip],
                           "latitude": ATTACKER_GEO[ip][0],
                           "longitude": ATTACKER_GEO[ip][1],
                           "events_count": max(3, count // (k + 2)),
                           "age_hours": round(age, 2)})
    alerts.sort(key=lambda a: a["age_hours"])

    counts = {"manual": sum(1 for d in decisions if d["kind"] == "manual"),
              "community": 15284,
              "detected": sum(1 for d in decisions if d["kind"] == "detected")}
    top = [{"ip": ip, "count": n, "country": cc, "as_name": asn, "scenarios": scen}
           for ip, cc, asn, _cn, n, scen in ATTACKERS]
    by_country = {}
    for ip, cc, _asn, _cn, n, _s in ATTACKERS:
        slot = by_country.setdefault(cc, {"code": cc, "count": 0, "ips": 0})
        slot["count"] += n
        slot["ips"] += 1
    by_asn = {}
    for ip, cc, asn, _cn, n, _s in ATTACKERS:
        slot = by_asn.setdefault(asn, {"as_name": asn, "as_label": pretty_as(asn),
                                       "count": 0, "country": cc, "ips": 0})
        slot["count"] += n
        slot["ips"] += 1
    return {
        "ok": True, "decisions": decisions, "alerts": alerts[:40],
        "active_bans": counts["manual"] + counts["community"] + counts["detected"],
        "alerts_24h": sum(1 for a in alerts if a["age_hours"] <= 24),
        "ban_counts": counts, "listed": len(decisions), "truncated": True,
        "decisions_source": "demo", "alerts_source": "demo",
        "top_sources": top,
        "by_country": sorted(by_country.values(), key=lambda x: -x["count"]),
        "by_asn": sorted(by_asn.values(), key=lambda x: -x["count"])[:8],
    }


def ports(cfg):
    items = []
    for port, proto, addrs, owner, ctr, in_guard, public, level, note in PORTS:
        items.append({"port": port, "proto": proto, "addrs": addrs,
                      "local_only": addrs == ["127.0.0.1"], "owner": owner,
                      "container": ctr, "in_guard": in_guard, "public": public,
                      "level": level, "note": note})
    counts = {"public": sum(1 for i in items if i["level"] == "public"),
              "lan": sum(1 for i in items if i["level"] == "lan"),
              "safe": sum(1 for i in items if i["level"] == "safe")}
    return {"ok": True, "items": items, "counts": counts, "total": len(items),
            "guard_found": True, "guard_ports": [22, 80, 443, 445, 8080, 8096, 8770],
            "declared_public": [80, 443]}


def connections(cfg):
    items = []
    for ip, port, inbound, base, state, tone, cc, asn, label in PEERS:
        count = max(1, base + int(_wave(240, -2, 3, phase=port)))
        items.append({
            "ip": ip, "port": port, "inbound": inbound, "count": count,
            "states": {state: count}, "established": count if state == "已建立" else 0,
            "private": False, "service": next((p[8] for p in PORTS if p[0] == port), None),
            "state": state, "state_tone": tone, "state_desc": STATE_DESC.get(state, ""),
            "state_mix": "", "country": cc, "as_name": asn, "as_label": label,
        })
    by_port = {}
    for it in items:
        if not it["inbound"]:
            continue
        slot = by_port.setdefault(it["port"], {"port": it["port"],
                                               "service": it["service"],
                                               "conns": 0, "peers": 0})
        slot["conns"] += it["count"]
        slot["peers"] += 1
    return {"ok": True, "items": items, "total": sum(i["count"] for i in items),
            "peers": len(items),
            "external": len(items),
            "inbound": sum(i["count"] for i in items if i["inbound"]),
            "outbound": sum(i["count"] for i in items if not i["inbound"]),
            "by_port": sorted(by_port.values(), key=lambda x: -x["conns"]),
            "show_private": False, "truncated": False,
            "odd": sum(1 for i in items if i["state_tone"] == "odd")}


def certs(cfg):
    data = [("demo.example.com:443", 68, "ok"),
            ("cloud.example.com:443", 21, "warn"),
            ("git.example.com:443", 5, "crit")]
    items = []
    for target, days, level in data:
        items.append({"target": target, "ok": True,
                      "subject": target.split(":")[0], "issuer": "R11",
                      "expires_at": time.strftime(
                          "%Y-%m-%d", time.localtime(time.time() + days * 86400)),
                      "days_left": days, "chain_valid": True, "level": level})
    return {"ok": True, "items": items, "level": "crit"}


def disks(cfg):
    items = [
        {"model": "WDC WD40EFRX-68N32N0", "serial": None, "hours": 41230,
         "rotation": "5400 rpm", "temp": 38, "health": "PASSED",
         "attrs": {"Reallocated_Sector_Ct": 0}, "issues": ["已通电 4 年"],
         "device": "sda", "level": "warn", "years": 4.7},
        {"model": "ST4000VN008-2DR166", "serial": None, "hours": 38940,
         "rotation": "5900 rpm", "temp": 41, "health": "PASSED",
         "attrs": {"Reallocated_Sector_Ct": 8, "Current_Pending_Sector": 2},
         "issues": ["重映射扇区 8", "待处理扇区 2", "已通电 4 年"],
         "device": "sdb", "level": "crit", "years": 4.4},
        {"model": "Samsung SSD 980 PRO 1TB", "serial": None, "hours": 12410,
         "rotation": "SSD", "temp": 44, "health": "PASSED",
         "attrs": {"Percentage_Used": 6}, "issues": [],
         "device": "nvme0n1", "level": "ok", "years": 1.4},
    ]
    return {"ok": True, "items": items, "unavailable": [], "total": 3,
            "failing": 1, "aging": 1,
            "raids": {"md0": {"level": "raid1", "members": ["sda1"],
                              "redundant": False, "degraded": False}},
            "no_redundancy": ["md0"], "warn_hours": 35000}


def engine(cfg):
    sources = [
        {"path": "/var/log/nginx/access.log", "name": "nginx", "kind": "file",
         "lines": 184203, "parse_ok": 184203, "parse_ko": 0,
         "parse_rate": 100.0, "wasted": False},
        {"path": "/var/log/auth.log", "name": "sshd", "kind": "file",
         "lines": 8422, "parse_ok": 8422, "parse_ko": 0,
         "parse_rate": 100.0, "wasted": False},
        {"path": "/var/log/samba/log.smbd", "name": "smb", "kind": "file",
         "lines": 1204, "parse_ok": 0, "parse_ko": 1204,
         "parse_rate": 0.0, "wasted": True},
    ]
    scenarios = [
        {"name": "crowdsecurity/ssh-bf", "short": "ssh-bf", "poured": 8422, "overflowed": 31},
        {"name": "crowdsecurity/http-probing", "short": "http-probing", "poured": 42118, "overflowed": 24},
        {"name": "crowdsecurity/http-crawl-non_statics", "short": "http-crawl-non_statics",
         "poured": 96044, "overflowed": 12},
        {"name": "crowdsecurity/http-sensitive-files", "short": "http-sensitive-files",
         "poured": 3308, "overflowed": 7},
    ]
    return {"ok": True, "sources": sources, "sources_total": 3,
            "idle_sources": [], "wasted_sources": ["smb"], "effective_sources": 2,
            "scenarios": scenarios, "scenarios_triggered": 4,
            "poured_total": 149892, "overflowed_total": 74,
            "parse_ok": 192625, "parse_ko": 1204, "parse_rate": 99.4,
            "whitelist_hits": 1882, "active_buckets": 3, "alerts_gauge": 74,
            "lapi": [{"who": "cs-firewall-bouncer", "route": "/v1/decisions/stream",
                      "method": "GET", "count": 8640},
                     {"who": "localhost", "route": "/v1/alerts", "method": "POST",
                      "count": 74}]}


def remote(cfg):
    return {"ok": True, "items": []}


# 演示站要展示"一个面板管多台机器"这件事，所以得有节点。但演示站本身
# 一台机器都连不到（internal 网络，容器出不去），全部编出来
DEMO_NODES = [
    {"name": "边缘节点", "hostname": "edge-01", "cores": 4, "mem_gb": 8,
     "base_load": 0.35, "disks": [("/", 220, 0.61), ("/data", 900, 0.44)],
     "containers": (12, 15), "ports": (14, 31), "bans": 18220, "latency": 42},
    {"name": "海外节点", "hostname": "vps-sg", "cores": 2, "mem_gb": 4,
     "base_load": 0.22, "disks": [("/", 80, 0.37)],
     "containers": (6, 6), "ports": (9, 12), "bans": 18220, "latency": 186},
]


def nodes(cfg):
    items = []
    for i, spec in enumerate(DEMO_NODES):
        # 用 _wave 而不是纯随机：随机值每次刷新都跳，看着像坏了；
        # 正弦波配上不同相位，两台机器的曲线各走各的，像真的
        phase = i * 2.1
        load1 = round(_wave(900, spec["base_load"] * 0.6, spec["base_load"] * 1.5,
                            phase, 0.04) * spec["cores"], 2)
        total_mem = spec["mem_gb"] * 1024 ** 3
        used_ratio = _wave(1500, 0.38, 0.68, phase + 0.7, 0.02)
        run, tot = spec["containers"]
        exposed, loopback = spec["ports"]
        items.append({
            "name": spec["name"], "ok": True,
            "latency_ms": round(_wave(300, spec["latency"] * 0.85,
                                      spec["latency"] * 1.2, phase)),
            "hostname": spec["hostname"], "os": "Debian GNU/Linux 12 (bookworm)",
            "collected_at": int(time.time()), "clock_skew_seconds": 0,
            "cores": spec["cores"],
            "load": [load1, round(load1 * 0.95, 2), round(load1 * 0.9, 2)],
            "load_percent": round(load1 / spec["cores"] * 100, 1),
            "uptime_seconds": 86400 * (37 + i * 24),
            "temp_c": round(_wave(1800, 39 + i * 6, 48 + i * 6, phase, 0.3), 1),
            "memory": {"total": total_mem, "used": int(total_mem * used_ratio),
                       "available": int(total_mem * (1 - used_ratio)),
                       "percent": round(used_ratio * 100, 1)},
            "disks": [{"device": f"/dev/sd{chr(97 + j)}1", "fs": "ext4",
                       "mount": m, "total": gb * 1024 ** 3,
                       "used": int(gb * 1024 ** 3 * pct),
                       "available": int(gb * 1024 ** 3 * (1 - pct)),
                       "percent": round(pct * 100, 1)}
                      for j, (m, gb, pct) in enumerate(spec["disks"])],
            "containers": {"total": tot, "running": run, "stopped": tot - run,
                           "items": [{"name": f"svc-{n}", "status": "Up 3 days",
                                      "image": f"svc-{n}:latest"}
                                     for n in range(1, run + 1)]},
            "ports": {"exposed": exposed, "loopback": loopback,
                      "items": [{"port": p, "addr": "0.0.0.0", "proto": "tcp",
                                 "proc": n} for p, n in
                                [(22, "sshd"), (80, "nginx"), (443, "nginx")]]},
            "crowdsec": {"ipset_entries": spec["bans"] + i,
                         "blocked_packets": 4280 + i * 1730,
                         "blocked_bytes": 2380000 + i * 940000,
                         "agent": "active", "bouncer": "active"},
            "appsec": ({"adapter": "onepanel", "available": True,
                        "site_count": 12, "request_rows": 1364,
                        "attack_rows": 0, "blocked_rows": 0,
                        "capabilities": {"waf": True, "rate_limit": True,
                                         "bot": True, "geo": False,
                                         "allow_deny": True}}
                       if i == 0 else {"available": False}),
            "services": {"ssh": "active", "docker": "active",
                         "crowdsec": "active",
                         "crowdsec-firewall-bouncer": "active"},
        })
    return {"ok": True, "items": items, "configured": len(items),
            "online": len(items), "offline": 0}


REGISTRY = {
    "host": host, "network": network, "containers": containers,
    "services": services, "crowdsec": crowdsec, "storage": storage,
    "certs": certs, "remote": remote, "nodes": nodes, "ports": ports,
    "connections": connections, "engine": engine, "disks": disks,
}


def enabled(cfg=None):
    if os.environ.get("HOMELAB_DEMO", "").strip().lower() in ("1", "true", "yes"):
        return True
    return bool((cfg or {}).get("demo"))


# ---------------- 写操作的沙盒实现 ----------------

def ban(ip, reason=None, duration=None):
    with _lock:
        SANDBOX.unbanned.discard(ip)
        if any(b["ip"] == ip for b in SANDBOX.extra_bans):
            return
        SANDBOX.extra_bans.append({
            "ip": ip, "reason": reason or "manual 'ban' from 'demo'",
            "action": "ban", "origin": "cscli", "until": None,
            "expires_in": 14400, "scope": "Ip", "kind": "manual",
            "country": None, "as_name": None, "as_label": None})


def unban(ip):
    with _lock:
        SANDBOX.extra_bans = [b for b in SANDBOX.extra_bans if b["ip"] != ip]
        SANDBOX.unbanned.add(ip)


def container_action(name, action):
    known = {c[0] for c in CONTAINERS}
    if name not in known:
        raise KeyError(name)
    with _lock:
        SANDBOX.container_state[name] = action in ("start", "restart", "unpause")


def container_logs(name, lines=200):
    stamp = time.strftime("%Y-%m-%d %H:%M:%S")
    return "\n".join([
        f"{stamp} [info] 演示模式：这不是真实容器日志",
        f"{stamp} [info] {name} started, pid 1",
        f"{stamp} [info] listening on 0.0.0.0:8080",
        f"{stamp} [warn] 演示实例每小时重置一次沙盒状态",
    ])


def snapshots():
    return {"ok": True, "mounts": [], "items": [],
            "note": "演示模式不扫描真实快照"}


# ---------------- 历史数据播种 ----------------

def seed_history(history):
    """往历史库灌入过去 7 天的采样，让趋势图和容量预测一打开就有内容。

    真实实例要跑满一天才能看到曲线，演示实例等不起。只在库为空时执行一次，
    之后由正常采集接着往下写，曲线会自然延续。
    """
    if not getattr(history, "_ready", False):
        return 0
    try:
        with history._connect() as conn:
            existing = conn.execute("SELECT COUNT(*) FROM metrics").fetchone()[0]
            if existing > 0:
                return 0

            now = int(time.time())
            step = 300                       # 5 分钟一个点
            span = 7 * 86400
            rows = []
            for offset in range(span, 0, -step):
                ts = now - offset
                age_days = offset / 86400
                phase = ts / 3600.0
                # 白天负载高、夜里低，叠一点噪声，看着像真的
                daily = (math.sin(phase / 24 * 2 * math.pi - 1.6) + 1) / 2
                rows += [
                    (ts, "cpu", round(5 + daily * 26 + _rng.uniform(-2, 3), 2)),
                    (ts, "mem", round(41 + daily * 9 + _rng.uniform(-1, 1), 2)),
                    (ts, "load1", round(0.2 + daily * 1.6 + _rng.uniform(-.1, .2), 2)),
                    (ts, "net_rx", round(20000 + daily * 1_800_000 + _rng.uniform(0, 90000), 1)),
                    (ts, "net_tx", round(9000 + daily * 620_000 + _rng.uniform(0, 40000), 1)),
                    (ts, "vol:系统盘", round(31.2 - age_days * 0.01, 2)),
                    # 数据盘稳定增长，让"约 X 天写满"算得出来
                    (ts, "vol:数据盘", round(68.4 - age_days * 0.42, 2)),
                    (ts, "vol:备份盘", round(82.7 - age_days * 0.2, 2)),
                    (ts, "bans", 15200 + int((7 - age_days) * 12) + _rng.randint(0, 6)),
                    (ts, "temp", round(44 + daily * 9 + _rng.uniform(-1, 1), 1)),
                ]
            conn.executemany(
                "INSERT INTO metrics(ts,metric,value) VALUES(?,?,?)", rows)

            events = [
                (now - 1800, "service", "warn", "service:PhotoPrism",
                 "服务不可达: PhotoPrism", "连接被拒绝 http://127.0.0.1:2342/"),
                (now - 5400, "ban", "warn", "ban:45.132.193.87",
                 "新增封禁 45.132.193.87", "crowdsecurity/ssh-bf 俄罗斯"),
                (now - 9000, "disk", "crit", "disk:sdb",
                 "硬盘 sdb 出现坏道", "重映射扇区 8、待处理扇区 2，建议尽快更换"),
                (now - 21600, "cert", "warn", "cert:git.example.com",
                 "证书 5 天后到期", "git.example.com:443"),
                (now - 43200, "storage", "warn", "storage:备份盘",
                 "备份盘 使用率 82.7%", "超过告警阈值 80%"),
                (now - 86400, "ban", "info", "unban:203.0.113.7",
                 "解封 203.0.113.7", "移除 1 条决策"),
                (now - 90000, "service", "info", "service:Nextcloud",
                 "已恢复: Nextcloud", "HTTP 302，44ms"),
                (now - 172800, "collector", "warn", "collector:smb",
                 "日志源 smb 解析率 0%", "1204 行全部未解析，可能缺少 parser"),
            ]
            conn.executemany(
                "INSERT INTO events(ts,kind,level,key,title,detail)"
                " VALUES(?,?,?,?,?,?)", events)

            audit = [
                (now - 600, "203.0.113.45", "POST", "/api/firewall/ban", 200, 168.2,
                 "封禁 IP", "Mozilla/5.0"),
                (now - 3600, "203.0.113.45", "GET", "/", 200, 3.1, "打开面板", "Mozilla/5.0"),
                (now - 7200, "198.51.100.22", "POST", "/api/containers/jellyfin/restart",
                 200, 1240.5, "容器restart", "Mozilla/5.0"),
                (now - 10800, "198.51.100.22", "PUT", "/api/alerts/settings", 200, 14.8,
                 "改告警规则", "Mozilla/5.0"),
                (now - 14400, "192.0.2.99", "POST", "/api/firewall/ban", 403, 2.2,
                 "封禁 IP", "curl/8.4.0"),
                (now - 18000, "192.0.2.99", "POST", "/api/firewall/ban", 401, 1.9,
                 "封禁 IP", "curl/8.4.0"),
            ]
            conn.executemany(
                "INSERT INTO audit(ts,ip,method,path,status,ms,detail,ua)"
                " VALUES(?,?,?,?,?,?,?,?)", audit)
            conn.commit()
            return len(rows)
    except Exception:  # noqa: BLE001  播种失败不该拖垮启动
        return 0


def mask_ip(ip):
    """把访客 IP 掩掉后半段。演示站的审计页所有人可见，
    完整地址不该出现在那里。

    走 ipaddress 解析而不是切字符串：反代可能把 IPv4 传成
    ::ffff:1.2.3.4 这种映射形式，按冒号切会掩出一个毫无意义的结果。
    """
    raw = (ip or "").strip()
    if not raw or raw == "?":
        return "?"
    try:
        addr = ipaddress.ip_address(raw)
    except ValueError:
        return "?"
    if addr.version == 6 and addr.ipv4_mapped:
        addr = addr.ipv4_mapped
    if addr.version == 4:
        a, b, _, _ = str(addr).split(".")
        return f"{a}.{b}.x.x"
    groups = addr.exploded.split(":")
    return ":".join(groups[:2]) + "::x"


def search(query, limit=200):
    """演示模式的封禁搜索。真实实现直接查 CrowdSec 库，
    演示容器里没有那个库，改为在仿真数据里过滤"""
    q = (query or "").strip().lower()
    if not q:
        return []
    out = []
    for d in _bans():
        haystack = " ".join(str(d.get(k) or "") for k in
                            ("ip", "reason", "as_name", "as_label", "country", "origin"))
        if q in haystack.lower():
            out.append(d)
            if len(out) >= limit:
                break
    return out
