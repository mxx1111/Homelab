import logging
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Body, FastAPI, Header, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .actions import ActionError, Actions, snapshot_plan
from .alerts import AlertEngine
from .cache import Store
from .collectors import REGISTRY
from . import demo
from .collectors.crowdsec import search_decisions
from .config import CONFIG, CONFIG_PATH
from .firewall import DURATIONS, FirewallError, LapiClient, Whitelist
from .history import History
from .notify import Notifier

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("homelab")

FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"
STARTED_AT = time.time()

history = History(CONFIG)
notifier = Notifier(CONFIG)
alert_engine = AlertEngine(CONFIG, history, notifier)
lapi = LapiClient(CONFIG)
whitelist = Whitelist(CONFIG, history, lapi)
DEMO = demo.enabled(CONFIG)
# 演示模式换掉整个采集器注册表：真实采集器一个都不会被调用，
# 容器里也就不需要挂载任何宿主机路径
store = Store(demo.REGISTRY if DEMO else REGISTRY, CONFIG, history=history,
              alerts=alert_engine, whitelist=whitelist)
actions = Actions(CONFIG)

FIREWALL_CFG = CONFIG.get("firewall") or {}
FIREWALL_ENABLED = bool(FIREWALL_CFG.get("enabled", True))
WRITE_TOKEN = str(FIREWALL_CFG.get("write_token") or "")
# 没配令牌时默认拒绝所有写操作。面板能封 IP、能重启容器，而它自己没有登录体系，
# "不配就放行"等于给每个把它反代出去的人留一个无认证的 root 后门。
# 只读功能不受影响；确实在可信内网里图省事，才显式打开这个开关
ALLOW_ANON_WRITE = bool(FIREWALL_CFG.get("allow_anonymous_write", False))


@asynccontextmanager
async def lifespan(_app: FastAPI):
    log.info("配置文件: %s", CONFIG_PATH)
    log.info("防火墙写操作: %s | 容器操作: %s | 推送: %s",
             "开" if FIREWALL_ENABLED else "关",
             "开" if actions.enabled else "关",
             "开" if notifier.enabled else "关")
    if DEMO:
        log.warning("演示模式：全部采集器返回仿真数据，不读取宿主机任何信息；"
                    "写操作落在内存沙盒，每 %d 分钟重置", demo.RESET_SECONDS // 60)
    if WRITE_TOKEN:
        log.info("写操作认证: 需令牌")
    elif ALLOW_ANON_WRITE:
        log.warning("写操作认证: 已关闭（allow_anonymous_write）。"
                    "任何能访问本面板的人都可以封禁 IP 和操作容器，"
                    "确保它只暴露在可信网络里")
    else:
        log.info("写操作认证: 已锁定（未配置 write_token，写接口一律 403）")
    history.start()
    if DEMO:
        seeded = demo.seed_history(history)
        if seeded:
            log.info("演示模式：已播种 %d 条历史采样（过去 7 天）", seeded)
    await store.start()
    yield
    await store.stop()
    history.stop()


app = FastAPI(title="Homelab Dashboard", version="0.4.0",
              docs_url="/api/docs", lifespan=lifespan)


# GET 不记：面板每 5 秒轮询一次 /api/summary，全记下来一天几万条，
# 有用的写操作反而被埋掉。首页访问按 IP 每小时记一条，够看"谁在用面板"
AUDIT_METHODS = {"POST", "PUT", "PATCH", "DELETE"}
_last_visit = {}


def _client_ip(request: Request):
    """面板可能被反代，优先取 X-Forwarded-For 的第一跳"""
    xff = request.headers.get("x-forwarded-for")
    if xff:
        ip = xff.split(",")[0].strip()
    else:
        ip = request.headers.get("x-real-ip") or (
            request.client.host if request.client else "?")
    # 演示实例是公开的，审计页人人可见。记完整 IP 等于把每个访客的地址
    # 展示给所有其他访客——他们并没有同意这件事。掩掉后半段，
    # 既能演示"审计能区分不同来源"，又不泄漏到个人
    return demo.mask_ip(ip) if DEMO else ip


@app.middleware("http")
async def audit_middleware(request: Request, call_next):
    started = time.perf_counter()
    response = await call_next(request)
    elapsed = (time.perf_counter() - started) * 1000
    path = request.url.path

    if request.method in AUDIT_METHODS and path.startswith("/api/"):
        history.record_audit(_client_ip(request), request.method, path,
                             response.status_code, elapsed,
                             ua=request.headers.get("user-agent"))
    elif path == "/" and request.method == "GET":
        ip = _client_ip(request)
        now = time.time()
        if now - _last_visit.get(ip, 0) > 3600:
            _last_visit[ip] = now
            history.record_audit(ip, "GET", "/", response.status_code, elapsed,
                                 detail="打开面板",
                                 ua=request.headers.get("user-agent"))
    return response


def _guard(request: Request, token: str | None, what="写操作"):
    """写操作的统一前置检查"""
    who = request.client.host if request.client else "?"
    if not WRITE_TOKEN:
        if ALLOW_ANON_WRITE:
            return
        log.warning("拒绝来自 %s 的%s：未配置 write_token", who, what)
        raise HTTPException(
            status_code=403,
            detail="写操作已锁定。在 config.yaml 的 firewall.write_token 填一串随机字符，"
                   "或在可信内网里设 allow_anonymous_write: true")
    if token != WRITE_TOKEN:
        log.warning("拒绝来自 %s 的%s：token 不匹配", who, what)
        raise HTTPException(status_code=401, detail="缺少或错误的操作令牌")


@app.get("/api/health")
def health():
    return {"ok": True, "uptime_seconds": int(time.time() - STARTED_AT),
            "config_path": CONFIG_PATH}


@app.get("/api/summary")
def summary():
    snap = store.snapshot()
    snap["alerts"] = alert_engine.snapshot()
    snap["site_name"] = alert_engine.site_name
    if DEMO:
        if demo.SANDBOX.maybe_reset():
            # 告警规则存在 SQLite 里，不在内存沙盒中，得单独清
            history.clear_setting("alert_rules")
            history.clear_setting("muted")
            alert_engine.reload_settings()
            log.info("演示沙盒已重置")
        snap["demo"] = True
    return JSONResponse(snap)


@app.get("/api/section/{name}")
def section(name: str):
    data = store.section(name)
    if data is None:
        raise HTTPException(status_code=404, detail=f"未知采集器: {name}")
    return JSONResponse(data)


# ---------- 历史 ----------

@app.get("/api/history/series")
def history_series(metric: str = Query(...), hours: int = Query(24, ge=1, le=2160),
                   points: int = Query(120, ge=10, le=600)):
    return {"metric": metric, "hours": hours,
            "points": history.series(metric, hours, points)}

@app.get("/api/history/multi")
def history_multi(metrics: str = Query(...), hours: int = Query(24, ge=1, le=2160),
                  points: int = Query(120, ge=10, le=600)):
    """一次取多条曲线，前端画一屏图只发一个请求"""
    names = [m.strip() for m in metrics.split(",") if m.strip()][:12]
    return {"hours": hours,
            "series": {m: history.series(m, hours, points) for m in names}}


@app.get("/api/history/metrics")
def history_metrics():
    return {"metrics": history.metric_names(), "stats": history.stats()}


@app.get("/api/history/events")
def history_events(limit: int = Query(100, ge=1, le=500),
                   kind: str | None = None, hours: int | None = None):
    return {"events": history.events(limit=limit, kind=kind, since_hours=hours)}


@app.get("/api/history/growth")
def history_growth(hours: int = Query(168, ge=24, le=2160)):
    """各存储卷的增长速度与预计写满时间"""
    out = {}
    storage_sec = (store.section("storage") or {}).get("data") or {}
    for vol in storage_sec.get("volumes") or []:
        if vol.get("ok") and vol.get("label"):
            out[vol["label"]] = history.growth(f"vol:{vol['label']}", hours)
    return {"hours": hours, "volumes": out}


# ---------- 防火墙 ----------

@app.get("/api/firewall/meta")
def firewall_meta():
    return {
        "enabled": FIREWALL_ENABLED,
        "token_required": bool(WRITE_TOKEN),
        # 前端据此提示"写操作被锁"，而不是让用户点了按钮才吃一个 403
        "write_locked": not WRITE_TOKEN and not ALLOW_ANON_WRITE,
        "durations": [{"value": k, "label": v} for k, v in DURATIONS.items()],
        "protected_networks": lapi.protected,
        "actions_enabled": actions.enabled,
        "protected_containers": sorted(actions.protected),
        "notify_enabled": notifier.enabled,
        "whitelist_enabled": whitelist.enabled,
    }


@app.get("/api/firewall/search")
def firewall_search(q: str = Query(..., min_length=1),
                    limit: int = Query(200, ge=1, le=1000)):
    """封禁列表没有全量下发给前端(社区黑名单上万条)，搜索直接查库"""
    if DEMO:
        return {"query": q, "items": demo.search(q, limit)}
    try:
        return {"query": q, "items": search_decisions(CONFIG, q, limit)}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(exc)[:200]) from None


# ---------- 白名单 ----------

@app.get("/api/firewall/whitelist")
def whitelist_list():
    return {"enabled": whitelist.enabled, "items": whitelist.entries(),
            "recent_released": store.last_released[-20:]}


@app.post("/api/firewall/whitelist")
async def whitelist_add(request: Request, payload: dict = Body(...),
                        x_panel_token: str | None = Header(default=None)):
    _guard(request, x_panel_token, "加白名单")
    try:
        result = whitelist.add(payload.get("ip"), payload.get("note") or "")
    except FirewallError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
    log.info("加入白名单 %s", result["ip"])
    history.record_event("whitelist", "info", f"whitelist-add:{result['ip']}",
                         f"加入白名单 {result['ip']}",
                         payload.get("note") or None)
    if result.get("released"):
        await store.refresh("crowdsec")
    return result


@app.delete("/api/firewall/whitelist/{ip:path}")
def whitelist_remove(ip: str, request: Request,
                     x_panel_token: str | None = Header(default=None)):
    _guard(request, x_panel_token, "移除白名单")
    try:
        result = whitelist.remove(ip)
    except FirewallError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
    log.info("移出白名单 %s", ip)
    history.record_event("whitelist", "info", f"whitelist-del:{ip}",
                         f"移出白名单 {ip}", None)
    return result


@app.post("/api/firewall/ban")
async def firewall_ban(request: Request, payload: dict = Body(...),
                       x_panel_token: str | None = Header(default=None)):
    if not FIREWALL_ENABLED:
        raise HTTPException(status_code=403, detail="防火墙写操作已在 config.yaml 中禁用")
    _guard(request, x_panel_token, "封禁")
    try:
        result = lapi.ban(payload.get("ip"), payload.get("duration") or "4h",
                          payload.get("reason") or "")
    except FirewallError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
    log.info("封禁 %s %s", result["ip"], result["duration"])
    history.record_event("ban", "warn", f"ban:{result['ip']}",
                         f"手动封禁 {result['ip']}",
                         f"{result['duration_label']} {result.get('reason') or ''}")
    await store.refresh("crowdsec")
    return result


@app.post("/api/firewall/unban")
async def firewall_unban(request: Request, payload: dict = Body(...),
                         x_panel_token: str | None = Header(default=None)):
    if not FIREWALL_ENABLED:
        raise HTTPException(status_code=403, detail="防火墙写操作已在 config.yaml 中禁用")
    _guard(request, x_panel_token, "解封")
    try:
        result = lapi.unban(payload.get("ip"))
    except FirewallError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
    log.info("解封 %s，移除 %d 条决策", result["ip"], result["removed"])
    history.record_event("ban", "info", f"unban:{result['ip']}",
                         f"解封 {result['ip']}", f"移除 {result['removed']} 条决策")
    await store.refresh("crowdsec")
    return result


# ---------- 容器操作 ----------

@app.post("/api/containers/{name}/{action}")
async def container_action(name: str, action: str, request: Request,
                           x_panel_token: str | None = Header(default=None)):
    _guard(request, x_panel_token, f"容器{action}")
    try:
        result = actions.container(name, action)
    except ActionError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
    history.record_event("action", "info", f"container:{name}",
                         f"容器 {name} 执行 {action}", None)
    await store.refresh("containers")
    return result


@app.get("/api/containers/{name}/logs")
def container_logs(name: str, lines: int = Query(200, ge=1, le=1000)):
    try:
        return actions.logs(name, lines)
    except ActionError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None


# ---------- 快照 ----------

@app.get("/api/snapshots")
def snapshots(keep: int = Query(10, ge=1, le=200)):
    if DEMO:
        return demo.snapshots()
    return snapshot_plan(CONFIG, store.snapshot().get("sections") or {}, keep=keep)


# ---------- 告警 ----------

# ---------- 审计 ----------

@app.get("/api/audit")
def audit_log(limit: int = Query(200, ge=1, le=1000),
              hours: int | None = None, failed: bool = False):
    return {"items": history.audit(limit=limit, hours=hours, only_failed=failed),
            "summary": history.audit_summary(hours or 168)}


@app.get("/api/alerts")
def alerts_now():
    return alert_engine.snapshot()


@app.get("/api/alerts/settings")
def alerts_settings():
    return alert_engine.settings_view()


@app.put("/api/alerts/settings")
def alerts_settings_update(request: Request, payload: dict = Body(...),
                           x_panel_token: str | None = Header(default=None)):
    _guard(request, x_panel_token, "改告警规则")
    try:
        alert_engine.update_rules(payload.get("rules") or {},
                                  payload.get("global") or {})
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
    log.info("告警规则已更新")
    history.record_event("config", "info", "alert-rules", "告警规则已修改", None)
    return alert_engine.settings_view()


@app.post("/api/alerts/mute")
def alerts_mute(request: Request, payload: dict = Body(...),
                x_panel_token: str | None = Header(default=None)):
    """忽略某条告警。硬盘服役年限这类不会自愈的告警，提醒一次就够了"""
    _guard(request, x_panel_token, "忽略告警")
    key = (payload.get("key") or "").strip()
    if not key:
        raise HTTPException(status_code=400, detail="缺少 key")
    hours = payload.get("hours")
    try:
        until = alert_engine.mute(key, float(hours) if hours else None)
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
    history.record_event("config", "info", f"mute:{key}", f"忽略告警 {key}",
                         f"{hours} 小时" if hours else "永久")
    return {"ok": True, "key": key, "until": until or None}


@app.delete("/api/alerts/mute/{key:path}")
def alerts_unmute(key: str, request: Request,
                  x_panel_token: str | None = Header(default=None)):
    _guard(request, x_panel_token, "恢复告警")
    if not alert_engine.unmute(key):
        raise HTTPException(status_code=400, detail=f"{key} 不在忽略列表")
    history.record_event("config", "info", f"unmute:{key}", f"恢复告警 {key}", None)
    return {"ok": True, "key": key}


@app.post("/api/alerts/test")
def alerts_test(request: Request, x_panel_token: str | None = Header(default=None)):
    """发一条测试推送，验证 Server 酱配置是否正确"""
    _guard(request, x_panel_token, "测试推送")
    if not notifier.enabled:
        raise HTTPException(
            status_code=400,
            detail="推送未启用。在 config.yaml 的 notify 段填 sendkey 并设 enabled: true")
    err = notifier.send(f"[{alert_engine.site_name}] 测试推送",
                        "如果你收到这条，说明 Server 酱配置正确。\n\n"
                        f"时间 {time.strftime('%Y-%m-%d %H:%M:%S')}")
    if err:
        raise HTTPException(status_code=400, detail=err)
    return {"ok": True, "message": "已发送，检查你的 Server 酱通道"}


@app.get("/")
def index():
    page = FRONTEND_DIR / "index.html"
    if not page.exists():
        raise HTTPException(status_code=404, detail="前端未构建")
    return FileResponse(page)


if FRONTEND_DIR.exists():
    app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")
