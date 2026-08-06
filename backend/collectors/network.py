"""网卡实时速率 + 公网出口 IP"""
import time

import httpx

_prev = {}
_public_ip = {"value": None, "ts": 0}
_SKIP_PREFIX = ("lo", "docker", "br-", "veth", "tailscale", "virbr")


def _read_dev():
    stats = {}
    with open("/proc/net/dev", encoding="utf-8") as fp:
        for line in fp.readlines()[2:]:
            name, _, rest = line.partition(":")
            name = name.strip()
            if name.startswith(_SKIP_PREFIX):
                continue
            fields = rest.split()
            stats[name] = (int(fields[0]), int(fields[8]))  # rx_bytes, tx_bytes
    return stats


def _pick_interface(stats, configured):
    if configured and configured in stats:
        return configured
    if not stats:
        return None
    # 未指定则选累计流量最大的物理网卡
    return max(stats, key=lambda k: stats[k][0] + stats[k][1])


def _public_ip_cached():
    """公网 IP 变动少，缓存 10 分钟"""
    now = time.time()
    if _public_ip["value"] and now - _public_ip["ts"] < 600:
        return _public_ip["value"]
    try:
        resp = httpx.get("https://ipinfo.io/ip", timeout=6)
        if resp.status_code == 200:
            _public_ip["value"] = resp.text.strip()
            _public_ip["ts"] = now
    except Exception:  # noqa: BLE001
        pass
    return _public_ip["value"]


def collect(cfg):
    try:
        stats = _read_dev()
        iface = _pick_interface(stats, (cfg.get("network") or {}).get("interface"))
        if not iface:
            return {"ok": False, "error": "未找到可用网卡"}

        now = time.time()
        rx, tx = stats[iface]
        rx_rate = tx_rate = None
        if iface in _prev:
            prev_rx, prev_tx, prev_ts = _prev[iface]
            elapsed = now - prev_ts
            if elapsed > 0:
                rx_rate = max(0, (rx - prev_rx) / elapsed)
                tx_rate = max(0, (tx - prev_tx) / elapsed)
        _prev[iface] = (rx, tx, now)

        return {
            "ok": True,
            "interface": iface,
            "rx_bytes_per_sec": rx_rate,
            "tx_bytes_per_sec": tx_rate,
            "rx_total": rx,
            "tx_total": tx,
            "public_ip": _public_ip_cached(),
            "ts": now,
        }
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)}
