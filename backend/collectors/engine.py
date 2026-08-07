"""CrowdSec 引擎状态。

封禁列表回答"拦了谁"，这里回答"引擎本身在不在干活"——读了哪些日志、
解析成功率多少、哪些检测场景被触发。日志源突然归零往往意味着日志轮转后
没跟上，这种故障不看这一页根本发现不了。

数据来自 Prometheus metrics 端点（默认 127.0.0.1:6060），纯文本格式，
自己解析，不引 prometheus_client。
"""
import re

import httpx

from ..scenario_names import scenario_cn

# cs_bucket_poured_total{name="xxx",source="yyy"} 42
LINE = re.compile(r'^(?P<metric>[a-z_]+)(?:\{(?P<labels>[^}]*)\})?\s+(?P<value>[\d.eE+-]+)$')
LABEL = re.compile(r'(\w+)="([^"]*)"')

# 场景名翻成中文，crowdsecurity/ssh-bf -> SSH 暴力破解。
# 认不出的场景 scenario_cn 会退回去掉前缀的原名，不会返回空
def _short(name):
    return scenario_cn(name)


def _parse(text):
    """返回 {metric: [(labels_dict, value), ...]}"""
    out = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        m = LINE.match(line)
        if not m:
            continue
        try:
            value = float(m.group("value"))
        except ValueError:
            continue
        labels = dict(LABEL.findall(m.group("labels") or ""))
        out.setdefault(m.group("metric"), []).append((labels, value))
    return out


def _sum(series):
    return sum(v for _, v in series)


def collect(cfg):
    ccfg = (cfg or {}).get("crowdsec") or {}
    url = ccfg.get("metrics_url", "http://127.0.0.1:6060/metrics")
    try:
        resp = httpx.get(url, timeout=8)
        resp.raise_for_status()
    except httpx.RequestError as exc:
        return {"ok": False, "error": f"连不上 metrics 端点 {url}: {exc}"}
    except httpx.HTTPStatusError as exc:
        return {"ok": False, "error": f"metrics 返回 HTTP {exc.response.status_code}"}

    m = _parse(resp.text)

    # 解析成功率必须按源分开算。全局算出来是 1.7%，看着像坏了，
    # 其实是 syslog 那 4 万行系统日志本来就没有对应解析器；
    # 真正要盯的 nginx 是 100%。混在一起算这个指标就废了
    ok_by_src, ko_by_src = {}, {}
    for labels, value in m.get("cs_parser_hits_ok_total", []):
        ok_by_src[labels.get("source", "?")] = value
    for labels, value in m.get("cs_parser_hits_ko_total", []):
        ko_by_src[labels.get("source", "?")] = value

    sources = []
    for labels, value in m.get("cs_filesource_hits_total", []):
        path = labels.get("source", "?")
        ok, ko = ok_by_src.get(path, 0), ko_by_src.get(path, 0)
        total = ok + ko
        rate = round(ok / total * 100, 1) if total else None
        # 量大但一条都解析不出来，通常是配了这个源却没装对应的解析器
        wasted = rate == 0 and value >= 100
        sources.append({
            "path": path,
            "name": path.rsplit("/", 1)[-1],
            "kind": labels.get("acquis_type", "?"),
            "lines": int(value),
            "parse_ok": int(ok), "parse_ko": int(ko), "parse_rate": rate,
            "wasted": wasted,
        })
    sources.sort(key=lambda x: -x["lines"])

    # 场景：poured 是进桶的可疑事件，overflowed 是真正触发决策的
    poured, overflowed = {}, {}
    for labels, value in m.get("cs_bucket_poured_total", []):
        poured[labels.get("name", "?")] = poured.get(labels.get("name", "?"), 0) + value
    for labels, value in m.get("cs_bucket_overflowed_total", []):
        overflowed[labels.get("name", "?")] = \
            overflowed.get(labels.get("name", "?"), 0) + value

    scenarios = []
    for name in set(poured) | set(overflowed):
        scenarios.append({
            "name": name, "short": _short(name),
            "poured": int(poured.get(name, 0)),
            "overflowed": int(overflowed.get(name, 0)),
        })
    scenarios.sort(key=lambda x: (-x["overflowed"], -x["poured"]))

    parse_ok = _sum(m.get("cs_parser_hits_ok_total", []))
    parse_ko = _sum(m.get("cs_parser_hits_ko_total", []))
    # 有效源 = 至少解析出过一条的源。它们的加权解析率才是有意义的数字
    effective = [s for s in sources if s["parse_ok"] > 0]
    eff_ok = sum(s["parse_ok"] for s in effective)
    eff_total = sum(s["parse_ok"] + s["parse_ko"] for s in effective)
    rate = round(eff_ok / eff_total * 100, 1) if eff_total else None

    # 节点级：白名单命中数，能看出有多少事件被规则放过
    wl_hits = _sum(m.get("cs_node_wl_hits_total", []))

    # LAPI 被谁调用了多少次
    lapi = []
    for labels, value in m.get("cs_lapi_machine_requests_total", []):
        lapi.append({"who": labels.get("machine", "?"),
                     "route": labels.get("route", "?"),
                     "method": labels.get("method", ""),
                     "count": int(value)})
    for labels, value in m.get("cs_lapi_bouncer_requests_total", []):
        lapi.append({"who": labels.get("bouncer", "?"),
                     "route": labels.get("route", "?"),
                     "method": labels.get("method", ""),
                     "count": int(value)})
    lapi.sort(key=lambda x: -x["count"])

    active_buckets = int(_sum(m.get("cs_buckets", [])))
    alerts_gauge = int(_sum(m.get("cs_alerts", [])))

    idle = [s for s in sources if s["lines"] == 0]
    return {
        "ok": True,
        "sources": sources,
        "sources_total": sum(s["lines"] for s in sources),
        "idle_sources": [s["name"] for s in idle],
        "wasted_sources": [s["name"] for s in sources if s["wasted"]],
        "effective_sources": len(effective),
        "scenarios": scenarios,
        "scenarios_triggered": sum(1 for s in scenarios if s["overflowed"] > 0),
        "poured_total": sum(s["poured"] for s in scenarios),
        "overflowed_total": sum(s["overflowed"] for s in scenarios),
        "parse_ok": int(parse_ok), "parse_ko": int(parse_ko),
        "parse_rate": rate,
        "whitelist_hits": int(wl_hits),
        "active_buckets": active_buckets,
        "alerts_gauge": alerts_gauge,
        "lapi": lapi[:10],
    }
