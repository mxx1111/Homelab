"""面板登录。

为什么单机时不需要、多机时必须有：单机面板被人打开，最坏是看到这台机器的
状态、封几个 IP。接了多节点之后，同一个页面能操作全部机器的防火墙，
再往后还会持有各节点的 SSH 密钥——一个无认证页面等于把整套基础设施的
控制权挂在网上。这是性质变化，不是程度变化。

刻意做得很小：单用户、内存 session、失败限速。不做 RBAC、不做多用户、
不做找回密码——单人自建，那些只会变成需要维护的攻击面。

session 存内存，重启即失效。这不是缺陷：面板本来就是单实例，
重启后重新登录一次的代价，换来"不需要持久化会话密钥"这件事，划算。
"""
import base64
import hashlib
import hmac
import logging
import os
import secrets
import threading
import time

log = logging.getLogger("homelab.auth")

COOKIE = "homelab_session"
ALGO = "pbkdf2_sha256"
ITERATIONS = 240_000          # OWASP 2023 对 PBKDF2-HMAC-SHA256 的建议下限


def hash_password(password, salt=None, iterations=ITERATIONS):
    """生成 pbkdf2_sha256$迭代次数$盐$摘要 格式的口令散列"""
    salt = salt or base64.b64encode(os.urandom(16)).decode()
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), iterations)
    return f"{ALGO}${iterations}${salt}${base64.b64encode(dk).decode()}"


def verify_password(password, stored):
    """校验。stored 可以是散列，也可以是明文——明文时降级为直接比较。

    支持明文不是偷懒：不支持的话，用户第一次配置就得先去命令行跑个脚本
    生成散列，很多人会因此干脆不开登录。允许明文 + 启动时提醒，
    比"要么正确配置要么不设防"更可能让人真的把它打开。
    """
    if not stored:
        return False
    if not stored.startswith(ALGO + "$"):
        return hmac.compare_digest(password, stored)
    try:
        _algo, iters, salt, _digest = stored.split("$", 3)
        return hmac.compare_digest(hash_password(password, salt, int(iters)), stored)
    except (ValueError, TypeError):
        return False


class Auth:
    def __init__(self, cfg):
        acfg = (cfg or {}).get("auth") or {}
        self.username = str(acfg.get("username") or "").strip()
        self.password = str(acfg.get("password") or "")
        # 用户名密码都填了才算开启。少填一个就当没配，而不是用空口令放行
        self.enabled = bool(acfg.get("enabled", True)) and bool(self.username and self.password)
        self.session_hours = float(acfg.get("session_hours", 168))
        self.max_fails = int(acfg.get("max_fails", 5))
        self.lock_minutes = float(acfg.get("lock_minutes", 15))
        self._sessions = {}       # token -> 过期时间戳
        self._fails = {}          # ip -> (失败次数, 锁定到什么时候)
        self._lock = threading.Lock()

    @property
    def plaintext(self):
        return self.enabled and not self.password.startswith(ALGO + "$")

    # ---------- 失败限速 ----------

    def locked_for(self, ip):
        """还要锁多少秒，0 表示没锁"""
        with self._lock:
            _n, until = self._fails.get(ip, (0, 0))
        return max(0, round(until - time.time()))

    def _record_fail(self, ip):
        with self._lock:
            n, until = self._fails.get(ip, (0, 0))
            if until and until < time.time():   # 锁已过期，重新计数
                n = 0
            n += 1
            if n >= self.max_fails:
                until = time.time() + self.lock_minutes * 60
                log.warning("登录失败 %d 次，锁定 %s %g 分钟", n, ip, self.lock_minutes)
                n = 0
            self._fails[ip] = (n, until)

    def _clear_fail(self, ip):
        with self._lock:
            self._fails.pop(ip, None)

    # ---------- 会话 ----------

    def login(self, username, password, ip):
        """成功返回 token，失败返回 None。调用方负责区分"锁定中"和"密码错" """
        ok = (hmac.compare_digest(username or "", self.username)
              and verify_password(password or "", self.password))
        if not ok:
            self._record_fail(ip)
            return None
        self._clear_fail(ip)
        token = secrets.token_urlsafe(32)
        with self._lock:
            self._prune()
            self._sessions[token] = time.time() + self.session_hours * 3600
        log.info("登录成功: %s from %s", username, ip)
        return token

    def logout(self, token):
        with self._lock:
            self._sessions.pop(token or "", None)

    def valid(self, token):
        if not token:
            return False
        with self._lock:
            exp = self._sessions.get(token)
            if exp is None:
                return False
            if exp < time.time():
                self._sessions.pop(token, None)
                return False
        return True

    def _prune(self):
        """顺手清过期会话。会话数很少，不值得单开清理线程"""
        now = time.time()
        for t in [t for t, exp in self._sessions.items() if exp < now]:
            self._sessions.pop(t, None)

    @property
    def active_sessions(self):
        with self._lock:
            self._prune()
            return len(self._sessions)
