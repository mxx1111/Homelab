"""服务健康探针，并发探测避免串行拖慢"""
from concurrent.futures import ThreadPoolExecutor

import httpx


def _probe(svc):
    name = svc.get("name", svc.get("url", "?"))
    url = svc.get("url")
    expect = svc.get("expect") or [200]
    verify = svc.get("verify_tls", True)
    if not url:
        return {"name": name, "ok": False, "error": "缺少 url"}
    try:
        resp = httpx.get(url, timeout=6, verify=verify, follow_redirects=False)
        healthy = resp.status_code in expect
        return {
            "name": name,
            "url": url,
            "ok": healthy,
            "status_code": resp.status_code,
            "latency_ms": round(resp.elapsed.total_seconds() * 1000, 1),
        }
    except httpx.TimeoutException:
        return {"name": name, "url": url, "ok": False, "error": "超时"}
    except Exception as exc:  # noqa: BLE001
        return {"name": name, "url": url, "ok": False, "error": type(exc).__name__}


def collect(cfg):
    services = cfg.get("services") or []
    if not services:
        return {"ok": True, "total": 0, "up": 0, "items": []}
    with ThreadPoolExecutor(max_workers=min(12, len(services))) as pool:
        items = list(pool.map(_probe, services))
    items.sort(key=lambda s: (s["ok"], s["name"]))
    up = sum(1 for s in items if s["ok"])
    return {"ok": True, "total": len(items), "up": up,
            "down": len(items) - up, "items": items}
