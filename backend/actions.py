"""容器操作与快照分析。

容器的启停走宿主机 docker CLI（compose 已挂 docker.sock）。注意 socket 挂成
:ro 只限制 socket 文件本身的权限，通过它照样能执行任何 docker 动作——所以
必须在这里自己做保护名单，不能指望挂载选项。

快照这边只读：存储卷都是 :ro 挂载，容器内删不掉，也不打算改成 rw。
面板没有登录，给它删快照的权限风险远大于收益，改为生成命令让人工执行。
"""
import logging
import re
import subprocess

log = logging.getLogger("homelab.actions")

# 停了就没法从面板恢复，或者会连带把防护掀掉
ALWAYS_PROTECTED = {"homelab-dashboard", "crowdsec"}

VALID_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")
ACTIONS = {"restart", "start", "stop"}


class ActionError(Exception):
    """带用户可读文案的操作失败"""


class Actions:
    def __init__(self, cfg):
        acfg = (cfg or {}).get("actions") or {}
        self.enabled = bool(acfg.get("enabled", True))
        extra = {str(x) for x in (acfg.get("protected_containers") or [])}
        self.protected = ALWAYS_PROTECTED | extra
        self.log_lines = int(acfg.get("log_lines", 200))

    def _check(self, name, action):
        if not self.enabled:
            raise ActionError("容器操作已在 config.yaml 中禁用")
        if not VALID_NAME.match(name or ""):
            raise ActionError(f"非法的容器名: {name}")
        if action not in ACTIONS:
            raise ActionError(f"不支持的动作: {action}")
        if name in self.protected and action in ("stop", "restart"):
            raise ActionError(
                f"{name} 在保护名单里，不允许从面板 {action}。"
                "它停了面板就失去控制能力，需要时请 SSH 操作")

    def container(self, name, action):
        self._check(name, action)
        try:
            out = subprocess.run(["docker", action, name],
                                 capture_output=True, text=True, timeout=90)
        except subprocess.TimeoutExpired:
            raise ActionError(f"{action} {name} 超时（90 秒）") from None
        except OSError as exc:
            raise ActionError(f"执行 docker 失败: {exc}") from None
        if out.returncode != 0:
            raise ActionError(out.stderr.strip()[:200] or f"docker {action} 失败")
        log.info("容器 %s 执行 %s", name, action)
        return {"ok": True, "container": name, "action": action,
                "output": out.stdout.strip()[:200]}

    def logs(self, name, lines=None):
        if not VALID_NAME.match(name or ""):
            raise ActionError(f"非法的容器名: {name}")
        n = max(1, min(int(lines or self.log_lines), 1000))
        try:
            out = subprocess.run(
                ["docker", "logs", "--tail", str(n), "--timestamps", name],
                capture_output=True, text=True, timeout=25)
        except subprocess.TimeoutExpired:
            raise ActionError("读取日志超时") from None
        except OSError as exc:
            raise ActionError(f"执行 docker 失败: {exc}") from None
        if out.returncode != 0:
            raise ActionError(out.stderr.strip()[:200] or "读取日志失败")
        # docker 把大部分服务日志写在 stderr，两股合并按时间看才完整
        text = (out.stdout or "") + (out.stderr or "")
        return {"ok": True, "container": name, "lines": n,
                "text": text[-60000:]}


# ---------- 快照 ----------

SNAP_TIME = re.compile(r"(20\d{2})[-_]?(\d{2})[-_]?(\d{2})[-_ T]?(\d{2})?(\d{2})?")


def _parse_when(path):
    m = SNAP_TIME.search(path)
    if not m:
        return None
    y, mo, d, h, mi = m.groups()
    return f"{y}-{mo}-{d}" + (f" {h}:{mi}" if h and mi else "")


def snapshot_plan(cfg, sections, keep=10):
    """按卷分组列出快照，标出超过保留数的那些，并给出可复制的清理命令。

    真删除有意不做：卷是只读挂载，且面板无认证。
    """
    storage = (sections.get("storage") or {}).get("data") or {}
    groups = []
    for vol in storage.get("volumes") or []:
        snaps = vol.get("snapshots")
        if not snaps:
            continue
        items = [{"path": s, "when": _parse_when(s)} for s in snaps]
        items.sort(key=lambda x: (x["when"] or "", x["path"]), reverse=True)
        stale = items[keep:]
        groups.append({
            "label": vol.get("label"), "mount": vol.get("path"),
            "total": len(items), "keep": keep,
            "recent": items[:keep], "stale": stale,
            "command": " && ".join(
                f"btrfs subvolume delete {s['path']}" for s in stale) or None,
        })
    return {"ok": True, "groups": groups,
            "note": "卷为只读挂载，面板不执行删除。复制命令到宿主机上以 root 执行"}
