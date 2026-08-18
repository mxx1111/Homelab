"""告警推送模块。

支持推送渠道：
  - Server 酱 (provider: serverchan 或默认)：
      sctp 开头  -> Server酱³   https://{uid}.push.ft07.com/send/{key}.send
      其他       -> Turbo 版    https://sctapi.ftqq.com/{key}.send
  - ntfy (provider: ntfy)：
      HTTP POST 请求到 topic URL，支持自建或 ntfy.sh，可选 Bearer Token 认证。
"""
import base64
import logging
import os
import re
from typing import Optional

import httpx

log = logging.getLogger("homelab.notify")

TURBO_URL = "https://sctapi.ftqq.com/{key}.send"
V3_URL = "https://{uid}.push.ft07.com/send/{key}.send"


def _endpoint(sendkey: str) -> str:
    m = re.match(r"^sctp(\d+)t", sendkey, re.I)
    if m:
        return V3_URL.format(uid=m.group(1), key=sendkey)
    return TURBO_URL.format(key=sendkey)


def _encode_rfc2047(text: str) -> str:
    """HTTP 规范要求 Header 为 ASCII；中文等非 ASCII 字符使用 RFC 2047 Base64 编码。"""
    try:
        text.encode("ascii")
        return text
    except UnicodeEncodeError:
        encoded = base64.b64encode(text.encode("utf-8")).decode("ascii")
        return f"=?UTF-8?B?{encoded}?="


class Notifier:
    def __init__(self, cfg):
        ncfg = (cfg or {}).get("notify") or {}
        self.provider = str(ncfg.get("provider") or "serverchan").strip().lower()

        # Server 酱配置
        # SendKey 优先从环境变量取。config.yaml 要进版本库，密钥不能写在里面；
        # 环境变量由 compose 从 .env 注入，.env 已被 gitignore
        self.sendkey = (os.environ.get("HOMELAB_SENDKEY")
                        or str(ncfg.get("sendkey") or "")).strip()
        self.channel = ncfg.get("channel")          # Server 酱的通道号，可留空

        # ntfy 配置
        # topic_url / url: 如 https://ntfy.sh/my-topic 或自建实例 URL
        self.ntfy_url = (os.environ.get("HOMELAB_NTFY_URL")
                         or str(ncfg.get("ntfy_url") or ncfg.get("url") or "")).strip()
        # token 优先从环境变量 HOMELAB_NTFY_TOKEN 读取，避免敏感凭据进版本库
        self.ntfy_token = (os.environ.get("HOMELAB_NTFY_TOKEN")
                           or str(ncfg.get("ntfy_token") or ncfg.get("token") or "")).strip()

        # 判断是否启用
        if self.provider == "ntfy":
            has_credentials = bool(self.ntfy_url)
        else:
            has_credentials = bool(self.sendkey)

        self.enabled = bool(ncfg.get("enabled", has_credentials))
        self.min_level = ncfg.get("min_level", "warn")

        if self.enabled and not has_credentials:
            if self.provider == "ntfy":
                log.warning("notify.enabled 为 true 但 ntfy_url 为空，推送不会生效")
            else:
                log.warning("notify.enabled 为 true 但 sendkey 为空，推送不会生效")
            self.enabled = False

    def should_send(self, level: str) -> bool:
        order = {"info": 0, "warn": 1, "crit": 2}
        return order.get(level, 1) >= order.get(self.min_level, 1)

    def send(self, title: str, desp: str = "") -> Optional[str]:
        """成功返回 None，失败返回错误文案（调用方决定是否记日志）"""
        if not self.enabled:
            return "推送未启用"

        if self.provider == "ntfy":
            return self._send_ntfy(title, desp)
        return self._send_serverchan(title, desp)

    def _send_serverchan(self, title: str, desp: str) -> Optional[str]:
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

    def _send_ntfy(self, title: str, desp: str) -> Optional[str]:
        headers = {
            "Title": _encode_rfc2047(title[:100]),
        }
        if self.ntfy_token:
            headers["Authorization"] = f"Bearer {self.ntfy_token}"
        try:
            resp = httpx.post(
                self.ntfy_url,
                content=desp[:8000].encode("utf-8"),
                headers=headers,
                timeout=12,
            )
        except httpx.RequestError as exc:
            return f"请求失败: {exc}"
        if resp.status_code not in (200, 201, 202, 204):
            return f"HTTP {resp.status_code}: {resp.text[:120]}"
        return None
