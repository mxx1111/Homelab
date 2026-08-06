"""端口暴露审计。

容器跑在 network_mode: host 下，/proc/net/tcp 读到的就是宿主机网络栈，
不需要额外挂载。但 PID namespace 不共享，拿不到进程名，所以用两个办法补：
  1. docker ps 的端口映射 -> 认领容器发布的端口
  2. config 里的服务清单 -> 认领已知服务

风险分级不靠猜，靠三个客观事实：
  绑定地址是不是 127.0.0.1（绑本地的天然不可达）
  端口在不在放行脚本的白名单里
  端口在不在配置声明的公网映射里
"""
import json
import os
import re
import socket
import subprocess

LISTEN_TCP = "0A"
UNCONN_UDP = "07"

# 这些端口即便暴露也基本无害，或本来就该开，单独标注避免误报
BENIGN = {53: "DNS", 67: "DHCP", 68: "DHCP", 123: "NTP", 5353: "mDNS", 1900: "SSDP"}


def _hex_to_addr(token):
    """/proc/net/tcp 的 local_address 是小端 hex。IPv4 8 字符，IPv6 32 字符"""
    raw, _, port_hex = token.partition(":")
    port = int(port_hex, 16)
    if len(raw) == 8:
        packed = bytes.fromhex(raw)[::-1]
        return socket.inet_ntop(socket.AF_INET, packed), port
    if len(raw) == 32:
        # IPv6 按 4 字节一组小端存放
        groups = [bytes.fromhex(raw[i:i + 8])[::-1] for i in range(0, 32, 8)]
        return socket.inet_ntop(socket.AF_INET6, b"".join(groups)), port
    return raw, port


def _read_proc(path, want_state):
    out = []
    try:
        with open(path, encoding="utf-8") as fp:
            next(fp, None)
            for line in fp:
                cols = line.split()
                if len(cols) < 4 or cols[3] != want_state:
                    continue
                addr, port = _hex_to_addr(cols[1])
                out.append((addr, port))
    except (OSError, ValueError, IndexError):
        pass
    return out


def _listeners():
    """合并 v4/v6、TCP/UDP，同端口去重并记住绑定地址集合"""
    seen = {}
    sources = [
        ("/proc/net/tcp", LISTEN_TCP, "tcp"),
        ("/proc/net/tcp6", LISTEN_TCP, "tcp"),
        ("/proc/net/udp", UNCONN_UDP, "udp"),
        ("/proc/net/udp6", UNCONN_UDP, "udp"),
    ]
    for path, state, proto in sources:
        for addr, port in _read_proc(path, state):
            key = (proto, port)
            slot = seen.setdefault(key, {"proto": proto, "port": port, "addrs": set()})
            slot["addrs"].add(addr)
    return seen


def _local_only(addrs):
    """所有绑定地址都是回环，才算仅本机可达"""
    return bool(addrs) and all(
        a.startswith("127.") or a in ("::1",) for a in addrs)


def _docker_ports():
    """容器发布的端口 -> 容器名。host 网络的容器拿不到映射，返回空"""
    mapping = {}
    try:
        out = subprocess.run(
            ["docker", "ps", "--format", "{{.Names}}\t{{.Ports}}"],
            capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return mapping
    if out.returncode != 0:
        return mapping
    for line in out.stdout.splitlines():
        name, _, ports = line.partition("\t")
        if not name:
            continue
        for m in re.finditer(r"(?:([\d.]+|\[::\]):)?(\d+)(?:-\d+)?->", ports):
            mapping.setdefault(int(m.group(2)), name)
    return mapping


def _homeguard_ports(path):
    """从放行脚本里抠 PORTS="5000,445,..." 这一行"""
    if not path or not os.path.isfile(path):
        return None
    try:
        with open(path, encoding="utf-8") as fp:
            text = fp.read()
    except OSError:
        return None
    m = re.search(r'^\s*PORTS=["\']?([\d,\s]+)', text, re.M)
    if not m:
        return None
    return {int(p) for p in re.findall(r"\d+", m.group(1))}


def collect(cfg):
    pcfg = (cfg or {}).get("ports") or {}
    guard_path = pcfg.get("homeguard_path", "")
    public = {int(p) for p in (pcfg.get("public_ports") or [])}
    known = {int(k): str(v) for k, v in (pcfg.get("labels") or {}).items()}

    listeners = _listeners()
    if not listeners:
        return {"ok": False, "error": "读不到 /proc/net/tcp，确认容器为 host 网络模式"}

    docker_map = _docker_ports()
    guard = _homeguard_ports(guard_path)

    # 服务探针里配的 127.0.0.1:port 也能反推出服务名
    for svc in (cfg or {}).get("services") or []:
        m = re.search(r":(\d+)", str(svc.get("url") or ""))
        if m:
            known.setdefault(int(m.group(1)), str(svc.get("name")))

    items = []
    for (proto, port), info in listeners.items():
        addrs = info["addrs"]
        local = _local_only(addrs)
        owner = known.get(port) or docker_map.get(port)
        in_guard = None if guard is None else (port in guard)
        is_public = port in public

        if local:
            level, note = "safe", "仅本机可达"
        elif is_public:
            level, note = "public", "已声明对公网开放"
        elif in_guard:
            level, note = "lan", "防火墙放行，内网可达"
        elif in_guard is False:
            level, note = "safe", "未在放行脚本白名单，外部被拦"
        else:
            level, note = "lan", "监听所有网卡"

        if port in BENIGN and level != "public":
            level, note = "safe", BENIGN[port]

        items.append({
            "port": port, "proto": proto,
            "addrs": sorted(addrs), "local_only": local,
            "owner": owner, "container": docker_map.get(port),
            "in_guard": in_guard, "public": is_public,
            "level": level, "note": note,
        })

    items.sort(key=lambda x: ({"public": 0, "lan": 1, "safe": 2}[x["level"]], x["port"]))
    counts = {"public": 0, "lan": 0, "safe": 0}
    for it in items:
        counts[it["level"]] += 1

    return {
        "ok": True, "items": items, "counts": counts,
        "total": len(items),
        "guard_found": guard is not None,
        "guard_ports": sorted(guard) if guard else [],
        "declared_public": sorted(public),
    }
