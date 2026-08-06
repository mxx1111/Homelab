"""CrowdSec 告警与封禁。

三层数据源，按可用性依次回退，容器和裸机部署都能工作：
  封禁 decisions : LAPI(HTTP) -> SQLite -> cscli
  告警 alerts    : SQLite -> cscli
LAPI 的 bouncer key 只有 decisions 权限，读不到告警明细，故告警走库。
"""
import json
import sqlite3
import subprocess
from datetime import datetime, timezone

import httpx

from ..asn_names import pretty_as

DEFAULT_DB = "/var/lib/crowdsec/data/crowdsec.db"


def _age_hours(value):
    if not value:
        return None
    try:
        if isinstance(value, str):
            dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        else:
            dt = value
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return (datetime.now(timezone.utc) - dt).total_seconds() / 3600
    except (ValueError, TypeError):
        return None


# ---------- decisions ----------

def _kind(origin):
    """把 origin 归成三类，前端据此分组：手动封的能解，社区黑名单解了会同步回来"""
    o = (origin or "").lower()
    if o in ("cscli", "cscli-import"):
        return "manual"
    if o in ("lists", "capi", "console"):
        return "community"
    return "detected"


def _until_seconds(value):
    if not value:
        return None
    delta = _age_hours(value)
    return None if delta is None else round(-delta * 3600)


def _decisions_lapi(cfg):
    ccfg = cfg.get("crowdsec") or {}
    key = ccfg.get("api_key")
    if not key:
        return None
    url = ccfg.get("lapi_url", "http://127.0.0.1:8080").rstrip("/")
    resp = httpx.get(f"{url}/v1/decisions", headers={"X-Api-Key": key}, timeout=8)
    resp.raise_for_status()
    body = resp.json() or []
    return [{
        "ip": d.get("value"),
        "reason": d.get("scenario"),
        "action": d.get("type"),
        "duration": d.get("duration"),
        "origin": d.get("origin"),
        "kind": _kind(d.get("origin")),
        "scope": d.get("scope"),
        "expires_in": None,
        "country": None,
        "as_name": None,
        "as_label": None,
    } for d in body]


def _row_to_decision(r):
    return {"ip": r[0], "reason": r[1], "action": r[2], "origin": r[3],
            "until": r[4], "expires_in": _until_seconds(r[4]), "scope": r[5],
            "kind": _kind(r[3]), "country": r[6], "as_name": r[7],
            "as_label": pretty_as(r[7])}


SELECT_DECISION = """
    SELECT d.value, d.scenario, d.type, d.origin, d.until, d.scope,
           a.source_country, a.source_as_name
    FROM decisions d LEFT JOIN alerts a ON d.alert_decisions = a.id
    WHERE (d.until IS NULL OR d.until > datetime('now'))
"""


def _decisions_db(cfg, community_limit=400):
    """社区黑名单动辄一两万条，全查会拖慢采集也撑爆前端。

    策略：手动封禁和本地检出全量返回（这两类本来就少，且是要操作的对象），
    社区黑名单只取最近一批，总数另用 COUNT 单独统计——所以面板上的数字是
    准确的，只是列表不全。
    """
    path = (cfg.get("crowdsec") or {}).get("db_path", DEFAULT_DB)
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=8)
    try:
        counts = {"manual": 0, "community": 0, "detected": 0}
        total = 0
        for origin, n in conn.execute("""
            SELECT origin, COUNT(*) FROM decisions
            WHERE until IS NULL OR until > datetime('now')
            GROUP BY origin
        """).fetchall():
            counts[_kind(origin)] = counts.get(_kind(origin), 0) + n
            total += n

        # 要操作的两类全量取
        actionable = conn.execute(
            SELECT_DECISION + " AND d.origin IN ('cscli','cscli-import','crowdsec')"
            " ORDER BY d.id DESC LIMIT 2000").fetchall()
        # 社区黑名单只取一批供浏览
        community = conn.execute(
            SELECT_DECISION + " AND d.origin NOT IN ('cscli','cscli-import','crowdsec')"
            " ORDER BY d.id DESC LIMIT ?", (community_limit,)).fetchall()
    finally:
        conn.close()

    items = [_row_to_decision(r) for r in actionable] + \
            [_row_to_decision(r) for r in community]
    return {"items": items, "counts": counts, "total": total,
            "listed": len(items),
            "truncated": counts["community"] > len(community)}


def search_decisions(cfg, query, limit=200):
    """按 IP / 场景 / ASN 直接查库。列表没全量加载，搜索必须走后端"""
    path = (cfg.get("crowdsec") or {}).get("db_path", DEFAULT_DB)
    like = f"%{query.strip()}%"
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=8)
    try:
        rows = conn.execute(
            SELECT_DECISION + """ AND (d.value LIKE ? OR d.scenario LIKE ?
                 OR a.source_as_name LIKE ? OR a.source_country LIKE ?)
            ORDER BY d.id DESC LIMIT ?""",
            (like, like, like, like, limit)).fetchall()
    finally:
        conn.close()
    return [_row_to_decision(r) for r in rows]


def _decisions_cscli():
    out = subprocess.run(["cscli", "decisions", "list", "-o", "json"],
                         capture_output=True, text=True, timeout=20)
    if out.returncode != 0:
        raise RuntimeError(out.stderr.strip()[:160] or "cscli 失败")
    body = out.stdout.strip()
    data = json.loads(body) if body and body != "null" else []
    items = []
    for alert in data:
        src = alert.get("source") or {}
        for dec in (alert.get("decisions") or []):
            items.append({"ip": dec.get("value"), "reason": dec.get("scenario"),
                          "action": dec.get("type"), "duration": dec.get("duration"),
                          "origin": dec.get("origin"), "kind": _kind(dec.get("origin")),
                          "scope": dec.get("scope"), "expires_in": None,
                          "country": src.get("cn"), "as_name": src.get("as_name"),
                          "as_label": pretty_as(src.get("as_name"))})
    return items


# ---------- alerts ----------

def _alerts_db(cfg, limit=200):
    """只取真实检出的攻击。

    alerts 表里混着三种记录，只有第一种是"有人在攻击我"：
      1. 解析器检出的攻击        source_ip 有值
      2. 社区黑名单例行更新      scenario 形如 "update : +15000/-0 IPs"，无 source_ip
      3. 面板/cscli 的手动封禁   source_ip 也是空的，IP 存在 decisions 表
    后两种混进来，界面上会显示成一排问号，"24 小时告警数"也会虚高好几倍。
    手动封禁在封禁列表里查得到，黑名单更新数量单独统计，都不必挤在攻击列表里。
    """
    path = (cfg.get("crowdsec") or {}).get("db_path", DEFAULT_DB)
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=5)
    try:
        rows = conn.execute("""
            SELECT id, created_at, scenario, source_ip, source_country,
                   source_as_name, events_count
            FROM alerts
            WHERE source_ip IS NOT NULL AND source_ip != ''
            ORDER BY id DESC LIMIT ?
        """, (limit,)).fetchall()
    finally:
        conn.close()
    items = []
    for r in rows:
        age = _age_hours(r[1])
        items.append({"id": r[0], "created_at": r[1], "scenario": r[2],
                      "ip": r[3], "country": r[4], "as_name": r[5],
                      "events_count": r[6],
                      "age_hours": round(age, 2) if age is not None else None})
    return items


def _alerts_cscli(limit=200):
    out = subprocess.run(["cscli", "alerts", "list", "--limit", str(limit), "-o", "json"],
                         capture_output=True, text=True, timeout=20)
    if out.returncode != 0:
        raise RuntimeError(out.stderr.strip()[:160] or "cscli 失败")
    body = out.stdout.strip()
    data = json.loads(body) if body and body != "null" else []
    items = []
    for a in data:
        src = a.get("source") or {}
        if not src.get("value"):          # 与 SQLite 路径口径一致，见 _alerts_db
            continue
        age = _age_hours(a.get("created_at"))
        items.append({"id": a.get("id"), "created_at": a.get("created_at"),
                      "scenario": a.get("scenario"), "ip": src.get("value"),
                      "country": src.get("cn"), "as_name": src.get("as_name"),
                      "events_count": a.get("events_count"),
                      "age_hours": round(age, 2) if age is not None else None})
    return items


def _by_country(alerts):
    """按国家聚合告警。同时统计独立 IP 数——10 次告警来自 1 个 IP，
    和来自 10 个 IP，是完全不同的两回事"""
    tally = {}
    for a in alerts:
        code = (a.get("country") or "").strip().upper() or "??"
        slot = tally.setdefault(code, {"code": code, "count": 0, "ips": set()})
        slot["count"] += 1
        if a.get("ip"):
            slot["ips"].add(a["ip"])
    out = [{"code": v["code"], "count": v["count"], "ips": len(v["ips"])}
           for v in tally.values()]
    out.sort(key=lambda x: (-x["count"], x["code"]))
    return out[:12]


def _by_asn(alerts):
    tally = {}
    for a in alerts:
        name = (a.get("as_name") or "").strip()
        if not name:
            continue
        slot = tally.setdefault(name, {"as_name": name, "count": 0,
                                       "country": a.get("country"), "ips": set()})
        slot["count"] += 1
        if a.get("ip"):
            slot["ips"].add(a["ip"])
    out = [{"as_name": v["as_name"], "as_label": pretty_as(v["as_name"]),
            "count": v["count"], "country": v["country"],
            "ips": len(v["ips"])} for v in tally.values()]
    out.sort(key=lambda x: -x["count"])
    return out[:8]


def _first_ok(sources):
    """依次尝试，返回 (结果, 使用的源名, 错误列表)"""
    errors = []
    for name, fn in sources:
        try:
            result = fn()
            if result is not None:
                return result, name, errors
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{name}: {str(exc)[:80]}")
    return None, None, errors


def collect(cfg):
    result = {"ok": True, "decisions": [], "alerts": [],
              "active_bans": 0, "alerts_24h": 0}

    decisions, src, errs = _first_ok([
        ("lapi", lambda: _decisions_lapi(cfg)),
        ("sqlite", lambda: _decisions_db(cfg)),
        ("cscli", _decisions_cscli),
    ])
    if decisions is None:
        result["decisions_error"] = "; ".join(errs) or "无可用数据源"
    else:
        # SQLite 源返回带精确计数的字典，LAPI/cscli 源只有列表，退化为按列表计数
        if isinstance(decisions, dict):
            result["decisions"] = decisions["items"]
            result["active_bans"] = decisions["total"]
            result["ban_counts"] = decisions["counts"]
            result["listed"] = decisions["listed"]
            result["truncated"] = decisions["truncated"]
        else:
            counts = {"manual": 0, "community": 0, "detected": 0}
            for d in decisions:
                k = d.get("kind", "detected")
                counts[k] = counts.get(k, 0) + 1
            result["decisions"] = decisions
            result["active_bans"] = len(decisions)
            result["ban_counts"] = counts
            result["listed"] = len(decisions)
            result["truncated"] = False
        result["decisions_source"] = src

    alerts, src, errs = _first_ok([
        ("sqlite", lambda: _alerts_db(cfg)),
        ("cscli", _alerts_cscli),
    ])
    if alerts is None:
        result["alerts_error"] = "; ".join(errs) or "无可用数据源"
    else:
        result["alerts"] = alerts
        result["alerts_source"] = src
        result["alerts_24h"] = sum(
            1 for a in alerts if a["age_hours"] is not None and a["age_hours"] <= 24)

        # 攻击来源 TOP，前端画分布用
        tally = {}
        for a in alerts:
            ip = a.get("ip")
            if not ip:
                continue
            slot = tally.setdefault(ip, {"ip": ip, "count": 0,
                                         "country": a.get("country"),
                                         "as_name": a.get("as_name"),
                                         "scenarios": set()})
            slot["count"] += 1
            if a.get("scenario"):
                slot["scenarios"].add(a["scenario"].split("/")[-1])
        top = sorted(tally.values(), key=lambda x: -x["count"])[:8]
        for slot in top:
            slot["scenarios"] = sorted(slot["scenarios"])
        result["top_sources"] = top
        result["by_country"] = _by_country(alerts)
        result["by_asn"] = _by_asn(alerts)

    if "decisions_error" in result and "alerts_error" in result:
        result["ok"] = False
        result["error"] = result["decisions_error"]
    return result
