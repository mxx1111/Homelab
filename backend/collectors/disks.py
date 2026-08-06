"""硬盘 SMART 健康。

存在的理由：不少 NAS 系统会把单块盘也包装成 raid1，mdstat 里看着是 raid1，
实际是 [1/1] 单成员，零冗余；LVM 线性拼接的卷更是任一块盘故障就整卷全丢。
机械盘不会毫无征兆地死，重映射扇区和待处理扇区会先涨，盯住这两个数
就能在彻底坏掉之前换盘。面板会把这类"名义冗余"单独点出来。

smartctl 要 root 且要能访问 /dev/sdX，容器里靠 SYS_RAWIO + 设备挂载。
拿不到就返回不可用，不影响其他采集。
"""
import re
import subprocess

# 这几项一旦非零就该警觉，数值只增不减
CRITICAL_ATTRS = {
    "Reallocated_Sector_Ct": "重映射扇区",
    "Current_Pending_Sector": "待处理扇区",
    "Offline_Uncorrectable": "无法校正扇区",
    "Reported_Uncorrect": "报告未校正",
}
ATTR_LINE = re.compile(r"^\s*(\d+)\s+(\S+)\s+\S+\s+(\d+)\s+(\d+)\s+(\d+)\s+\S+\s+\S+\s+\S+\s+(\d+)")


ERR_AT = re.compile(r"occurred at disk power-on lifetime:\s*(\d+)\s*hours", re.I)
# 距今超过这么久的错误算历史遗留，不再当作退化信号
STALE_ERROR_HOURS = 8766        # 1 年


def _last_error_hour(dev):
    """SMART 属性是只增不减的累计值，光看 Reported_Uncorrect=6 分不清
    这 6 次是昨天发生的还是六年前。错误日志里带 power-on 时间戳，
    拿它和当前运行时长一比就知道是不是陈年旧账"""
    text = _run(["smartctl", "-l", "error", f"/dev/{dev}"], timeout=20)
    if not text:
        return None
    hours = [int(m) for m in ERR_AT.findall(text)]
    return max(hours) if hours else None


def _run(args, timeout=25):
    try:
        out = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.SubprocessError):
        return None
    # smartctl 的退出码是位掩码，低两位才是致命错误，其余位只是提示
    if out.returncode and out.returncode & 0b11:
        return None
    return out.stdout


def _list_disks():
    text = _run(["lsblk", "-dn", "-o", "NAME,TYPE"], timeout=10)
    if not text:
        return []
    disks = []
    for line in text.splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[1] == "disk" and not parts[0].startswith("loop"):
            disks.append(parts[0])
    return disks


def _parse(text):
    info = {"model": None, "serial": None, "hours": None, "rotation": None,
            "temp": None, "health": None, "attrs": {}, "issues": []}
    for line in text.splitlines():
        if line.startswith("Device Model:") or line.startswith("Model Number:"):
            info["model"] = line.split(":", 1)[1].strip()
        elif line.startswith("Rotation Rate:"):
            info["rotation"] = line.split(":", 1)[1].strip()
        elif "overall-health" in line:
            info["health"] = "PASSED" if "PASSED" in line else "FAILED"
        elif line.startswith("SMART Health Status:"):
            info["health"] = "PASSED" if "OK" in line else "FAILED"

        m = ATTR_LINE.match(line)
        if not m:
            continue
        _, name, _value, _worst, _thresh, raw = m.groups()
        try:
            raw_int = int(raw)
        except ValueError:
            continue
        if name == "Power_On_Hours":
            info["hours"] = raw_int
        elif name in ("Temperature_Celsius", "Airflow_Temperature_Cel"):
            info["temp"] = raw_int % 256          # 有些盘把多个值打包在 raw 里
        elif name in CRITICAL_ATTRS:
            info["attrs"][name] = raw_int
            if raw_int > 0:
                info["issues"].append(f"{CRITICAL_ATTRS[name]} {raw_int}")
    return info


def _nvme_health(dev):
    text = _run(["smartctl", "-A", "-H", "-i", f"/dev/{dev}"])
    if not text:
        return None
    info = {"model": None, "hours": None, "temp": None, "health": None,
            "attrs": {}, "issues": [], "rotation": "SSD"}
    for line in text.splitlines():
        if line.startswith("Model Number:"):
            info["model"] = line.split(":", 1)[1].strip()
        elif "SMART overall-health" in line:
            info["health"] = "PASSED" if "PASSED" in line else "FAILED"
        elif line.startswith("Power On Hours:"):
            digits = re.sub(r"[^\d]", "", line.split(":", 1)[1])
            info["hours"] = int(digits) if digits else None
        elif line.startswith("Temperature:"):
            m = re.search(r"(\d+)", line.split(":", 1)[1])
            if m:
                info["temp"] = int(m.group(1))
        elif line.startswith("Percentage Used:"):
            m = re.search(r"(\d+)", line)
            if m:
                info["attrs"]["Percentage_Used"] = int(m.group(1))
                if int(m.group(1)) >= 80:
                    info["issues"].append(f"寿命已用 {m.group(1)}%")
        elif line.startswith("Media and Data Integrity Errors:"):
            digits = re.sub(r"[^\d]", "", line.split(":", 1)[1])
            if digits and int(digits) > 0:
                info["attrs"]["Media_Errors"] = int(digits)
                info["issues"].append(f"介质错误 {digits}")
    return info


def _raid_map():
    """mdstat 里 [n/m] 才是真冗余。单盘包成的 raid1 看着有实际没有"""
    try:
        with open("/proc/mdstat", encoding="utf-8") as fp:
            text = fp.read()
    except OSError:
        return {}
    out = {}
    current = None
    for line in text.splitlines():
        m = re.match(r"^(md\d+)\s*:\s*active\s+(\S+)\s+(.*)$", line)
        if m:
            current = m.group(1)
            members = re.findall(r"(\w+?)\[\d+\]", m.group(3))
            out[current] = {"level": m.group(2), "members": members, "redundant": False}
            continue
        if current:
            m2 = re.search(r"\[(\d+)/(\d+)\]", line)
            if m2:
                total, active = int(m2.group(1)), int(m2.group(2))
                out[current]["redundant"] = total > 1 and active > 1
                out[current]["degraded"] = active < total
                current = None
    return out


def collect(cfg):
    dcfg = (cfg or {}).get("disks") or {}
    warn_hours = int(dcfg.get("warn_hours", 35000))     # 约 4 年

    disks = _list_disks()
    if not disks:
        return {"ok": False, "error": "读不到磁盘列表，确认容器已挂载 /dev 且有 lsblk"}

    items, unavailable = [], []
    for dev in disks:
        if dev.startswith("nvme"):
            info = _nvme_health(dev)
        else:
            text = _run(["smartctl", "-A", "-H", "-i", f"/dev/{dev}"])
            info = _parse(text) if text else None
        if info is None:
            unavailable.append(dev)
            continue

        hours = info.get("hours")
        aging = hours is not None and hours >= warn_hours
        if aging:
            info["issues"].append(f"已通电 {hours // 8766} 年")

        # 重映射和待处理扇区是"当前状态"，非零就是真问题。
        # Reported_Uncorrect 是历史累计次数，得看最后一次发生在多久以前——
        # 六年前出过几次、之后再没有，和昨天刚出，完全是两回事
        active_bad = (info["attrs"].get("Reallocated_Sector_Ct", 0) > 0
                      or info["attrs"].get("Current_Pending_Sector", 0) > 0
                      or info["attrs"].get("Offline_Uncorrectable", 0) > 0)
        historic = info["attrs"].get("Reported_Uncorrect", 0) > 0
        if historic and not dev.startswith("nvme"):
            last_err = _last_error_hour(dev)
            info["last_error_hour"] = last_err
            if last_err is not None and hours is not None:
                gap = hours - last_err
                info["error_age_hours"] = gap
                if gap > STALE_ERROR_HOURS:
                    # 陈年旧账，从问题列表里摘出来单独说明，不参与告警
                    info["issues"] = [i for i in info["issues"]
                                      if "报告未校正" not in i]
                    info["stale_note"] = (
                        f"{info['attrs']['Reported_Uncorrect']} 次读取错误发生在 "
                        f"{last_err} 小时时，距今 {round(gap / 8766, 1)} 年无新增")
                    historic = False

        if info.get("health") == "FAILED" or active_bad or historic:
            level = "crit"
        elif aging:
            level = "warn"
        else:
            level = "ok"

        info.update({"device": dev, "level": level,
                     "years": round(hours / 8766, 1) if hours else None})
        items.append(info)

    raids = _raid_map()
    # 单成员 raid1 是"名义冗余"，必须点出来，否则会误以为有保护
    fake_raid = [name for name, r in raids.items() if not r["redundant"]]

    bad = [i for i in items if i["level"] == "crit"]
    warn = [i for i in items if i["level"] == "warn"]
    return {
        "ok": True,
        "items": sorted(items, key=lambda x: (-(x.get("hours") or 0), x["device"])),
        "unavailable": unavailable,
        "total": len(items),
        "failing": len(bad), "aging": len(warn),
        "raids": raids,
        "no_redundancy": fake_raid,
        "warn_hours": warn_hours,
    }
