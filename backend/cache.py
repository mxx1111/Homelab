"""采集调度与缓存。

每个采集器独立循环，互不阻塞：慢的(storage 扫快照)不会拖住快的(network)。
前端只读缓存，永远不等待采集完成。
"""
import asyncio
import logging
import time

log = logging.getLogger("homelab.cache")

DEFAULT_INTERVALS = {
    "host": 10, "network": 5, "containers": 15, "services": 60,
    "crowdsec": 30, "storage": 300, "certs": 3600, "remote": 60,
    "ports": 120, "connections": 15, "engine": 60, "disks": 1800,
}

# 落历史与评估告警的节奏。history 内部还有一层按分钟的节流
POST_INTERVAL = 30


class Store:
    def __init__(self, registry, cfg, history=None, alerts=None, whitelist=None):
        self._registry = registry
        self._cfg = cfg
        self._intervals = {**DEFAULT_INTERVALS, **(cfg.get("intervals") or {})}
        self._data = {}
        self._tasks = []
        self._lock = asyncio.Lock()
        self._history = history
        self._alerts = alerts
        self._whitelist = whitelist
        self.last_released = []

    def snapshot(self):
        """返回全部缓存。附带每项的采集时间与耗时，便于排查数据是否新鲜"""
        return {
            "generated_at": time.time(),
            "sections": {k: v for k, v in self._data.items()},
        }

    def section(self, name):
        return self._data.get(name)

    async def _run_once(self, name, fn):
        started = time.perf_counter()
        loop = asyncio.get_running_loop()
        try:
            data = await loop.run_in_executor(None, fn, self._cfg)
            payload = {
                "data": data,
                "collected_at": time.time(),
                "duration_ms": round((time.perf_counter() - started) * 1000, 1),
                "error": None,
            }
        except Exception as exc:  # noqa: BLE001
            log.warning("采集器 %s 失败: %s", name, exc)
            previous = self._data.get(name, {})
            payload = {
                "data": previous.get("data"),          # 保留上次成功的数据
                "collected_at": previous.get("collected_at"),
                "duration_ms": round((time.perf_counter() - started) * 1000, 1),
                "error": str(exc)[:200],
            }
        async with self._lock:
            self._data[name] = payload

    async def refresh(self, name):
        """立即重采一次。封禁/解封后调用，避免等到下一个轮询周期才看到变化"""
        fn = self._registry.get(name)
        if fn is None:
            return False
        await self._run_once(name, fn)
        return True

    async def _loop(self, name, fn, interval):
        while True:
            await self._run_once(name, fn)
            await asyncio.sleep(interval)

    async def _post_loop(self):
        """落历史 + 评估告警。单独一条循环，不跟着采集器的节奏跑。

        两者都是同步阻塞的（SQLite 写、推送 HTTP），丢到线程池里执行，
        否则会卡住整个事件循环。
        """
        loop = asyncio.get_running_loop()
        while True:
            await asyncio.sleep(POST_INTERVAL)
            snapshot = dict(self._data)
            try:
                if self._history:
                    await loop.run_in_executor(None, self._history.record_metrics, snapshot)
                if self._alerts:
                    await loop.run_in_executor(None, self._alerts.process, snapshot)
                if self._whitelist:
                    decisions = ((snapshot.get("crowdsec") or {}).get("data")
                                 or {}).get("decisions") or []
                    released = await loop.run_in_executor(
                        None, self._whitelist.enforce, decisions)
                    if released:
                        self.last_released = released
                        for r in released:
                            log.info("白名单放行 %s (命中 %s)", r["ip"], r["rule"])
                            if self._history:
                                self._history.record_event(
                                    "whitelist", "info", f"whitelist:{r['ip']}",
                                    f"白名单放行 {r['ip']}",
                                    f"命中规则 {r['rule']}，来源 {r.get('origin') or '?'}")
                        await self._run_once("crowdsec", self._registry["crowdsec"])
            except Exception as exc:  # noqa: BLE001  后处理不能影响采集
                log.warning("后处理失败: %s", exc)

    async def start(self):
        # 先同步跑一轮，保证首个请求就有数据
        await asyncio.gather(*(self._run_once(n, f) for n, f in self._registry.items()))
        for name, fn in self._registry.items():
            interval = self._intervals.get(name, 60)
            self._tasks.append(asyncio.create_task(self._loop(name, fn, interval)))
        if self._history or self._alerts or self._whitelist:
            self._tasks.append(asyncio.create_task(self._post_loop()))
        log.info("已启动 %d 个采集器", len(self._registry))

    async def stop(self):
        for task in self._tasks:
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks.clear()
