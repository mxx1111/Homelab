"""指标与事件历史。

单个 SQLite 文件，两张表：
  metrics  时序采样，按分钟写一次，多了没意义还撑大库
  events   离散事件(服务掉线、新封禁、告警)，带去重与推送标记

写入用一条后台串行队列，避免多个采集器并发写触发 SQLite 锁竞争。
"""
import json
import logging
import os
import sqlite3
import threading
import time
from queue import Empty, Queue

log = logging.getLogger("homelab.history")

SCHEMA = """
CREATE TABLE IF NOT EXISTS metrics (
    ts     INTEGER NOT NULL,
    metric TEXT    NOT NULL,
    value  REAL    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_metrics_lookup ON metrics(metric, ts);

CREATE TABLE IF NOT EXISTS events (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    ts       INTEGER NOT NULL,
    kind     TEXT    NOT NULL,
    level    TEXT    NOT NULL,
    key      TEXT    NOT NULL,
    title    TEXT    NOT NULL,
    detail   TEXT,
    notified INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts DESC);
CREATE INDEX IF NOT EXISTS idx_events_key ON events(key, ts DESC);

CREATE TABLE IF NOT EXISTS whitelist (
    ip       TEXT PRIMARY KEY,
    note     TEXT,
    added_at INTEGER NOT NULL,
    hits     INTEGER NOT NULL DEFAULT 0,
    last_hit INTEGER
);

CREATE TABLE IF NOT EXISTS audit (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    ts      INTEGER NOT NULL,
    ip      TEXT,
    method  TEXT,
    path    TEXT,
    status  INTEGER,
    ms      REAL,
    detail  TEXT,
    ua      TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit(ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_ip ON audit(ip, ts DESC);

-- 面板改的配置存这里。config.yaml 在容器里是只读挂载改不了，
-- 而且它要进版本库，不适合放运行时调整。分层：config 出默认值，这里出覆盖
CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
"""

# 采样间隔。指标本身采得比这密，但落盘按这个节流
SAMPLE_INTERVAL = 60


class History:
    def __init__(self, cfg):
        hcfg = (cfg or {}).get("history") or {}
        self.enabled = bool(hcfg.get("enabled", True))
        self.path = hcfg.get("path", "/app/data/homelab.db")
        self.retain_days = int(hcfg.get("retain_days", 90))
        self._queue = Queue(maxsize=2000)
        self._worker = None
        self._stop = threading.Event()
        self._last_sample = 0.0
        self._last_vacuum = 0.0
        self._ready = False

    # ---------- 生命周期 ----------

    def start(self):
        if not self.enabled:
            log.info("历史记录已禁用")
            return
        try:
            os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
            with self._connect() as conn:
                conn.executescript(SCHEMA)
                conn.execute("PRAGMA journal_mode=WAL")
            self._ready = True
        except (OSError, sqlite3.Error) as exc:
            log.error("历史库初始化失败 %s: %s，历史功能关闭", self.path, exc)
            self.enabled = False
            return
        self._worker = threading.Thread(target=self._run, daemon=True,
                                        name="history-writer")
        self._worker.start()
        log.info("历史库就绪: %s (保留 %d 天)", self.path, self.retain_days)

    def stop(self):
        self._stop.set()
        if self._worker:
            self._worker.join(timeout=3)

    def _connect(self):
        conn = sqlite3.connect(self.path, timeout=10)
        conn.execute("PRAGMA busy_timeout=5000")
        return conn

    # ---------- 写入 ----------

    def _run(self):
        """串行消费写队列。批量提交，减少 fsync"""
        while not self._stop.is_set():
            batch = []
            try:
                batch.append(self._queue.get(timeout=2))
            except Empty:
                self._maybe_cleanup()
                continue
            while len(batch) < 200:
                try:
                    batch.append(self._queue.get_nowait())
                except Empty:
                    break
            try:
                with self._connect() as conn:
                    for op, args in batch:
                        if op == "metric":
                            conn.execute(
                                "INSERT INTO metrics(ts,metric,value) VALUES(?,?,?)", args)
                        elif op == "event":
                            conn.execute(
                                "INSERT INTO events(ts,kind,level,key,title,detail)"
                                " VALUES(?,?,?,?,?,?)", args)
                        elif op == "audit":
                            conn.execute(
                                "INSERT INTO audit(ts,ip,method,path,status,ms,detail,ua)"
                                " VALUES(?,?,?,?,?,?,?,?)", args)
            except sqlite3.Error as exc:
                log.warning("历史写入失败: %s", exc)
            self._maybe_cleanup()

    def _maybe_cleanup(self):
        """每 6 小时清一次过期数据"""
        now = time.time()
        if now - self._last_vacuum < 21600:
            return
        self._last_vacuum = now
        cutoff = int(now - self.retain_days * 86400)
        try:
            with self._connect() as conn:
                m = conn.execute("DELETE FROM metrics WHERE ts < ?", (cutoff,)).rowcount
                e = conn.execute("DELETE FROM events WHERE ts < ?", (cutoff,)).rowcount
            if m or e:
                log.info("清理过期历史: %d 条指标, %d 条事件", m, e)
        except sqlite3.Error as exc:
            log.warning("清理历史失败: %s", exc)

    def record_metrics(self, sections):
        """从采集结果里抽指标。按 SAMPLE_INTERVAL 节流"""
        if not self._ready:
            return
        now = time.time()
        if now - self._last_sample < SAMPLE_INTERVAL:
            return
        self._last_sample = now
        ts = int(now)
        for metric, value in _extract(sections):
            try:
                self._queue.put_nowait(("metric", (ts, metric, float(value))))
            except Exception:  # noqa: BLE001  队列满了就丢这一轮，不阻塞采集
                return

    def record_event(self, kind, level, key, title, detail=None):
        if not self._ready:
            return
        try:
            self._queue.put_nowait(
                ("event", (int(time.time()), kind, level, key, title, detail)))
        except Exception:  # noqa: BLE001
            log.warning("事件队列已满，丢弃: %s", title)

    # ---------- 查询 ----------

    def series(self, metric, hours=24, points=120):
        """降采样后的时序。按桶取平均，避免把几万个点丢给前端"""
        if not self._ready:
            return []
        now = int(time.time())
        since = now - hours * 3600
        bucket = max(60, (hours * 3600) // max(points, 1))
        try:
            with self._connect() as conn:
                rows = conn.execute("""
                    SELECT (ts / ?) * ? AS slot, AVG(value), MAX(value)
                    FROM metrics WHERE metric = ? AND ts >= ?
                    GROUP BY slot ORDER BY slot
                """, (bucket, bucket, metric, since)).fetchall()
        except sqlite3.Error as exc:
            log.warning("查询 %s 失败: %s", metric, exc)
            return []
        return [{"ts": r[0], "avg": round(r[1], 2), "max": round(r[2], 2)} for r in rows]

    def metric_names(self):
        if not self._ready:
            return []
        try:
            with self._connect() as conn:
                return [r[0] for r in conn.execute(
                    "SELECT DISTINCT metric FROM metrics ORDER BY metric")]
        except sqlite3.Error:
            return []

    def events(self, limit=100, kind=None, since_hours=None):
        if not self._ready:
            return []
        sql = "SELECT ts,kind,level,key,title,detail FROM events WHERE 1=1"
        args = []
        if kind:
            sql += " AND kind = ?"
            args.append(kind)
        if since_hours:
            sql += " AND ts >= ?"
            args.append(int(time.time() - since_hours * 3600))
        sql += " ORDER BY ts DESC LIMIT ?"
        args.append(limit)
        try:
            with self._connect() as conn:
                rows = conn.execute(sql, args).fetchall()
        except sqlite3.Error:
            return []
        return [{"ts": r[0], "kind": r[1], "level": r[2], "key": r[3],
                 "title": r[4], "detail": r[5]} for r in rows]

    def last_event(self, key):
        """某个 key 最近一次事件，告警去重用"""
        if not self._ready:
            return None
        try:
            with self._connect() as conn:
                row = conn.execute(
                    "SELECT ts,level FROM events WHERE key = ? ORDER BY ts DESC LIMIT 1",
                    (key,)).fetchone()
        except sqlite3.Error:
            return None
        return {"ts": row[0], "level": row[1]} if row else None

    # 数据跨度不到这么久就不给预测。刚跑几小时的波动线性外推出来
    # "30 天写满"，纯属吓人——启动时的抖动会被放大成趋势
    MIN_SPAN_HOURS = 24

    def growth(self, metric, hours=168):
        """线性外推：按最近 hours 的增长速度，还有多久到 100。返回 None 表示不涨"""
        points = self.series(metric, hours=hours, points=64)
        if len(points) < 8:
            return None
        first, last = points[0], points[-1]
        span_h = (last["ts"] - first["ts"]) / 3600
        if span_h < self.MIN_SPAN_HOURS:
            return {"per_day": None, "days_to_full": None,
                    "span_hours": round(span_h, 1),
                    "insufficient": True}
        delta = last["avg"] - first["avg"]
        if delta <= 0.05:                       # 基本没涨，不做预测
            return {"per_day": round(delta / span_h * 24, 3), "days_to_full": None}
        per_day = delta / span_h * 24
        remaining = max(0.0, 100 - last["avg"])
        return {"per_day": round(per_day, 3),
                "days_to_full": round(remaining / per_day, 1)}

    # ---------- 运行时配置 ----------

    def get_settings(self):
        if not self._ready:
            return {}
        try:
            with self._connect() as conn:
                rows = conn.execute("SELECT key, value FROM settings").fetchall()
        except sqlite3.Error:
            return {}
        out = {}
        for k, v in rows:
            try:
                out[k] = json.loads(v)
            except (ValueError, TypeError):
                out[k] = v
        return out

    def set_setting(self, key, value):
        if not self._ready:
            raise RuntimeError("历史库未启用，配置无法持久化")
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO settings(key,value,updated_at) VALUES(?,?,?)"
                " ON CONFLICT(key) DO UPDATE SET value=excluded.value,"
                " updated_at=excluded.updated_at",
                (key, json.dumps(value, ensure_ascii=False), int(time.time())))

    def clear_setting(self, key):
        if not self._ready:
            return 0
        with self._connect() as conn:
            return conn.execute("DELETE FROM settings WHERE key=?", (key,)).rowcount

    # ---------- 访问审计 ----------

    def record_audit(self, ip, method, path, status, ms, detail=None, ua=None):
        if not self._ready:
            return
        try:
            self._queue.put_nowait(("audit", (
                int(time.time()), ip, method, path, status,
                round(ms, 1), (detail or "")[:300], (ua or "")[:200])))
        except Exception:  # noqa: BLE001
            pass

    def audit(self, limit=200, hours=None, only_failed=False):
        if not self._ready:
            return []
        sql = "SELECT ts,ip,method,path,status,ms,detail,ua FROM audit WHERE 1=1"
        args = []
        if hours:
            sql += " AND ts >= ?"
            args.append(int(time.time() - hours * 3600))
        if only_failed:
            sql += " AND status >= 400"
        sql += " ORDER BY ts DESC LIMIT ?"
        args.append(limit)
        try:
            with self._connect() as conn:
                rows = conn.execute(sql, args).fetchall()
        except sqlite3.Error:
            return []
        return [{"ts": r[0], "ip": r[1], "method": r[2], "path": r[3],
                 "status": r[4], "ms": r[5], "detail": r[6], "ua": r[7]}
                for r in rows]

    def audit_summary(self, hours=168):
        """按来源 IP 聚合。面板没有登录，能看出有没有意料之外的来源在操作"""
        if not self._ready:
            return {"enabled": False}
        since = int(time.time() - hours * 3600)
        try:
            with self._connect() as conn:
                by_ip = conn.execute("""
                    SELECT ip, COUNT(*), SUM(status >= 400), MAX(ts)
                    FROM audit WHERE ts >= ? GROUP BY ip ORDER BY COUNT(*) DESC LIMIT 20
                """, (since,)).fetchall()
                total, failed = conn.execute(
                    "SELECT COUNT(*), SUM(status >= 400) FROM audit WHERE ts >= ?",
                    (since,)).fetchone()
        except sqlite3.Error:
            return {"enabled": True, "error": "查询失败"}
        return {
            "enabled": True, "hours": hours,
            "total": total or 0, "failed": failed or 0,
            "by_ip": [{"ip": r[0], "count": r[1], "failed": r[2] or 0,
                       "last": r[3]} for r in by_ip],
        }

    # ---------- 白名单 ----------
    # 走同步写而不是队列：增删要立刻对调用方可见，不能等后台线程消化

    def whitelist(self):
        if not self._ready:
            return []
        try:
            with self._connect() as conn:
                rows = conn.execute(
                    "SELECT ip,note,added_at,hits,last_hit FROM whitelist"
                    " ORDER BY added_at DESC").fetchall()
        except sqlite3.Error:
            return []
        return [{"ip": r[0], "note": r[1], "added_at": r[2],
                 "hits": r[3], "last_hit": r[4]} for r in rows]

    def whitelist_add(self, ip, note=""):
        if not self._ready:
            raise RuntimeError("历史库未启用，白名单需要它来持久化")
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO whitelist(ip,note,added_at) VALUES(?,?,?)"
                " ON CONFLICT(ip) DO UPDATE SET note=excluded.note",
                (ip, note, int(time.time())))

    def whitelist_remove(self, ip):
        if not self._ready:
            return 0
        with self._connect() as conn:
            return conn.execute("DELETE FROM whitelist WHERE ip=?", (ip,)).rowcount

    def whitelist_hit(self, ip):
        """记一次自动解封，用来看这条白名单到底有没有在起作用"""
        if not self._ready:
            return
        try:
            with self._connect() as conn:
                conn.execute(
                    "UPDATE whitelist SET hits=hits+1, last_hit=? WHERE ip=?",
                    (int(time.time()), ip))
        except sqlite3.Error:
            pass

    def stats(self):
        if not self._ready:
            return {"enabled": False}
        try:
            with self._connect() as conn:
                metrics = conn.execute("SELECT COUNT(*) FROM metrics").fetchone()[0]
                events = conn.execute("SELECT COUNT(*) FROM events").fetchone()[0]
                oldest = conn.execute("SELECT MIN(ts) FROM metrics").fetchone()[0]
            size = os.path.getsize(self.path) if os.path.exists(self.path) else 0
        except (sqlite3.Error, OSError):
            return {"enabled": True, "error": "查询失败"}
        return {"enabled": True, "metric_rows": metrics, "event_rows": events,
                "oldest_ts": oldest, "db_bytes": size,
                "retain_days": self.retain_days}


def _extract(sections):
    """把一轮采集结果拍平成 (metric, value)。metric 命名要稳定，改名等于断历史"""
    out = []

    host = (sections.get("host") or {}).get("data") or {}
    if host.get("ok"):
        if host.get("cpu_percent") is not None:
            out.append(("cpu", host["cpu_percent"]))
        mem = host.get("memory") or {}
        if mem.get("percent") is not None:
            out.append(("mem", mem["percent"]))
        if host.get("load"):
            out.append(("load1", host["load"][0]))
        if host.get("temperature") is not None:
            out.append(("temp", host["temperature"]))

    net = (sections.get("network") or {}).get("data") or {}
    if net.get("ok"):
        if net.get("rx_bytes_per_sec") is not None:
            out.append(("net_rx", net["rx_bytes_per_sec"]))
        if net.get("tx_bytes_per_sec") is not None:
            out.append(("net_tx", net["tx_bytes_per_sec"]))

    storage = (sections.get("storage") or {}).get("data") or {}
    for vol in storage.get("volumes") or []:
        if vol.get("ok") and vol.get("percent") is not None:
            out.append((f"vol:{vol['label']}", vol["percent"]))

    svc = (sections.get("services") or {}).get("data") or {}
    if svc.get("items"):
        out.append(("svc_up", svc.get("up", 0)))
        out.append(("svc_down", svc.get("down", 0)))
        for item in svc["items"]:
            if item.get("ok") and item.get("latency_ms") is not None:
                out.append((f"svc:{item['name']}", item["latency_ms"]))

    cs = (sections.get("crowdsec") or {}).get("data") or {}
    if cs.get("active_bans") is not None:
        out.append(("bans", cs["active_bans"]))
    if cs.get("alerts_24h") is not None:
        out.append(("alerts_24h", cs["alerts_24h"]))

    # 关键 SMART 属性。单看某一时刻的值判断不了退化，
    # 落进历史才能发现"重映射扇区从 0 变成 4"这种真正要命的信号
    disks = (sections.get("disks") or {}).get("data") or {}
    for disk in disks.get("items") or []:
        dev = disk.get("device")
        if not dev:
            continue
        if disk.get("temp") is not None:
            out.append((f"disk:{dev}:temp", disk["temp"]))
        for attr, short in (("Reallocated_Sector_Ct", "realloc"),
                            ("Current_Pending_Sector", "pending"),
                            ("Reported_Uncorrect", "uncorrect")):
            if attr in (disk.get("attrs") or {}):
                out.append((f"disk:{dev}:{short}", disk["attrs"][attr]))

    ctr = (sections.get("containers") or {}).get("data") or {}
    if ctr.get("running") is not None:
        out.append(("containers_running", ctr["running"]))

    return out
