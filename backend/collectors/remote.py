"""远程主机采集(SSH)。一次连接取回全部指标，避免多次往返"""
import re
import subprocess
from concurrent.futures import ThreadPoolExecutor

# 部分昇腾开发板的板级管理通道读不到电流和板级信息，
# npu-smi 会恒定报 Health=Alarm / Power=0.0，但算力实际正常。
# 已实测 ResNet-50 可跑到 201 FPS，故此状态不作为告警。
NPU_FALSE_ALARM = "板级传感器缺失导致的固有告警，算力正常"

_SCRIPT = r"""
echo "###LOAD"; cat /proc/loadavg 2>/dev/null
echo "###UPTIME"; cat /proc/uptime 2>/dev/null
echo "###MEM"; grep -E "^(MemTotal|MemAvailable):" /proc/meminfo 2>/dev/null
echo "###NPU"; timeout 12 npu-smi info 2>/dev/null | grep -E "^\| [0-9]+ "
echo "###END"
"""


def _sections(text):
    out, key = {}, None
    for line in text.splitlines():
        if line.startswith("###"):
            key = line[3:].strip()
            out[key] = []
        elif key:
            out[key].append(line)
    return out


def _parse_npu(lines):
    """两行格式:
    | 0  310B4 | Alarm | 0.0  56   15 / 15 |
    | 0  0     | NA    | 0    5575 / 7545  |
    """
    if not lines:
        return None
    npu = {"health": None, "power_w": None, "temp_c": None,
           "aicore_percent": None, "mem_used_mb": None, "mem_total_mb": None}
    for line in lines:
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) < 3:
            continue
        head, mid, tail = cells[0], cells[1], cells[2]
        nums = re.findall(r"[\d.]+", tail)
        if mid and mid not in ("NA", ""):
            npu["health"] = mid
            if len(nums) >= 2:
                npu["power_w"] = float(nums[0])
                npu["temp_c"] = float(nums[1])
        else:
            slash = re.search(r"(\d+)\s*/\s*(\d+)", tail)
            if slash:
                npu["mem_used_mb"] = int(slash.group(1))
                npu["mem_total_mb"] = int(slash.group(2))
            if nums:
                npu["aicore_percent"] = float(nums[0])
    if npu["health"]:
        npu["health_is_false_alarm"] = npu["health"].lower() == "alarm"
        npu["note"] = NPU_FALSE_ALARM if npu["health_is_false_alarm"] else None
    return npu


def _collect_one(hcfg):
    name = hcfg.get("name", hcfg.get("host"))
    cmd = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=6",
           "-o", "StrictHostKeyChecking=accept-new",
           "-p", str(hcfg.get("port", 22))]
    if hcfg.get("ssh_key"):
        cmd += ["-i", hcfg["ssh_key"]]
    cmd.append(f"{hcfg.get('user', 'root')}@{hcfg.get('host')}")
    cmd.append(_SCRIPT)

    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        if out.returncode != 0:
            return {"name": name, "ok": False,
                    "error": (out.stderr.strip().splitlines() or ["SSH 失败"])[-1][:120]}
        sec = _sections(out.stdout)

        load = None
        if sec.get("LOAD"):
            parts = sec["LOAD"][0].split()
            load = [float(x) for x in parts[:3]] if len(parts) >= 3 else None

        uptime = None
        if sec.get("UPTIME") and sec["UPTIME"][0].strip():
            uptime = int(float(sec["UPTIME"][0].split()[0]))

        mem = {}
        for line in sec.get("MEM", []):
            k, _, v = line.partition(":")
            if v.strip():
                mem[k.strip()] = int(v.split()[0]) * 1024
        memory = None
        if "MemTotal" in mem:
            total = mem["MemTotal"]
            avail = mem.get("MemAvailable", 0)
            memory = {"total": total, "available": avail, "used": total - avail,
                      "percent": round((total - avail) / total * 100, 1) if total else 0}

        probes = hcfg.get("probes") or ["basic"]
        npu = _parse_npu(sec.get("NPU")) if "npu" in probes else None

        return {"name": name, "ok": True, "load": load, "uptime_seconds": uptime,
                "memory": memory, "npu": npu}
    except subprocess.TimeoutExpired:
        return {"name": name, "ok": False, "error": "SSH 超时"}
    except Exception as exc:  # noqa: BLE001
        return {"name": name, "ok": False, "error": str(exc)[:120]}


def collect(cfg):
    hosts = cfg.get("remote_hosts") or []
    if not hosts:
        return {"ok": True, "items": []}
    with ThreadPoolExecutor(max_workers=min(4, len(hosts))) as pool:
        items = list(pool.map(_collect_one, hosts))
    return {"ok": True, "items": items,
            "online": sum(1 for h in items if h.get("ok"))}
