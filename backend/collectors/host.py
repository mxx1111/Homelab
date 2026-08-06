"""本机 CPU / 内存 / 负载 / 温度 / 运行时长"""
import os
import time

_prev_cpu = None


def _read_cpu_total():
    with open("/proc/stat", encoding="utf-8") as fp:
        parts = fp.readline().split()
    values = [int(x) for x in parts[1:]]
    idle = values[3] + (values[4] if len(values) > 4 else 0)
    return sum(values), idle


def _cpu_percent():
    global _prev_cpu
    total, idle = _read_cpu_total()
    if _prev_cpu is None:
        _prev_cpu = (total, idle)
        return None
    d_total = total - _prev_cpu[0]
    d_idle = idle - _prev_cpu[1]
    _prev_cpu = (total, idle)
    if d_total <= 0:
        return None
    return round((1 - d_idle / d_total) * 100, 1)


def _meminfo():
    info = {}
    with open("/proc/meminfo", encoding="utf-8") as fp:
        for line in fp:
            key, _, rest = line.partition(":")
            info[key] = int(rest.split()[0]) * 1024
    total = info.get("MemTotal", 0)
    available = info.get("MemAvailable", 0)
    return {
        "total": total,
        "available": available,
        "used": total - available,
        "percent": round((total - available) / total * 100, 1) if total else 0,
    }


def _temperature():
    """取所有热区最高值，读不到返回 None"""
    best = None
    base = "/sys/class/thermal"
    if not os.path.isdir(base):
        return None
    for name in os.listdir(base):
        if not name.startswith("thermal_zone"):
            continue
        try:
            with open(f"{base}/{name}/temp", encoding="utf-8") as fp:
                value = int(fp.read().strip()) / 1000
            if 0 < value < 150 and (best is None or value > best):
                best = value
        except (OSError, ValueError):
            continue
    return round(best, 1) if best is not None else None


def collect(_cfg):
    try:
        with open("/proc/loadavg", encoding="utf-8") as fp:
            load = [float(x) for x in fp.read().split()[:3]]
        with open("/proc/uptime", encoding="utf-8") as fp:
            uptime = float(fp.read().split()[0])
        return {
            "ok": True,
            "cpu_percent": _cpu_percent(),
            "cpu_cores": os.cpu_count(),
            "memory": _meminfo(),
            "load": load,
            "uptime_seconds": int(uptime),
            "temperature": _temperature(),
            "ts": time.time(),
        }
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)}
