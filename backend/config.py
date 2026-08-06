import os
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent

SEARCH_PATHS = [
    os.environ.get("HOMELAB_CONFIG"),
    "/etc/homelab-dashboard/config.yaml",
    str(ROOT / "config.yaml"),
    # 兜底：刚 clone 下来还没建 config.yaml 时也能起得来，先看到界面再配
    str(ROOT / "config.example.yaml"),
]


def load_config():
    for path in SEARCH_PATHS:
        if path and os.path.isfile(path):
            with open(path, encoding="utf-8") as fp:
                return yaml.safe_load(fp) or {}, path
    raise FileNotFoundError("未找到 config.yaml，可用 HOMELAB_CONFIG 指定路径")


CONFIG, CONFIG_PATH = load_config()


def get(path, default=None):
    """按 a.b.c 取配置值"""
    node = CONFIG
    for key in path.split("."):
        if not isinstance(node, dict) or key not in node:
            return default
        node = node[key]
    return node
