"""磁盘容量 + btrfs 快照统计"""
import os
import re
import subprocess

_SNAP_DATE = re.compile(r"(\d{4})[.\-](\d{2})[.\-](\d{2})")


def _usage(path):
    st = os.statvfs(path)
    total = st.f_blocks * st.f_frsize
    free = st.f_bavail * st.f_frsize
    used = total - free
    return {
        "total": total,
        "used": used,
        "free": free,
        "percent": round(used / total * 100, 1) if total else 0,
    }


def _snapshots(mount):
    """返回 (快照总数, 最新快照名, 路径列表)。非 btrfs 或无权限时全 None

    btrfs subvolume list 输出形如:
      ID 256 gen 12345 top level 5 path @snapshots/2026-08-01_0300
    path 后面是相对 btrfs 根的路径，拼上挂载点才是可删除的绝对路径。
    """
    try:
        out = subprocess.run(
            ["btrfs", "subvolume", "list", mount],
            capture_output=True, text=True, timeout=30,
        )
        if out.returncode != 0:
            return None, None, None
        snaps = [l for l in out.stdout.splitlines() if "snapshot" in l.lower()]
        latest, paths = None, []
        for line in snaps:
            _, sep, rel = line.partition(" path ")
            if sep and rel.strip():
                paths.append(f"{mount.rstrip('/')}/{rel.strip()}")
            m = _SNAP_DATE.search(line)
            if m:
                stamp = "-".join(m.groups())
                if latest is None or stamp > latest:
                    latest = stamp
        return len(snaps), latest, paths
    except (OSError, subprocess.SubprocessError):
        return None, None, None


def _level(percent, warn, crit):
    if percent >= crit:
        return "crit"
    if percent >= warn:
        return "warn"
    return "ok"


def collect(cfg):
    scfg = cfg.get("storage") or {}
    snapshot_mounts = set(scfg.get("snapshot_mounts") or [])
    volumes = []

    for vol in scfg.get("volumes") or []:
        path = vol.get("path")
        if not path or not os.path.exists(path):
            volumes.append({"path": path, "label": vol.get("label", path),
                            "ok": False, "error": "路径不存在"})
            continue
        try:
            usage = _usage(path)
            item = {
                "ok": True,
                "path": path,
                "label": vol.get("label", path),
                **usage,
                "level": _level(usage["percent"], vol.get("warn", 80), vol.get("crit", 90)),
            }
            if path in snapshot_mounts:
                count, latest, paths = _snapshots(path)
                item["snapshot_count"] = count
                item["snapshot_latest"] = latest
                item["snapshots"] = paths
            volumes.append(item)
        except Exception as exc:  # noqa: BLE001
            volumes.append({"path": path, "label": vol.get("label", path),
                            "ok": False, "error": str(exc)})

    worst = "ok"
    for v in volumes:
        if v.get("level") == "crit":
            worst = "crit"
            break
        if v.get("level") == "warn":
            worst = "warn"
    return {"ok": True, "volumes": volumes, "level": worst}
