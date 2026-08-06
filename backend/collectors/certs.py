"""TLS 证书到期检查"""
import re
import subprocess
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

_SUBJECT = re.compile(r"subject=.*?CN\s*=\s*([^,\n/]+)")
_ISSUER = re.compile(r"issuer=.*?CN\s*=\s*([^,\n/]+)")
_NOT_AFTER = re.compile(r"notAfter=(.+)")


def _check(target, warn_days, crit_days):
    host = target.get("host")
    port = target.get("port", 443)
    label = f"{host}:{port}"
    try:
        raw = subprocess.run(
            ["openssl", "s_client", "-connect", f"{host}:{port}",
             "-servername", host, "-verify_return_error"],
            input="", capture_output=True, text=True, timeout=15,
        )
        chain_ok = "Verify return code: 0 (ok)" in raw.stdout
        info = subprocess.run(
            ["openssl", "x509", "-noout", "-subject", "-issuer", "-dates"],
            input=raw.stdout, capture_output=True, text=True, timeout=10,
        ).stdout
        if not info.strip():
            return {"target": label, "ok": False, "error": "无法读取证书"}

        not_after = _NOT_AFTER.search(info)
        expires_at = days_left = None
        if not_after:
            dt = datetime.strptime(not_after.group(1).strip(), "%b %d %H:%M:%S %Y %Z")
            dt = dt.replace(tzinfo=timezone.utc)
            expires_at = dt.isoformat()
            days_left = (dt - datetime.now(timezone.utc)).days

        level = "ok"
        if days_left is not None:
            if days_left <= crit_days:
                level = "crit"
            elif days_left <= warn_days:
                level = "warn"

        subject = _SUBJECT.search(info)
        issuer = _ISSUER.search(info)
        return {
            "target": label,
            "ok": True,
            "subject": subject.group(1).strip() if subject else None,
            "issuer": issuer.group(1).strip() if issuer else None,
            "expires_at": expires_at,
            "days_left": days_left,
            "chain_valid": chain_ok,
            "level": level,
        }
    except subprocess.TimeoutExpired:
        return {"target": label, "ok": False, "error": "连接超时"}
    except Exception as exc:  # noqa: BLE001
        return {"target": label, "ok": False, "error": str(exc)[:120]}


def collect(cfg):
    ccfg = cfg.get("certs") or {}
    targets = ccfg.get("targets") or []
    if not targets:
        return {"ok": True, "items": [], "level": "ok"}
    warn = ccfg.get("warn_days", 30)
    crit = ccfg.get("crit_days", 7)
    with ThreadPoolExecutor(max_workers=min(6, len(targets))) as pool:
        items = list(pool.map(lambda t: _check(t, warn, crit), targets))
    items.sort(key=lambda c: (c.get("days_left") is None, c.get("days_left", 9999)))

    level = "ok"
    for c in items:
        if c.get("level") == "crit" or not c.get("ok"):
            level = "crit"
            break
        if c.get("level") == "warn":
            level = "warn"
    return {"ok": True, "items": items, "level": level}
