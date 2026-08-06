"""Server 酱推送。

两代接口并存，按 sendkey 前缀自动判断：
  sctp 开头  -> Server酱³   https://{uid}.push.ft07.com/send/{key}.send
  其他       -> Turbo 版    https://sctapi.ftqq.com/{key}.send
"""
import logging
import os
import re

import httpx

log = logging.getLogger("homelab.notify")

TURBO_URL = "https://sctapi.ftqq.com/{key}.send"
V3_URL = "https://{uid}.push.ft07.com/send/{key}.send"


def _endpoint(sendkey):
    m = re.match(r"^sctp(\d+)t", sendkey, re.I)
    if m:
        return V3_URL.format(uid=m.group(1), key=sendkey)
    return TURBO_URL.format(key=sendkey)


class Notifier:
    def __init__(self, cfg):
        ncfg = (cfg or {}).get("notify") or {}
        # SendKey 优先从环境变量取。config.yaml 要进版本库，密钥不能写在里面；
        # 环境变量由 compose 从 .env 注入，.env 已被 gitignore
        self.sendkey = (os.environ.get("HOMELAB_SENDKEY")
                        or str(ncfg.get("sendkey") or "")).strip()
        # 填了 key 就默认开，省得两处都要改
        self.enabled = bool(ncfg.get("enabled", bool(self.sendkey)))
        self.channel = ncfg.get("channel")          # Server 酱的通道号，可留空
        self.min_level = ncfg.get("min_level", "warn")
        if self.enabled and not self.sendkey:
            log.warning("notify.enabled 为 true 但 sendkey 为空，推送不会生效")
            self.enabled = False

    def should_send(self, level):
        order = {"info": 0, "warn": 1, "crit": 2}
        return order.get(level, 1) >= order.get(self.min_level, 1)

    def send(self, title, desp=""):
        """成功返回 None，失败返回错误文案（调用方决定是否记日志）"""
        if not self.enabled:
            return "推送未启用"
        data = {"title": title[:100], "desp": desp[:8000]}
        if self.channel:
            data["channel"] = str(self.channel)
        try:
            resp = httpx.post(_endpoint(self.sendkey), data=data, timeout=12)
        except httpx.RequestError as exc:
            return f"请求失败: {exc}"
        if resp.status_code != 200:
            return f"HTTP {resp.status_code}: {resp.text[:120]}"
        try:
            body = resp.json()
        except ValueError:
            return None
        # Turbo 版成功是 code=0，V3 是 code=0 或 data.error=SUCCESS
        code = body.get("code")
        if code not in (0, None):
            return f"Server 酱返回 code={code} {str(body.get('message'))[:100]}"
        return None
