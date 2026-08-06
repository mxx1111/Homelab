# 贡献指南 · Contributing

中文在前，English below.

---

## 中文

### 提 issue

**报 bug** 时请带上：

- 宿主机发行版与版本（`cat /etc/os-release`）
- 部署方式（docker compose / 直接跑）
- `docker logs homelab-dashboard` 的相关片段
- 如果和 CrowdSec 有关，附上 `cscli version` 和 `cscli metrics` 的输出

**报之前先看一眼** README 的[故障排查](README.md#故障排查)一节，大部分
「卡片显示不可用」类问题在那里有答案。

**提功能建议**时，说清楚你想解决的实际问题，而不只是想要的功能形态。
这个项目的取向是「少而准」——每加一张卡片都要能回答「它帮我在什么时候
做什么决定」。

### 提 PR

没有 CLA，没有模板要求，但请注意几点：

**代码风格**

- Python 遵循 PEP 8，行宽 88
- 前端零构建、零依赖，**请不要引入任何 npm 包或 CDN 资源**，这是刻意的约束
- 注释写「为什么」，不写「做了什么」。代码本身能说明做了什么

**新增采集器**

接口很简单，`backend/collectors/` 下新建一个模块，实现：

```python
def collect(cfg):
    """返回 dict，必须含 ok 字段。失败时返回 {"ok": False, "error": "原因"}"""
    return {"ok": True, "your_data": ...}
```

然后在 `collectors/__init__.py` 的 `REGISTRY` 里注册，在 `config.example.yaml`
的 `intervals` 里加一个间隔。前端渲染函数写在 `app.js`。

**采集器必须容错**：依赖的命令不存在、文件读不到、远程超时，都要返回
`{"ok": False, "error": ...}` 而不是抛异常。一个采集器挂掉不能影响其他卡片。

**改动涉及安全时**，在 PR 描述里说明：这个改动是否扩大了面板的权限范围？
是否引入了新的写操作？如果是，写操作是否走了 `_guard()`？

**不要提交**

- 你的真实 `config.yaml`（已在 `.gitignore`，但请再确认一次）
- 任何密钥、内网 IP、域名
- `data/` 下的历史数据库

提 PR 前跑一遍：

```bash
git grep -nE "([0-9]{1,3}\.){3}[0-9]{1,3}" -- ':!*.md'   # 检查有没有硬编码 IP
```

### 特别欢迎

- **其他 NAS 平台的适配** —— 群晖、威联通、unRAID 的路径与命令差异
- **界面英文化** —— 目前界面全中文，i18n 还没做
- **新的推送渠道** —— Telegram、Bark、Gotify、ntfy；`notify.py` 只有 60 行
- **截图** —— README 缺实际界面截图，放 `docs/screenshots/`

---

## English

### Filing issues

For **bug reports**, please include:

- Host distro and version (`cat /etc/os-release`)
- How you deployed (docker compose / bare)
- Relevant output from `docker logs homelab-dashboard`
- For CrowdSec-related issues, `cscli version` and `cscli metrics` output

**Check [Troubleshooting](README.en.md#troubleshooting) first** — most
"card says unavailable" questions are answered there.

For **feature requests**, describe the actual problem you're trying to solve
rather than just the feature you want. This project aims for "few but sharp" —
every new card has to answer "what decision does this help me make, and when".

### Pull requests

No CLA, no rigid template, but a few things:

**Style**

- Python follows PEP 8, 88-column lines
- The frontend has no build step and no dependencies. **Please don't introduce
  npm packages or CDN resources** — this is a deliberate constraint
- Comments explain *why*, not *what*. The code already says what

**Adding a collector**

Create a module under `backend/collectors/` implementing:

```python
def collect(cfg):
    """Return a dict containing `ok`. On failure: {"ok": False, "error": "reason"}"""
    return {"ok": True, "your_data": ...}
```

Register it in `REGISTRY` in `collectors/__init__.py` and add an interval to
`config.example.yaml`. Rendering goes in `app.js`.

**Collectors must be fault-tolerant**: missing commands, unreadable files, remote
timeouts must all return `{"ok": False, "error": ...}` rather than raising. One
failing collector must never blank out the others.

**If your change touches security**, say so in the PR description: does it widen
the dashboard's privileges? Does it add a write operation? If so, does that
operation go through `_guard()`?

**Never commit**

- Your real `config.yaml` (gitignored, but double-check)
- Any credentials, internal IPs or domain names
- The history database under `data/`

Before opening a PR:

```bash
git grep -nE "([0-9]{1,3}\.){3}[0-9]{1,3}" -- ':!*.md'   # look for hardcoded IPs
```

### Especially welcome

- **Other NAS platforms** — path and command differences on Synology, QNAP, unRAID
- **UI internationalization** — the interface is Chinese only; i18n isn't done yet
- **More push providers** — Telegram, Bark, Gotify, ntfy; `notify.py` is 60 lines
- **Screenshots** — the README has none; drop them in `docs/screenshots/`
