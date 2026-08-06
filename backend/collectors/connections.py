"""实时连接监控：此刻谁连着我。

封禁列表回答的是"谁被拦了"，这里回答"谁正连着"——排查可疑长连接时，
前者没用，后者才是要看的东西。

数据来自 /proc/net/{tcp,tcp6}，host 网络模式下就是宿主机的网络栈。
拿不到进程名（PID namespace 不共享），改用本地监听端口反查服务名。

GeoIP 走两级：先查 CrowdSec 库里已知的攻击者（免费且准），查不到再批量
问 ip-api.com（免费额度 45 次/分钟，结果缓存 24 小时）。缓存只在内存里，
重启后重新查——反正常连的就那几个 IP。
"""
import ipaddress
import re
import socket
import sqlite3
import subprocess
import threading
import time

import httpx

from ..asn_names import pretty_as

# 内核的 TCP 状态码。直接把 TIME_WAIT 这种缩写摆到界面上没人看得懂，
# 全部给中文名 + 一句人话解释，再按"要不要在意"分三档：
#   live 正在通信 / idle 收尾中，正常现象 / odd 值得看一眼
STATES = {
    "01": ("已建立", "live", "连接活跃，正在收发数据"),
    "02": ("连接中", "idle", "本机发出握手请求，等待对方响应"),
    "03": ("握手中", "odd", "对方正在连入但握手没完成。大量堆积可能是 SYN 洪水或扫描"),
    "04": ("关闭中", "idle", "本机已发起关闭，等待对方确认"),
    "05": ("关闭中", "idle", "等待对方发来关闭请求"),
    "06": ("等待回收", "idle",
           "连接已结束，系统按规范等约 60 秒再回收端口，防止残留数据包串到新连接上。完全正常"),
    "07": ("已关闭", "idle", "连接已关闭"),
    "08": ("待关闭", "odd",
           "对方已关闭，本机程序还没关。大量堆积通常是程序忘了关连接"),
    "09": ("关闭中", "idle", "已发送最后的关闭确认"),
    "0A": ("监听", "idle", "端口在监听"),
    "0B": ("关闭中", "idle", "双方同时发起关闭"),
}
ESTABLISHED = "01"


def _state_info(code):
    return STATES.get(code, (code, "idle", "内核状态码 " + code))

PRIVATE_NETS = [ipaddress.ip_network(n) for n in (
    "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "127.0.0.0/8",
    "100.64.0.0/10", "169.254.0.0/16", "::1/128", "fe80::/10", "fc00::/7",
)]

_geo_cache = {}          # ip -> {"country","as_name","ts"}
_geo_lock = threading.Lock()
GEO_TTL = 86400


def _hex_to_addr(token):
    raw, _, port_hex = token.partition(":")
    port = int(port_hex, 16)
    if len(raw) == 8:
        return socket.inet_ntop(socket.AF_INET, bytes.fromhex(raw)[::-1]), port
    if len(raw) == 32:
        groups = [bytes.fromhex(raw[i:i + 8])[::-1] for i in range(0, 32, 8)]
        return socket.inet_ntop(socket.AF_INET6, b"".join(groups)), port
    return raw, port


def _is_private(ip):
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return True
    # 内核在 tcp6 里把 IPv4 连接写成 ::ffff:127.0.0.1 这种映射形式，
    # 不还原成 v4 就会把本地回环当成外网 IP
    if addr.version == 6 and addr.ipv4_mapped:
        addr = addr.ipv4_mapped
    return any(addr in net for net in PRIVATE_NETS if addr.version == net.version)


def _read_conns():
    """返回 [(本地IP, 本地端口, 远端IP, 远端端口, 状态, inode)]"""
    out = []
    for path in ("/proc/net/tcp", "/proc/net/tcp6"):
        try:
            with open(path, encoding="utf-8") as fp:
                next(fp, None)
                for line in fp:
                    cols = line.split()
                    if len(cols) < 10:
                        continue
                    state = cols[3]
                    if state == "0A":          # 监听态归 ports 采集器管
                        continue
                    lip, lport = _hex_to_addr(cols[1])
                    rip, rport = _hex_to_addr(cols[2])
                    if rport == 0:
                        continue
                    out.append((lip, lport, rip, rport, state, cols[9]))
        except (OSError, ValueError, IndexError):
            continue
    return out


def _listening_ports():
    """本地监听端口集合，用来判断哪一头是"我提供的服务" """
    ports = set()
    for path in ("/proc/net/tcp", "/proc/net/tcp6"):
        try:
            with open(path, encoding="utf-8") as fp:
                next(fp, None)
                for line in fp:
                    cols = line.split()
                    if len(cols) > 3 and cols[3] == "0A":
                        ports.add(_hex_to_addr(cols[1])[1])
        except (OSError, ValueError, IndexError):
            continue
    return ports


def _crowdsec_geo(ips, cfg):
    """先从 CrowdSec 库捞。攻击过的 IP 那里都有国家和 ASN，白拿不用查"""
    if not ips:
        return {}
    path = (cfg.get("crowdsec") or {}).get(
        "db_path", "/var/lib/crowdsec/data/crowdsec.db")
    found = {}
    try:
        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=4)
        try:
            marks = ",".join("?" * len(ips))
            rows = conn.execute(
                f"""SELECT source_ip, source_country, source_as_name FROM alerts
                    WHERE source_ip IN ({marks}) AND source_country IS NOT NULL
                    GROUP BY source_ip""", list(ips)).fetchall()
        finally:
            conn.close()
        for ip, country, asn in rows:
            found[ip] = {"country": country, "as_name": asn, "src": "crowdsec"}
    except sqlite3.Error:
        pass
    return found


def _lookup_geo(ips, cfg):
    """批量查 GeoIP。ip-api 的 batch 接口一次最多 100 个"""
    now = time.time()
    result, need = {}, []
    with _geo_lock:
        for ip in ips:
            hit = _geo_cache.get(ip)
            if hit and now - hit["ts"] < GEO_TTL:
                result[ip] = hit
            else:
                need.append(ip)

    if need:
        for ip, info in _crowdsec_geo(need, cfg).items():
            info["ts"] = now
            result[ip] = info
        need = [ip for ip in need if ip not in result]

    if need and (cfg.get("connections") or {}).get("geoip_lookup", True):
        try:
            resp = httpx.post(
                "http://ip-api.com/batch?fields=status,query,countryCode,as,isp",
                json=need[:100], timeout=8)
            if resp.status_code == 200:
                for row in resp.json() or []:
                    if row.get("status") != "success":
                        continue
                    result[row["query"]] = {
                        "country": row.get("countryCode"),
                        "as_name": row.get("isp") or row.get("as"),
                        "src": "ip-api", "ts": now,
                    }
        except (httpx.RequestError, ValueError):
            pass

    with _geo_lock:
        _geo_cache.update(result)
        if len(_geo_cache) > 3000:            # 防止长期运行撑爆内存
            for k in list(_geo_cache)[:1000]:
                _geo_cache.pop(k, None)
    return result


def _service_names(cfg):
    names = {}
    for port, label in ((cfg.get("ports") or {}).get("labels") or {}).items():
        names[int(port)] = str(label)
    for svc in (cfg or {}).get("services") or []:
        m = re.search(r":(\d+)", str(svc.get("url") or ""))
        if m:
            names.setdefault(int(m.group(1)), str(svc.get("name")))
    return names


def collect(cfg):
    ccfg = (cfg or {}).get("connections") or {}
    show_private = bool(ccfg.get("show_private", False))
    limit = int(ccfg.get("limit", 200))

    raw = _read_conns()
    if not raw:
        return {"ok": True, "items": [], "total": 0, "external": 0,
                "by_port": [], "note": "当前没有活跃连接"}

    listening = _listening_ports()
    names = _service_names(cfg)

    # 同一个远端 IP 可能开几十条连接，按 (远端IP, 本地端口) 聚合才看得清
    groups = {}
    for lip, lport, rip, rport, state, _inode in raw:
        # 本地端口在监听集合里 = 对方连我；否则是我连出去的
        inbound = lport in listening
        peer_port = lport if inbound else rport
        key = (rip, peer_port, inbound)
        slot = groups.setdefault(key, {
            "ip": rip, "port": peer_port, "inbound": inbound,
            "count": 0, "states": {}, "established": 0,
        })
        slot["count"] += 1
        label, _tone, _desc = _state_info(state)
        slot["states"][label] = slot["states"].get(label, 0) + 1
        if state == ESTABLISHED:
            slot["established"] += 1

    items = []
    for slot in groups.values():
        private = _is_private(slot["ip"])
        if private and not show_private:
            continue
        slot["private"] = private
        slot["service"] = names.get(slot["port"])
        # 一个对端可能同时有多种状态，显示占比最大的那个，其余进 tooltip
        main = max(slot["states"].items(), key=lambda x: x[1])[0]
        slot["state"] = main
        tone, desc = "idle", ""
        for _code, (label, t, d) in STATES.items():
            if label == main:
                tone, desc = t, d
                break
        slot["state_tone"] = tone
        slot["state_desc"] = desc
        slot["state_mix"] = ("、".join(f"{k} {v}" for k, v in slot["states"].items())
                             if len(slot["states"]) > 1 else "")
        items.append(slot)

    external = [i for i in items if not i["private"]]
    geo = _lookup_geo({i["ip"] for i in external}, cfg) if external else {}
    for item in items:
        info = geo.get(item["ip"]) or {}
        item["country"] = info.get("country")
        item["as_name"] = info.get("as_name")
        item["as_label"] = pretty_as(info.get("as_name"))

    items.sort(key=lambda x: (x["private"], -x["count"], x["ip"]))

    port_tally = {}
    for item in items:
        if not item["inbound"]:
            continue
        slot = port_tally.setdefault(item["port"], {
            "port": item["port"], "service": item["service"],
            "conns": 0, "peers": 0})
        slot["conns"] += item["count"]
        slot["peers"] += 1
    by_port = sorted(port_tally.values(), key=lambda x: -x["conns"])[:10]

    return {
        "ok": True,
        "items": items[:limit],
        "total": sum(i["count"] for i in items),
        "peers": len(items),
        "external": sum(1 for i in items if not i["private"]),
        "inbound": sum(i["count"] for i in items if i["inbound"]),
        "outbound": sum(i["count"] for i in items if not i["inbound"]),
        "by_port": by_port,
        "show_private": show_private,
        "truncated": len(items) > limit,
        "odd": sum(1 for i in items if i.get("state_tone") == "odd"),
    }
