"""告警推送模块。

支持两个 provider：
  - serverchan (默认): Server 酱（支持 Turbo 与 V3 接口自动判断）
  - ntfy: ntfy 推送服务（支持公网/自建 topic 与可选 Token 鉴权）
"""
import logging
import os
import re

import httpx

log = logging.getLogger("homelab.notify")

TURBO_URL = "https://sctapi.ftqq.com/{key}.send"
V3_URL = "https://{uid}.push.ft07.com/send/{key}.send"


def _serverchan_endpoint(sendkey):
    m = re.match(r"^sctp(\d+)t", sendkey, re.I)
    if m:
        return V3_URL.format(uid=m.group(1), key=sendkey)
    return TURBO_URL.format(key=sendkey)


class Notifier:
    def __init__(self, cfg):
        ncfg = (cfg or {}).get("notify") or {}
        self.provider = str(ncfg.get("provider") or "serverchan").strip().lower()
        self.min_level = ncfg.get("min_level", "warn")

        # Server 酱配置
        self.sendkey = (os.environ.get("HOMELAB_SENDKEY")
                        or str(ncfg.get("sendkey") or "")).strip()
        self.channel = ncfg.get("channel")          # Server 酱的通道号，可留空

        # ntfy 配置
        self.ntfy_url = (os.environ.get("HOMELAB_NTFY_URL")
                         or str(ncfg.get("url") or "")).strip()
        self.ntfy_token = (os.environ.get("HOMELAB_NTFY_TOKEN")
                           or str(ncfg.get("token") or "")).strip()

        # enabled 判断：优先读取显式 enabled，未配置则根据对应 provider 的密钥/地址自动判断
        if "enabled" in ncfg and ncfg["enabled"] is not None:
            self.enabled = bool(ncfg["enabled"])
        else:
            if self.provider == "ntfy":
                self.enabled = bool(self.ntfy_url)
            else:
                self.enabled = bool(self.sendkey)

        if self.enabled:
            if self.provider == "ntfy" and not self.ntfy_url:
                log.warning("notify.enabled 为 true 但 ntfy url 为空，推送不会生效")
                self.enabled = False
            elif self.provider != "ntfy" and not self.sendkey:
                log.warning("notify.enabled 为 true 但 sendkey 为空，推送不会生效")
                self.enabled = False

    def should_send(self, level):
        order = {"info": 0, "warn": 1, "crit": 2}
        return order.get(level, 1) >= order.get(self.min_level, 1)

    def _send_serverchan(self, title, desp=""):
        data = {"title": title[:100], "desp": desp[:8000]}
        if self.channel:
            data["channel"] = str(self.channel)
        try:
            resp = httpx.post(_serverchan_endpoint(self.sendkey), data=data, timeout=12)
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

    def _send_ntfy(self, title, desp=""):
        headers = {}
        if title:
            # ntfy 支持 utf-8 编码的 Title 头部
            headers["Title"] = title[:100].encode("utf-8")
        if self.ntfy_token:
            headers["Authorization"] = f"Bearer {self.ntfy_token}"

        body = (desp or "").encode("utf-8")
        try:
            resp = httpx.post(self.ntfy_url, content=body, headers=headers, timeout=12)
        except httpx.RequestError as exc:
            return f"请求失败: {exc}"
        if resp.status_code < 200 or resp.status_code >= 300:
            return f"HTTP {resp.status_code}: {resp.text[:120]}"
        return None

    def send(self, title, desp=""):
        """成功返回 None，失败返回错误文案（调用方决定是否记日志）"""
        if not self.enabled:
            return "推送未启用"
        if self.provider == "ntfy":
            return self._send_ntfy(title, desp)
        return self._send_serverchan(title, desp)
