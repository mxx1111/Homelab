"""Docker 容器状态与资源占用"""
import subprocess

_SEP = "\x1f"


def _run(args, timeout=25):
    out = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    if out.returncode != 0:
        raise RuntimeError(out.stderr.strip() or "docker 命令失败")
    return out.stdout


def _parse_pct(text):
    try:
        return float(text.strip().rstrip("%"))
    except (ValueError, AttributeError):
        return None


def _parse_mem(text):
    """'2.494GiB / 15.5GiB' -> 已用字节数"""
    units = {"B": 1, "KIB": 1024, "MIB": 1024 ** 2, "GIB": 1024 ** 3, "TIB": 1024 ** 4,
             "KB": 1000, "MB": 1000 ** 2, "GB": 1000 ** 3}
    try:
        raw = text.split("/")[0].strip()
        num = ""
        for ch in raw:
            if ch.isdigit() or ch == ".":
                num += ch
            else:
                break
        unit = raw[len(num):].strip().upper()
        return float(num) * units.get(unit, 1)
    except (ValueError, IndexError):
        return None


def collect(_cfg):
    try:
        listing = _run(["docker", "ps", "-a", "--format",
                        f"{{{{.Names}}}}{_SEP}{{{{.State}}}}{{{{{_SEP}}}}}{{{{.Status}}}}"])
    except Exception:  # noqa: BLE001
        # 兼容旧版 docker 不支持 .State
        try:
            listing = _run(["docker", "ps", "-a", "--format",
                            f"{{{{.Names}}}}{_SEP}{{{{.Status}}}}"])
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": str(exc)}

    containers = {}
    for line in listing.splitlines():
        parts = [p for p in line.split(_SEP) if p != ""]
        if not parts:
            continue
        name = parts[0]
        status = parts[-1]
        running = status.lower().startswith("up")
        containers[name] = {"name": name, "status": status, "running": running,
                            "cpu_percent": None, "memory_bytes": None}

    # stats 只覆盖运行中的容器
    try:
        stats = _run(["docker", "stats", "--no-stream", "--format",
                      f"{{{{.Name}}}}{_SEP}{{{{.CPUPerc}}}}{_SEP}{{{{.MemUsage}}}}"], timeout=30)
        for line in stats.splitlines():
            parts = line.split(_SEP)
            if len(parts) < 3:
                continue
            name = parts[0]
            if name in containers:
                containers[name]["cpu_percent"] = _parse_pct(parts[1])
                containers[name]["memory_bytes"] = _parse_mem(parts[2])
    except Exception:  # noqa: BLE001
        pass  # stats 失败不影响列表

    items = sorted(containers.values(),
                   key=lambda c: (not c["running"], -(c["cpu_percent"] or 0)))
    running = sum(1 for c in items if c["running"])
    return {"ok": True, "total": len(items), "running": running,
            "stopped": len(items) - running, "items": items}
