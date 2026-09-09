"""把两套采集结果投影成同一份 NodeSnapshot。

**这里只做映射，不做采集。** 本机那 13 个采集器一行没改，节点那个 bash 脚本
也一行没改——它们各自产出什么还是什么，这个文件负责把两边的输出摆进
nodeschema 定义的同一个盒子里。

之所以是"投影"而不是"重写"，是因为重写要付出的代价太不对称：本机的采集比
节点脚本精细得多（连接带 GeoIP、端口三级分类、SMART 属性、网络速率），
为了对齐而把本机降级成 shell 能做的那点东西，是拿功能换整齐。
反过来让节点脚本长成 Python 采集器那样，节点就得装运行时。

投影的好处是两边都不用退让：schema 取本机那份丰富结构做基准，节点填得上的填，
填不上的标 unsupported——**缺什么是明说的，不是让人从空白里猜**。
"""
import time

from . import nodeschema as ns


def _sec(sections, name):
    """取某个采集器的 data。采集失败时 cache.py 会保留上一次成功的数据，
    所以 data 有值但 error 也有值是正常的，不能因为有 error 就当没数据"""
    slot = (sections or {}).get(name) or {}
    return slot.get("data"), slot.get("error")


def _ok(data):
    return isinstance(data, dict) and data.get("ok") is not False


# ---------------------------------------------------------------- 本机

def from_local(sections, cfg=None, name="本机"):
    """本机的 13 个采集器 → NodeSnapshot。

    本机在 fleet 里的 id 固定是 "local"。它不是特殊实体，只是恰好跑着面板
    的那一台——这样节点切换器、fleet 排序、历史曲线都只需要写一遍。
    """
    host, _ = _sec(sections, "host")
    snap = ns.make("local", name, "local", ok=True)

    if _ok(host):
        snap["node"]["uptime_seconds"] = host.get("uptime_seconds")
        snap["node"]["collected_at"] = host.get("ts")
        cores = host.get("cpu_cores")
        load = host.get("load") or []
        ns.put(snap, "host", {
            "cores": cores,
            "load": load,
            # 负载除以核数才有可比性。本机采集器原本只报 loadavg 原值，
            # 节点那边报的是百分比——不在这里统一，前端就得判断"这个数是
            # 1.8 还是 45%"，两边的灯色阈值也没法共用
            "load_percent": round(load[0] / cores * 100, 1) if load and cores else None,
            "cpu_percent": host.get("cpu_percent"),
            "memory": host.get("memory"),
            "swap": None,                       # 本机采集器没采 swap，节点采了
            "temp_c": host.get("temperature"),
            "uptime_seconds": host.get("uptime_seconds"),
            "os": None,
        }, ns.FULL)

    storage, _ = _sec(sections, "storage")
    if _ok(storage) and storage.get("volumes"):
        vols = [v for v in storage["volumes"] if v.get("ok")]
        ns.put(snap, "storage", {
            "level": storage.get("level"),
            # 统一成 mount/total/used/available/percent，和节点侧 df 解析出来的
            # 字段名对齐。本机原本叫 path/free，节点叫 mount/available
            "items": [{
                "mount": v.get("path"), "label": v.get("label"),
                "fs": None, "device": None,
                "total": v.get("total"), "used": v.get("used"),
                "available": v.get("free"), "percent": v.get("percent"),
                "level": v.get("level"),
                "snapshot_count": v.get("snapshot_count"),
                "snapshot_latest": v.get("snapshot_latest"),
            } for v in sorted(vols, key=lambda x: -(x.get("percent") or 0))],
            "failed": [v for v in storage["volumes"] if not v.get("ok")],
        }, ns.FULL)

    net, _ = _sec(sections, "network")
    if _ok(net):
        ns.put(snap, "network", {
            "interface": net.get("interface"),
            "rx_bytes_per_sec": net.get("rx_bytes_per_sec"),
            "tx_bytes_per_sec": net.get("tx_bytes_per_sec"),
            "rx_total": net.get("rx_total"), "tx_total": net.get("tx_total"),
            "public_ip": net.get("public_ip"),
        }, ns.FULL)

    ctr, _ = _sec(sections, "containers")
    if _ok(ctr):
        ns.put(snap, "containers", {
            "total": ctr.get("total"), "running": ctr.get("running"),
            "stopped": ctr.get("stopped"), "items": ctr.get("items") or [],
            # 本机能启停、看日志、清快照；节点那把受限密钥只能跑采集脚本
            "actionable": True,
        }, ns.FULL)

    ports, _ = _sec(sections, "ports")
    if _ok(ports):
        counts = ports.get("counts") or {}
        ns.put(snap, "ports", {
            "items": ports.get("items") or [],
            "total": ports.get("total"),
            # 三级分类要读防火墙放行脚本才判断得出，节点侧只有两级，
            # 所以那边这个模块标 basic
            "graded": True,
            "public": counts.get("public"), "lan": counts.get("lan"),
            "safe": counts.get("safe"),
            "exposed": (counts.get("public") or 0) + (counts.get("lan") or 0),
            "loopback": counts.get("safe"),
            "guard_found": ports.get("guard_found"),
        }, ns.FULL)

    conns, _ = _sec(sections, "connections")
    if _ok(conns):
        ns.put(snap, "connections", {
            "items": conns.get("items") or [],
            "total": conns.get("total"), "peers": conns.get("peers"),
            "external": conns.get("external"),
            "inbound": conns.get("inbound"), "outbound": conns.get("outbound"),
            "by_port": conns.get("by_port") or [],
            "truncated": conns.get("truncated"), "odd": conns.get("odd"),
            "geo": True,
        }, ns.FULL)

    engine, _ = _sec(sections, "engine")
    if _ok(engine):
        ns.put(snap, "engine", {
            "sources": engine.get("sources") or [],
            "effective_sources": engine.get("effective_sources"),
            "wasted_sources": engine.get("wasted_sources") or [],
            "scenarios": engine.get("scenarios") or [],
            "overflowed_total": engine.get("overflowed_total"),
            "parse_rate": engine.get("parse_rate"),
            "active_buckets": engine.get("active_buckets"),
        }, ns.FULL)

    disks, _ = _sec(sections, "disks")
    if _ok(disks):
        ns.put(snap, "disks", {
            "items": disks.get("items") or [], "total": disks.get("total"),
            "failing": disks.get("failing"), "aging": disks.get("aging"),
            "unavailable": disks.get("unavailable") or [],
            "raids": disks.get("raids") or {},
            "no_redundancy": disks.get("no_redundancy") or [],
        }, ns.FULL)

    certs, _ = _sec(sections, "certs")
    if _ok(certs) and (certs.get("items") or []):
        ns.put(snap, "certs", {
            "items": certs["items"], "level": certs.get("level"),
        }, ns.FULL)

    probes, _ = _sec(sections, "services")
    if _ok(probes) and (probes.get("items") or []):
        # 注意这是 HTTP 探针，不是 systemd 单元。两者同名不同物，
        # 理由见 nodeschema 的模块说明
        ns.put(snap, "probes", {
            "items": probes["items"], "total": probes.get("total"),
            "up": probes.get("up"), "down": probes.get("down"),
        }, ns.FULL)

    # guard：本机实际落地了多少条封禁规则。面板读的是中央 LAPI 的决策集，
    # 那是"下发了多少"，不是"本机 ipset 里真有多少"。这两个数在 bouncer
    # 掉线时会不一致，而那恰恰是最需要发现的时刻——所以本机这项标 unsupported
    # 而不是拿决策数冒充，节点反而因为脚本查了 ipset 是 full
    return snap


# ---------------------------------------------------------------- 节点

def from_remote(node):
    """nodes 采集器的一条结果 → NodeSnapshot。

    入参是 collectors/nodes.py 产出的扁平 dict（那边保持原样，没动），
    这里负责摊平成模块。
    """
    name = node.get("name") or "?"
    snap = ns.make(
        name, name, "remote",
        ok=bool(node.get("ok")), error=node.get("error"),
        hostname=node.get("hostname"), os=node.get("os"),
        collected_at=node.get("collected_at"),
        latency_ms=node.get("latency_ms"),
        clock_skew_seconds=node.get("clock_skew_seconds"),
        uptime_seconds=node.get("uptime_seconds"),
    )
    if not node.get("ok"):
        # 离线节点也要返回完整骨架：capabilities 全 unsupported，
        # 前端照常渲染卡片位置，只是每张都是"节点离线"。比整页空白好读
        return snap

    ns.put(snap, "host", {
        "cores": node.get("cores"), "load": node.get("load"),
        "load_percent": node.get("load_percent"),
        # v7 起脚本采两次 /proc/stat 求差，给的是真实使用率；老脚本没这项时是 None
        "cpu_percent": node.get("cpu_percent"),
        "procs_running": node.get("procs_running"),
        "memory": node.get("memory"), "swap": node.get("swap"),
        "temp_c": node.get("temp_c"),
        "uptime_seconds": node.get("uptime_seconds"),
        "os": node.get("os"),
    }, ns.FULL)

    disks = node.get("disks") or []
    if disks:
        ns.put(snap, "storage", {
            "level": None,
            "items": [{**d, "label": d.get("mount")} for d in disks],
            "failed": [],
        }, ns.FULL)

    c = node.get("containers") or {}
    if c:
        ns.put(snap, "containers", {
            "total": c.get("total"), "running": c.get("running"),
            "stopped": c.get("stopped"),
            "items": [{**x, "running": True} for x in (c.get("items") or [])],
            # 受限密钥只能执行采集脚本，启不了容器。这不是缺陷，是那把钥匙的
            # 价值所在：即使泄漏，拿到的也只是读监控数据的能力
            "actionable": False,
        }, ns.READONLY)

    p = node.get("ports") or {}
    if p:
        ns.put(snap, "ports", {
            "items": p.get("items") or [], "total": p.get("exposed"),
            # 只分"对外/回环"两档。三级分类要读这台的防火墙规则才判断得出，
            # 脚本没做——所以是 basic 而不是 full
            "graded": False,
            "public": None, "lan": None, "safe": p.get("loopback"),
            "exposed": p.get("exposed"), "loopback": p.get("loopback"),
        }, ns.BASIC)

    cs = node.get("crowdsec") or {}
    if cs and cs.get("ipset_entries") is not None:
        ns.put(snap, "guard", {
            "ipset_entries": cs.get("ipset_entries"),
            "blocked_packets": cs.get("blocked_packets"),
            "blocked_bytes": cs.get("blocked_bytes"),
            "agent": cs.get("agent"), "bouncer": cs.get("bouncer"),
        }, ns.FULL)

    units = node.get("services") or {}
    if units:
        ns.put(snap, "units", {
            "items": [{"name": k, "state": v} for k, v in sorted(units.items())],
            "total": len(units),
            "down": sum(1 for v in units.values() if v != "active"),
        }, ns.FULL)

    ap = node.get("appsec") or {}
    if ap and ap.get("available"):
        ns.put(snap, "appsec", ap, ns.FULL)

    # ---- 采集脚本 v5 补上的几项。老版本脚本没有这些节，parser 返回 None，
    # 这里就不 put，capability 保持 unsupported。节点没升级不会报错，
    # 只是前端多显示几张"未启用"的占位卡
    net = node.get("network")
    if net:
        # 首轮没有速率（节点侧还没有上一次的计数可比），这时报 basic 而不是 full：
        # 卡片照常显示，但角上标出来"这一轮还没有速率"，比显示 0 B/s 诚实
        has_rate = net.get("rx_bytes_per_sec") is not None
        ns.put(snap, "network", net, ns.FULL if has_rate else ns.BASIC)

    conns = node.get("connections")
    if conns:
        # 节点侧只有 established 的 TCP，分不出入站出站（要对照监听端口才知道），
        # 也没有连接状态的细分。比本机那份粗，标 basic
        ns.put(snap, "connections", conns, ns.BASIC)

    certs = node.get("certs")
    if certs:
        # 扫的是节点上放着的证书文件，不做 TLS 探测。和本机那份"探测线上端口"
        # 不完全等价——文件里的证书未必是 nginx 正在用的那张
        ns.put(snap, "certs", certs, ns.BASIC)

    smart = node.get("smart")
    if smart:
        # 取了健康自评、通电时间、重分配与待处理扇区、温度。本机那份还解析
        # 完整属性表和 RAID 冗余，节点只取了要害那几项
        ns.put(snap, "disks", smart, ns.BASIC)

    engine = node.get("engine")
    if engine:
        # 这项和本机完全同源：节点把 6060 的 prometheus 文本抓回来，
        # 面板用同一个 engine.build 解析，所以是 full 不是 basic
        ns.put(snap, "engine", {
            "sources": engine.get("sources") or [],
            "effective_sources": engine.get("effective_sources"),
            "wasted_sources": engine.get("wasted_sources") or [],
            "scenarios": engine.get("scenarios") or [],
            "overflowed_total": engine.get("overflowed_total"),
            "parse_rate": engine.get("parse_rate"),
            "active_buckets": engine.get("active_buckets"),
        }, ns.FULL)

    snap["node"]["script_version"] = node.get("script_version")
    return snap


# ---------------------------------------------------------------- fleet

def fleet(sections, cfg=None, site_name="本机"):
    """本机 + 全部节点，同一份形状排在一起。

    本机排第一不是因为它特殊，只是它总在线、当参照物方便。
    """
    snaps = [from_local(sections, cfg, site_name)]
    nodes, _ = _sec(sections, "nodes")
    for item in ((nodes or {}).get("items") or []):
        snaps.append(from_remote(item))
    return snaps


def summarize(snap):
    """fleet 列表用的一行摘要。前端排序、灯色都读这个，不再各算各的。"""
    mods = snap["modules"]
    host = mods.get("host") or {}
    storage = mods.get("storage") or {}
    ctr = mods.get("containers") or {}
    ports = mods.get("ports") or {}
    guard = mods.get("guard") or {}
    worst_disk = (storage.get("items") or [{}])[0]

    # 灯色取三个百分比里最高的。分开看容易漏——内存 90% 和磁盘 90% 都是问题，
    # 只盯负载的话两个都看不见
    # CPU 压力优先看真实使用率，拿不到才退回 loadavg 换算。
    # loadavg 把不可中断睡眠（D 状态）的进程也算进去，带 NPU/GPU 的板子上
    # 常驻驱动线程就卡在 D 状态：aipro 实测 load 17（3 核 = 567%）而 CPU
    # 99% 空闲、iowait 0%，只看 loadavg 会一直误报"节点异常"。
    cpu_pressure = host.get("cpu_percent")
    if cpu_pressure is None:
        cpu_pressure = host.get("load_percent") or 0
    peak = max(cpu_pressure,
               (host.get("memory") or {}).get("percent") or 0,
               worst_disk.get("percent") or 0)

    issues = []
    if guard.get("agent") and guard["agent"] != "active":
        issues.append("agent 停了")
    if guard.get("bouncer") and guard["bouncer"] != "active":
        issues.append("bouncer 停了")
    # crowdsec 那两个 systemd 单元已经由 guard 单独报过了。两处都报会变成
    # "bouncer 停了 · crowdsec-firewall-bouncer failed"，同一件事说两遍，
    # 看的人还得先确认这是不是两个故障
    covered = {"crowdsec", "crowdsec-firewall-bouncer"} if guard else set()
    for u in (mods.get("units") or {}).get("items") or []:
        if u["state"] != "active" and u["name"] not in covered:
            issues.append(f"{u['name']} {u['state']}")

    node = snap["node"]
    if not node["ok"]:
        level = "crit"
    elif issues or peak > 90:
        level = "crit"
    elif peak > 75:
        level = "warn"
    else:
        level = "ok"

    return {
        "id": node["id"], "name": node["name"], "role": node["role"],
        "ok": node["ok"], "error": node["error"], "level": level,
        "hostname": node["hostname"], "latency_ms": node["latency_ms"],
        "uptime_seconds": node["uptime_seconds"],
        "clock_skew_seconds": node["clock_skew_seconds"],
        "load_percent": host.get("load_percent"),
        # 真实 CPU 使用率优先展示；loadavg 原值留着放进 tooltip，
        # 排查"负载高但 CPU 空闲"时还得看它
        "cpu_percent": host.get("cpu_percent"),
        "load": host.get("load"),
        "cores": host.get("cores"),
        "memory_percent": (host.get("memory") or {}).get("percent"),
        "disk_percent": worst_disk.get("percent"),
        "disk_mount": worst_disk.get("mount"),
        "temp_c": host.get("temp_c"),
        "containers_running": ctr.get("running"),
        "containers_total": ctr.get("total"),
        "ports_exposed": ports.get("exposed"),
        "guard_entries": guard.get("ipset_entries"),
        "issues": issues,
        "capabilities": snap["capabilities"],
    }
