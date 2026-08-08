"""CrowdSec 告警与封禁。

三层数据源，按可用性依次回退，容器和裸机部署都能工作：
  封禁 decisions : LAPI(HTTP) -> SQLite -> cscli
  告警 alerts    : SQLite -> cscli
LAPI 的 bouncer key 只有 decisions 权限，读不到告警明细，故告警走库。
"""
import json
import os
import re
import sqlite3
import subprocess
import threading
from datetime import datetime, timezone

import geoip2.database
from geoip2.errors import AddressNotFoundError
import httpx

from ..asn_names import pretty_as
from ..scenario_names import scenario_cn

DEFAULT_DB = "/var/lib/crowdsec/data/crowdsec.db"
DEFAULT_CITY_DB = "/var/lib/crowdsec/data/GeoLite2-City.mmdb"

_city_lock = threading.Lock()
_city_reader = None
_city_reader_key = None
_city_cache = {}

_PROVINCE_NAMES = {
    "河北", "山西", "辽宁", "吉林", "黑龙江", "江苏", "浙江", "安徽", "福建",
    "江西", "山东", "河南", "湖北", "湖南", "广东", "海南", "四川", "贵州",
    "云南", "陕西", "甘肃", "青海", "台湾",
}
_AUTONOMOUS_REGIONS = {
    "内蒙古": "内蒙古自治区", "广西": "广西壮族自治区", "西藏": "西藏自治区",
    "宁夏": "宁夏回族自治区", "新疆": "新疆维吾尔自治区",
}


def _localized_name(record):
    names = getattr(record, "names", None) or {}
    return names.get("zh-CN") or names.get("zh") or getattr(record, "name", None)


def _complete_china_place(subdivision_name, city_name):
    subdivision = str(subdivision_name or "").strip()
    city = str(city_name or "").strip()
    if subdivision in _PROVINCE_NAMES:
        subdivision += "省"
    elif subdivision in ("北京", "上海", "天津", "重庆"):
        subdivision += "市"
    else:
        subdivision = _AUTONOMOUS_REGIONS.get(subdivision, subdivision)
    if (city and city not in ("北京", "上海", "天津", "重庆") and
            not city.endswith(("市", "州", "盟", "地区", "县", "区", "旗"))):
        city += "市"
    elif city in ("北京", "上海", "天津", "重庆"):
        city += "市"
    return subdivision, city


def _join_place(country_code, country_name, subdivision_name, city_name):
    """把 GeoLite2 的多级名称整理成完整中文地名，避免“广东省深圳市深圳市”。"""
    if country_code == "CN":
        subdivision_name, city_name = _complete_china_place(subdivision_name, city_name)
    parts = []
    if country_code not in ("CN", "HK", "MO", "TW") and country_name:
        parts.append(country_name)
    elif country_code in ("HK", "MO", "TW") and country_name:
        parts.append(country_name)
    for name in (subdivision_name, city_name):
        name = str(name or "").strip()
        if not name:
            continue
        if any(name == old or name in old or old in name for old in parts):
            continue
        parts.append(name)
    return "".join(parts) or country_name or None


def _city_db_reader(cfg):
    global _city_reader, _city_reader_key, _city_cache
    crowdsec = (cfg or {}).get("crowdsec") or {}
    db_path = crowdsec.get("db_path") or DEFAULT_DB
    path = crowdsec.get("geoip_city_db") or os.path.join(os.path.dirname(db_path),
                                                          "GeoLite2-City.mmdb")
    try:
        stat = os.stat(path)
    except OSError:
        return None
    key = (path, stat.st_mtime_ns, stat.st_size)
    if _city_reader is not None and _city_reader_key == key:
        return _city_reader
    if _city_reader is not None:
        _city_reader.close()
    _city_reader = geoip2.database.Reader(path, locales=["zh-CN", "en"])
    _city_reader_key = key
    _city_cache = {}
    return _city_reader


def _location_name(ip, cfg):
    if not ip:
        return None
    with _city_lock:
        if ip in _city_cache:
            return _city_cache[ip]
        reader = _city_db_reader(cfg)
        if reader is None:
            return None
        try:
            response = reader.city(ip)
            country = _localized_name(response.country)
            subdivision = _localized_name(response.subdivisions.most_specific)
            city = _localized_name(response.city)
            value = _join_place(response.country.iso_code, country, subdivision, city)
        except (AddressNotFoundError, ValueError, OSError):
            value = None
        if len(_city_cache) >= 5000:
            _city_cache.clear()
        _city_cache[ip] = value
        return value


def _enrich_alerts(alerts, cfg):
    for item in alerts or []:
        item["as_label"] = pretty_as(item.get("as_name"))
        item["location_name"] = _location_name(item.get("ip"), cfg)
    return alerts


def _machine_label(machine_id):
    """把 machine_id 变成人能看懂的名字。

    CrowdSec 安装时自动注册的 machine_id 是 32 位 hex 加一段随机后缀，
    像 9b931413...LEmbALk0MXN5ll9O，摆在告警列表里没有任何信息量。
    手工注册的（cscli lapi register --machine szch）才是有意义的名字。

    自动生成的那个必然是本机安装时留下的——远程节点得手工 register 才能进来，
    所以直接显示"本机"，比截断一串 hex 强。
    """
    if not machine_id:
        return None
    if len(machine_id) > 32 and machine_id.isalnum():
        return "本机"
    return machine_id


_NANO = re.compile(r"(\.\d{6})\d+")


def _age_hours(value):
    if not value:
        return None
    try:
        if isinstance(value, str):
            # machines.last_heartbeat / bouncers.last_pull 带纳秒（9 位小数），
            # fromisoformat 只吃 3 位或 6 位，多出来的直接抛 ValueError，
            # 心跳就会永远显示"未知"。截到微秒再解析。
            dt = datetime.fromisoformat(_NANO.sub(r"\1", value).replace("Z", "+00:00"))
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
        "reason_cn": scenario_cn(d.get("scenario")),
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
    return {"ip": r[0], "reason": r[1], "reason_cn": scenario_cn(r[1]),
            "action": r[2], "origin": r[3],
            "until": r[4], "expires_in": _until_seconds(r[4]), "scope": r[5],
            "kind": _kind(r[3]), "country": r[6], "as_name": r[7],
            "as_label": pretty_as(r[7]), "machine": _machine_label(r[8])}


SELECT_DECISION = """
    SELECT d.value, d.scenario, d.type, d.origin, d.until, d.scope,
           a.source_country, a.source_as_name, m.machine_id
    FROM decisions d LEFT JOIN alerts a ON d.alert_decisions = a.id
                     LEFT JOIN machines m ON a.machine_alerts = m.id
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
                          "reason_cn": scenario_cn(dec.get("scenario")),
                          "action": dec.get("type"), "duration": dec.get("duration"),
                          "origin": dec.get("origin"), "kind": _kind(dec.get("origin")),
                          "scope": dec.get("scope"), "expires_in": None,
                          "country": src.get("cn"), "as_name": src.get("as_name"),
                          "as_label": pretty_as(src.get("as_name"))})
    return items


# ---------- nodes ----------

def _seconds_ago(value):
    h = _age_hours(value)
    return None if h is None else round(h * 3600)


def _nodes_db(cfg):
    """接入这个 LAPI 的机器清单。

    agent 和 bouncer 要分开看，它们坏的方式不一样：
      agent 停了   —— 不再产生新告警，机器等于没在监测，但已有封禁还在拦
      bouncer 停了 —— 决策落不了地，规则停在最后一次拉取的状态，新攻击者进得来
    只盯其中一个会漏掉另一半。

    两者靠 IP 关联——CrowdSec 没有"节点"这个概念，machines 和 bouncers 是
    两张互不相干的表，同一台机器上的 agent 和 bouncer 各自独立注册。
    IP 对不上的（比如面板自己那个只读 key）单独列出来，不硬凑。
    """
    path = (cfg.get("crowdsec") or {}).get("db_path", DEFAULT_DB)
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=5)
    try:
        machines = conn.execute("""
            SELECT machine_id, ip_address, version, last_heartbeat,
                   is_validated, osname, osversion
            FROM machines ORDER BY machine_id
        """).fetchall()
        bouncers = conn.execute("""
            SELECT name, ip_address, type, last_pull, revoked, version
            FROM bouncers WHERE revoked = 0
        """).fetchall()
    finally:
        conn.close()

    by_ip = {}
    for name, ip, btype, last_pull, _revoked, ver in bouncers:
        by_ip.setdefault(ip or "", []).append({
            "name": name, "type": btype, "version": ver,
            "pull_seconds": _seconds_ago(last_pull),
        })

    nodes, claimed = [], set()
    for mid, ip, ver, hb, validated, osname, osver in machines:
        bs = by_ip.get(ip or "", [])
        if ip:
            claimed.add(ip)
        nodes.append({
            "name": _machine_label(mid), "machine_id": mid, "ip": ip,
            "version": (ver or "").split("-")[0] or None,
            "os": f"{osname}/{osver}" if osname else None,
            "heartbeat_seconds": _seconds_ago(hb),
            "validated": bool(validated),
            "bouncers": bs,
        })

    # 没有对应 agent 的 bouncer：可能是只读集成（面板自己的 key），
    # 也可能是某台机器的 agent 掉了而 bouncer 还活着——后者要看得见
    orphans = [b for ip, lst in by_ip.items() if ip not in claimed for b in lst]
    return {"nodes": nodes, "orphan_bouncers": orphans}


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
        # CrowdSec 新版 alerts 表带 GeoLite2-City 的经纬度。旧版库没有这两列，
        # 用 NULL 兼容，避免为了地图把整个告警采集器弄挂。
        columns = {r[1] for r in conn.execute("PRAGMA table_info(alerts)")}
        lat_col = "a.source_latitude" if "source_latitude" in columns else "NULL"
        lon_col = "a.source_longitude" if "source_longitude" in columns else "NULL"
        # 关联 machines 是为了知道这条告警是哪台机器检出的。多机接入同一个
        # 中央 LAPI 后，所有节点的告警都落在这一张表里，不带来源就分不清
        # "谁在被打"
        rows = conn.execute(f"""
            SELECT a.id, a.created_at, a.scenario, a.source_ip, a.source_country,
                   a.source_as_name, a.events_count, {lat_col}, {lon_col}, m.machine_id
            FROM alerts a LEFT JOIN machines m ON a.machine_alerts = m.id
            WHERE a.source_ip IS NOT NULL AND a.source_ip != ''
            ORDER BY a.id DESC LIMIT ?
        """, (limit,)).fetchall()
    finally:
        conn.close()
    items = []
    for r in rows:
        age = _age_hours(r[1])
        items.append({"id": r[0], "created_at": r[1], "scenario": r[2],
                      "scenario_cn": scenario_cn(r[2]),
                      "ip": r[3], "country": r[4], "as_name": r[5],
                      "events_count": r[6], "latitude": r[7], "longitude": r[8],
                      "machine": _machine_label(r[9]),
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
                      "scenario": a.get("scenario"),
                      "scenario_cn": scenario_cn(a.get("scenario")),
                      "ip": src.get("value"),
                      "country": src.get("cn"), "as_name": src.get("as_name"),
                      "latitude": src.get("latitude"),
                      "longitude": src.get("longitude"),
                      "events_count": a.get("events_count"),
                      "machine": _machine_label(a.get("machine_id")),
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
        alerts = _enrich_alerts(alerts, cfg)
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
                                         "scenarios": set(), "machines": set()})
            slot["count"] += 1
            if a.get("scenario"):
                slot["scenarios"].add(scenario_cn(a["scenario"]))
            if a.get("machine"):
                slot["machines"].add(a["machine"])
        top = sorted(tally.values(), key=lambda x: -x["count"])[:8]
        for slot in top:
            slot["scenarios"] = sorted(slot["scenarios"])
            # 同一个 IP 打了多台，说明是扫全网的，不是冲着某台来的
            slot["machines"] = sorted(slot["machines"])
        result["top_sources"] = top
        result["by_country"] = _by_country(alerts)
        result["by_asn"] = _by_asn(alerts)

        # 按机器分：哪台被打得最凶。只有一台时前端不显示这一块
        per_machine = {}
        for a in alerts:
            name = a.get("machine")
            if not name:
                continue
            slot = per_machine.setdefault(name, {"machine": name, "count": 0,
                                                 "recent": 0, "ips": set()})
            slot["count"] += 1
            if a.get("age_hours") is not None and a["age_hours"] <= 24:
                slot["recent"] += 1
            if a.get("ip"):
                slot["ips"].add(a["ip"])
        result["by_machine"] = sorted(
            [{"machine": v["machine"], "count": v["count"],
              "recent": v["recent"], "ips": len(v["ips"])}
             for v in per_machine.values()], key=lambda x: -x["count"])

    # 节点清单单独失败不影响主数据——多机是增量能力，
    # 拿不到就退回单机视图，不该让整个面板报错
    try:
        result.update(_nodes_db(cfg))
    except Exception as exc:  # noqa: BLE001
        result["nodes_error"] = str(exc)[:120]

    if "decisions_error" in result and "alerts_error" in result:
        result["ok"] = False
        result["error"] = result["decisions_error"]
    return result
