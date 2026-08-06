# 安全策略 · Security Policy

中文在前，English below.

---

## 中文

### 先读这一段

这个面板**没有登录体系**，并且能修改防火墙、操作 Docker 容器。它的设计前提是
**只在可信内网或 VPN 中访问**。

如果你把它直接暴露到公网，那不是漏洞，是配置错误——就像把没有密码的 Redis
开在 0.0.0.0 上一样。请先读 README 的[安全须知](README.md#安全须知)。

### 内置的防护边界

| 机制 | 作用 |
|---|---|
| 写操作默认拒绝 | 未配置 `write_token` 时，所有写接口返回 403 |
| 受保护网段 | 内网、回环、Tailscale CGNAT 段不可封禁，防止自锁 |
| 只读挂载 | 除 `./data` 外全部只读，面板无法修改宿主机文件 |
| 无 privileged | 只用 `SYS_ADMIN`（btrfs ioctl）和 `SYS_RAWIO`（SMART） |
| 快照不真删 | 只生成命令，由你在宿主机上执行 |
| 操作审计 | 所有写操作记录来源 IP、路径、结果、耗时 |

### 报告漏洞

**请不要开公开 issue**——那等于把利用方法公之于众，而使用者还没来得及升级。

请走 GitHub 的私密报告通道：仓库页面 → **Security** → **Report a vulnerability**。
这条通道只有维护者可见，修复前不会公开。

请包含：

- 漏洞类型与影响范围
- 复现步骤
- 你认为的严重程度，以及理由
- 如果有，修复建议

我会在 **72 小时内**确认收到，并在修复后于 release notes 中致谢（除非你
希望匿名）。

### 什么算漏洞

**算**

- 绕过 `write_token` 执行写操作
- 通过面板读取到不该暴露的宿主机文件
- 命令注入、路径穿越（尤其是容器操作与快照命令生成那两处）
- 受保护网段的封禁保护被绕过
- 审计日志可被伪造或绕过

**不算**

- 「面板没有登录所以任何人都能看」—— 这是已知设计，见上文
- 「暴露到公网后被攻击」—— 配置错误，不是漏洞
- 需要宿主机 root 权限才能利用的问题 —— 有 root 就已经赢了
- 依赖库的漏洞（请直接报给上游，但欢迎提 PR 升级版本）

### 依赖

后端依赖见 `requirements.txt`，前端**零依赖**——没有 npm 包，没有 CDN 引用，
不存在供应链风险。这是刻意的设计约束。

---

## English

### Read this first

This dashboard has **no authentication** and can modify your firewall and control
Docker containers. It is designed to be reachable **only from a trusted LAN or
VPN**.

Exposing it directly to the internet is not a vulnerability, it's a
misconfiguration — comparable to running Redis on 0.0.0.0 with no password.
Please read [Security notes](README.en.md#security-notes) first.

### Built-in boundaries

| Mechanism | Effect |
|---|---|
| Writes refused by default | Without `write_token`, every write endpoint returns 403 |
| Protected networks | Private, loopback and Tailscale ranges can't be banned — no self-lockout |
| Read-only mounts | Everything except `./data` is read-only; the panel can't modify host files |
| No privileged | Only `SYS_ADMIN` (btrfs ioctl) and `SYS_RAWIO` (SMART) |
| Snapshots not really deleted | A command is generated for you to run on the host |
| Operation audit | Every write records source IP, path, result and duration |

### Reporting a vulnerability

**Please do not open a public issue** — that publishes the exploit before
anyone has had a chance to upgrade.

Use GitHub's private reporting: repository page → **Security** →
**Report a vulnerability**. Only maintainers can see it, and it stays private
until fixed.

Please include:

- Vulnerability class and impact
- Reproduction steps
- Your severity assessment and reasoning
- A suggested fix, if you have one

I'll acknowledge within **72 hours** and credit you in the release notes once
fixed, unless you prefer to stay anonymous.

### What counts

**In scope**

- Bypassing `write_token` to perform write operations
- Reading host files that shouldn't be exposed through the panel
- Command injection or path traversal (particularly container operations and
  snapshot command generation)
- Bypassing the protected-network ban guard
- Forging or evading the audit log

**Out of scope**

- "There's no login so anyone can view it" — known design, see above
- "I exposed it to the internet and got attacked" — misconfiguration
- Anything requiring host root to exploit — root already wins
- Dependency CVEs (report upstream; PRs bumping versions are welcome)

### Dependencies

Backend dependencies are in `requirements.txt`. The frontend has **zero
dependencies** — no npm packages, no CDN references, no supply-chain surface.
That's a deliberate constraint.
