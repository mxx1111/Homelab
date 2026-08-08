"""被管理节点的状态采集（SSH）。

和 remote.py 的区别：那个是"探测别人家的机器"，客户端把脚本内容传过去执行；
这个是"我管理的节点"，节点上预先装好采集脚本，面板只负责连接。

差别不是风格问题——传脚本过去执行，就没法用 authorized_keys 的强制命令
（强制命令会忽略客户端传的内容）。而强制命令正是这套方案的安全基础：
面板持有所有节点的私钥，它一旦泄漏，有强制命令保护的话攻击者只能读监控数据，
没有的话等于全部节点的 shell。

节点配置只认 SSH 目标，不绑定任何具体网络方案——用户走 VPN、内网还是公网，
面板不该知道，也不该在代码里出现 "Tailscale" 这种字眼。
"""
import logging
import re
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor

log = logging.getLogger("homelab.nodes")

# 连接复用。每轮采集重新握手一次 SSH 太贵（RTT 高的节点尤其明显），
# 复用之后后续几轮只有几十毫秒
SSH_OPTS = [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=8",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ControlMaster=auto",
    "-o", "ControlPath=/tmp/homelab-ssh-%r@%h:%p",
    "-o", "ControlPersist=10m",
    # 容器里跑，$HOME 未必可写；显式指向 /tmp 免得 known_hosts 写失败拖垮连接
    "-o", "UserKnownHostsFile=/tmp/homelab-known-hosts",
]


def _sections(text):
    """把 ###节名 分节文本拆成 {节名: [行, ...]}"""
    out, key = {}, None
    for line in text.splitlines():
        if line.startswith("###"):
            key = line[3:].strip()
            if key != "END":
                out[key] = []
        elif key and key != "END":
            out[key].append(line)
    return out


def _kv(lines):
    out = {}
    for line in lines:
        k, sep, v = line.partition("=")
        if sep:
            out[k.strip()] = v.strip()
    return out


def _parse_host(lines):
    """/proc/loadavg、/proc/uptime、/proc/meminfo 混在一节里，按内容认"""
    info = {"load": None, "uptime_seconds": None, "memory": None,
            "cores": None, "os": None}
    mem = {}
    for line in lines:
        s = line.strip()
        if not s:
            continue
        if s.startswith(("MemTotal", "MemAvailable", "SwapTotal", "SwapFree")):
            k, _, v = s.partition(":")
            if v.strip():
                mem[k.strip()] = int(v.split()[0]) * 1024
        elif s.startswith("cpucores="):
            info["cores"] = int(s.split("=", 1)[1] or 1)
        elif s.startswith("os="):
            info["os"] = s.split("=", 1)[1]
        elif re.match(r"^[\d.]+ [\d.]+ [\d.]+ \d+/\d+", s):
            info["load"] = [float(x) for x in s.split()[:3]]
        elif re.match(r"^[\d.]+ [\d.]+$", s):
            info["uptime_seconds"] = int(float(s.split()[0]))

    if mem.get("MemTotal"):
        total, avail = mem["MemTotal"], mem.get("MemAvailable", 0)
        info["memory"] = {"total": total, "available": avail,
                          "used": total - avail,
                          "percent": round((total - avail) / total * 100, 1)}
    swap_total = mem.get("SwapTotal", 0)
    if swap_total:
        used = swap_total - mem.get("SwapFree", 0)
        info["swap"] = {"total": swap_total, "used": used,
                        "percent": round(used / swap_total * 100, 1)}
    # 负载除以核数才有可比性。1 核跑满和 16 核跑满都是"100%"，
    # 但 loadavg 分别是 1 和 16
    if info["load"] and info["cores"]:
        info["load_percent"] = round(info["load"][0] / info["cores"] * 100, 1)
    return info


def _parse_temp(lines):
    """取最高的那个传感器读数。多个 zone 时报最热的，那才是要担心的"""
    best = None
    for line in lines:
        _, sep, v = line.partition("=")
        if not sep or not v.strip().isdigit():
            continue
        c = int(v) / 1000
        # 有的板子会报出 0 或者几万度的无效值，掐掉明显不合理的
        if 0 < c < 150 and (best is None or c > best):
            best = c
    return round(best, 1) if best is not None else None


def _parse_disk(lines):
    """df -PT 输出。表头跳过，只留真实挂载点"""
    out = []
    for line in lines[1:]:
        p = line.split()
        if len(p) < 7:
            continue
        try:
            total, used, avail = int(p[2]) * 1024, int(p[3]) * 1024, int(p[4]) * 1024
        except ValueError:
            continue
        if not total:
            continue
        out.append({"device": p[0], "fs": p[1], "mount": " ".join(p[6:]),
                    "total": total, "used": used, "available": avail,
                    "percent": round(used / total * 100, 1)})
    out.sort(key=lambda x: -x["percent"])
    return out


def _parse_containers(lines):
    """running 的全列，exited 的只计数。

    退出的容器往往是历史遗留（回滚备份之类），szch 上就有二十多个，
    全列出来会把真正在跑的淹掉，也撑爆前端。
    """
    running, other, total = [], 0, 0
    for line in lines:
        parts = line.split("\t")
        if len(parts) < 4:
            continue
        name, state, status, image = parts[0], parts[1], parts[2], parts[3]
        total += 1
        if state == "running":
            running.append({"name": name, "status": status, "image": image})
        else:
            other += 1
    return {"total": total, "running": len(running), "stopped": other,
            "items": running[:40]}


def _parse_ports(lines):
    """ss -lntupH。只统计对外监听的，本地回环不算暴露面"""
    exposed, local = [], 0
    for line in lines:
        p = line.split()
        if len(p) < 5:
            continue
        local_addr = p[4]
        addr, _, port = local_addr.rpartition(":")
        if not port.isdigit():
            continue
        proc = ""
        m = re.search(r'users:\(\("([^"]+)"', line)
        if m:
            proc = m.group(1)
        if addr.strip("[]") in ("127.0.0.1", "::1"):
            local += 1
        else:
            exposed.append({"port": int(port), "addr": addr, "proc": proc,
                            "proto": p[0]})
    # 同一端口 IPv4/IPv6 各监听一次，去重后更接近"开了几个服务"。
    # tcp 排在 udp 前：443 同时有 tcp 和 QUIC 的 udp，去重后留 udp 那条会让人
    # 以为这台机器的 443 不是 HTTPS
    seen, uniq = set(), []
    for x in sorted(exposed, key=lambda x: (x["port"], x["proto"] != "tcp")):
        if x["port"] in seen:
            continue
        seen.add(x["port"])
        uniq.append(x)
    return {"exposed": len(uniq), "loopback": local, "items": uniq[:40]}


def _target(ncfg):
    host = str(ncfg.get("host") or "")
    if "@" in host:
        return host
    return f"{ncfg.get('user', 'root')}@{host}"


def _collect_one(ncfg):
    name = ncfg.get("name") or ncfg.get("host")
    started = time.perf_counter()
    cmd = ["ssh", *SSH_OPTS, "-p", str(ncfg.get("port", 22))]
    if ncfg.get("key"):
        cmd += ["-i", ncfg["key"]]
    cmd.append(_target(ncfg))
    # 强制命令模式下这个命令会被忽略，节点跑的是 authorized_keys 里写死的脚本。
    # 仍然传一个是为了兼容没配强制命令的节点——那种情况下它就是实际执行的命令
    cmd.append(ncfg.get("command", "/opt/homelab/node-collect.sh"))

    try:
        out = subprocess.run(cmd, capture_output=True, text=True,
                             timeout=ncfg.get("timeout", 30))
    except subprocess.TimeoutExpired:
        return {"name": name, "ok": False, "error": "SSH 超时"}
    except Exception as exc:  # noqa: BLE001
        return {"name": name, "ok": False, "error": str(exc)[:140]}

    elapsed = round((time.perf_counter() - started) * 1000)
    if out.returncode != 0:
        err = (out.stderr.strip().splitlines() or ["SSH 失败"])[-1]
        return {"name": name, "ok": False, "error": err[:140], "latency_ms": elapsed}
    if "###END" not in out.stdout:
        # 脚本中途死了或者被强制命令换成了别的东西。半截数据比没数据更危险，
        # 它看起来正常但少了几节，界面上表现为"这台机器没有容器"
        return {"name": name, "ok": False, "latency_ms": elapsed,
                "error": "采集脚本输出不完整，检查节点上的 node-collect.sh"}

    sec = _sections(out.stdout)
    meta = _kv(sec.get("META", []))
    cs = _kv(sec.get("CROWDSEC", []))
    appsec = _kv(sec.get("APPSEC", []))
    node = {
        "name": name, "ok": True, "latency_ms": elapsed,
        "hostname": meta.get("hostname"),
        "collected_at": int(meta.get("collected_at") or 0) or None,
        "temp_c": _parse_temp(sec.get("TEMP", [])),
        "disks": _parse_disk(sec.get("DISK", [])),
        "containers": _parse_containers(sec.get("CONTAINERS", [])),
        "ports": _parse_ports(sec.get("PORTS", [])),
        "services": _kv(sec.get("SERVICES", [])),
        "crowdsec": {
            "ipset_entries": int(cs["ipset_entries"]) if cs.get("ipset_entries", "").isdigit() else None,
            "blocked_packets": int(cs["blocked_packets"]) if cs.get("blocked_packets", "").isdigit() else None,
            "blocked_bytes": int(cs["blocked_bytes"]) if cs.get("blocked_bytes", "").isdigit() else None,
            "agent": cs.get("agent"),
            "bouncer": cs.get("bouncer"),
        } if cs else None,
        "appsec": {
            "adapter": appsec.get("adapter"),
            "available": appsec.get("available") == "true",
            "site_count": int(appsec["site_count"]) if appsec.get("site_count", "").isdigit() else None,
            "request_rows": int(appsec["request_rows"]) if appsec.get("request_rows", "").isdigit() else None,
            "attack_rows": int(appsec["attack_rows"]) if appsec.get("attack_rows", "").isdigit() else None,
            "blocked_rows": int(appsec["blocked_rows"]) if appsec.get("blocked_rows", "").isdigit() else None,
            "capabilities": {k: appsec.get(k) == "true" for k in
                             ("waf", "rate_limit", "bot", "geo", "allow_deny")},
        } if appsec else None,
    }
    node.update(_parse_host(sec.get("HOST", [])))
    # 节点时钟偏差会让"最后采集于"这类显示变得莫名其妙，顺手量一下
    if node["collected_at"]:
        node["clock_skew_seconds"] = int(time.time()) - node["collected_at"]
    return node


def collect(cfg):
    ncfgs = [n for n in (cfg.get("nodes") or []) if n.get("host")]
    if not ncfgs:
        return {"ok": True, "items": [], "configured": 0}
    with ThreadPoolExecutor(max_workers=min(8, len(ncfgs))) as pool:
        items = list(pool.map(_collect_one, ncfgs))
    online = sum(1 for n in items if n.get("ok"))
    return {"ok": True, "items": items, "configured": len(ncfgs),
            "online": online, "offline": len(items) - online}
