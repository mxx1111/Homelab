# Homelab Dashboard

家庭基础设施总览面板。把散落在各处的状态收进一屏：安全告警、存储容量、服务健康、
主机负载、网络速率、证书到期、端口暴露面、Docker 容器、硬盘 SMART。

不只是看：能封禁 IP、重启容器、按趋势预测磁盘写满时间，异常时主动推送到手机。

## 为什么不用 Grafana

Grafana 强在时序曲线，弱在"一屏卡片式概览"，也做不了一键封 IP 这类交互。
这个面板的目标是**打开就知道家里一切是否正常**，出事的时候还能直接动手。

## 架构

```
采集器(9 个，各自独立循环) ─┬─ 内存缓存 ─→ FastAPI ─→ 前端(5 秒轮询)
                            ├─ SQLite   历史指标与事件，保留 90 天
                            └─ 告警引擎 ─→ Server 酱 ─→ 手机
```

关键设计：**采集与请求解耦**。慢采集（btrfs 扫快照要几秒、SSH 到远程主机要 1 秒）
在后台按自己的节奏跑，前端只读缓存，永远不等待。某个采集器失败时保留上一次的
成功数据，不会让整块卡片变空。

落历史和评估告警走单独一条循环（30 秒一轮），不跟着采集器节奏；两者都是阻塞操作
（SQLite 写、推送 HTTP），丢到线程池执行，不会卡住事件循环。

## 数据来源

| 采集器 | 来源 | 默认间隔 |
|---|---|---|
| host | /proc/stat、/proc/meminfo、/sys/class/thermal | 10s |
| network | /proc/net/dev 差值采样 | 5s |
| containers | docker ps / docker stats | 15s |
| services | HTTP 探针（并发） | 60s |
| crowdsec | cscli alerts / decisions | 30s |
| storage | statvfs + btrfs subvolume list | 300s |
| certs | openssl s_client | 3600s |
| remote | SSH 一次取回 load/mem/npu-smi | 60s |
| ports | /proc/net/{tcp,udp} + docker ps + 放行脚本(可选) | 120s |

## 快速开始

**前置条件**

- Linux 宿主机（要读 `/proc`、`/sys`、`mdstat`，不支持 macOS/Windows）
- Docker 与 docker compose
- 可选：[CrowdSec](https://www.crowdsec.net/) — 装了才有防火墙、封禁、攻击来源
  那几块；没装的话面板照常跑，相关卡片显示不可用
- 可选：`smartctl` — 硬盘 SMART 监控需要，宿主机装 `smartmontools` 即可

**在宿主机上直接起**

```bash
git clone <仓库地址> && cd homelab-dashboard
cp config.example.yaml config.yaml    # 按自己的环境改：卷、服务、域名
docker compose up -d --build
```

打开 `http://<主机地址>:8770`。

`docker-compose.yml` 里挂载了不少宿主机路径（Docker socket、CrowdSec 数据库、
`/dev`、根分区只读），并加了 `SYS_ADMIN` / `SYS_RAWIO` 两个 capability。
**部署前请逐条看一遍**，用不到的功能把对应挂载删掉即可，面板会自动降级。

**写操作默认是锁死的。** 面板能封 IP、能重启容器，却没有登录体系，所以未配置
`firewall.write_token` 时写接口一律返回 403。要用这些功能，在 `config.yaml` 里
填一串随机字符（前端会多出令牌输入框），或者在确认它只暴露于可信内网时设
`allow_anonymous_write: true`。

## 从本机部署到远程主机

`deploy.sh` 把代码打包上传、在远端构建镜像并重启容器。

```bash
cp deploy.env.example .deploy.env    # 填 HOMELAB_HOST，可选填 SUDO_PASS
./deploy.sh              # 构建并部署
./deploy.sh --config     # 顺带用仓库里的 config.yaml 覆盖线上的
./deploy.sh --no-build   # 只重启容器，不重建镜像
```

**新增配置项时必须带 `--config`**，否则线上读不到新的配置段。旧配置会自动备份为
`config.yaml.bak`。

**`--no-build` 不会更新代码。**`backend/` 和 `frontend/` 是 COPY 进镜像的，
只有 `config.yaml` 是挂载的。改了代码就必须重建镜像（有层缓存，通常十几秒）。
这个参数只在"仅改了 config.yaml，想让容器重新读配置"时有用。

部署后：`http://<主机地址>:8770`

`config.yaml` 在服务器上的改动**不会被部署覆盖**，可直接在线上调整服务列表和阈值。

### 容器如何拿到宿主机数据

采集器要读的东西大多在宿主机上，靠挂载和一个 capability 解决，**不需要 privileged**：

| 需求 | 方案 |
|---|---|
| `docker ps/stats` | 挂 `/var/run/docker.sock` + 挂宿主机的 `/usr/bin/docker` |
| `btrfs subvolume list` | `cap_add: SYS_ADMIN`（ioctl 需要），挂各存储卷只读 |
| CrowdSec 告警明细 | 挂 `/var/lib/crowdsec/data` 只读，SQLite 直读 |
| `/proc` 网卡与负载 | `network_mode: host` |
| CPU 温度 | 挂 `/sys/class/thermal` 只读 |
| SSH 采集远程主机 | 挂对应的私钥文件只读 |
| 封禁 / 解封 | 挂 `/etc/crowdsec/local_api_credentials.yaml` 只读，走 LAPI |
| 端口审计 | `network_mode: host` 下 `/proc/net/tcp` 就是宿主机网络栈 |
| 历史库 | 挂 `./data:/app/data`，唯一的可写挂载 |

两个刻意的设计：

**docker CLI 不装进镜像**，从宿主机挂载。它虽然不是静态链接，但宿主机与
`python:3.11-slim` 同为 Debian 12，libc 版本一致可直接运行，省掉构建时 50MB 下载。

**CrowdSec 改走 SQLite 而非 `cscli`**。容器里不必安装 cscli，且直读数据库比
fork 一个 cscli 进程快 50 倍（9ms vs 463ms）。代码保留了三层回退
（LAPI → SQLite → cscli），裸机跑也能工作。

### 构建踩过的坑

第一次构建在 `apt-get` 那层**跑了 757 秒然后超时失败**。原因是宿主机配了中科大源，
但容器是干净的 `python:3.11-slim`，用的还是 `deb.debian.org` 官方源。
Dockerfile 里换成 `mirrors.ustc.edu.cn` 后，整个构建降到 1 分钟内，镜像 188MB。

教训：**容器是全新系统，宿主机的镜像源配置一点都带不进去**，apt 和 pip 都要单独换。

## 配置

从 `config.example.yaml` 复制一份改。改完重启容器生效。

- `services` — 要探测的服务，`expect` 是可接受的 HTTP 状态码
- `storage.volumes` — 监控的卷及告警阈值
- `certs.targets` — 检查到期的域名
- `remote_hosts` — SSH 采集的远程主机，需先配好免密

## 访问方式

面板会显示全部基础设施状态，**这是攻击者最想要的情报**，因此不暴露公网：

- 内网直接访问
- 外出时走 Tailscale

建议用防火墙把面板端口限制在内网 + VPN 网段。

## 防火墙操作

面板的「防火墙」页可以直接封禁 / 解封 IP，底层是 CrowdSec。

**生效链路**：点击按钮 → `POST /v1/alerts` 写入 LAPI → firewall-bouncer 轮询
（约 10 秒）→ 落到 iptables 的 `INPUT` 与 `DOCKER-USER` 两条链。所以按下去到
真正拦截有十几秒延迟，不是没生效。

**读写分离**：查询走 SQLite 只读，写必须走 LAPI——直接改库不会通知 bouncer，
规则永远下不到 iptables。写操作复用 crowdsec agent 自己的 machine 凭据
（compose 里只读挂载 `local_api_credentials.yaml`），宿主机上不装任何东西，
密钥也不进版本库。

**封禁来源分三类**，列表里有标签区分：

| 来源 | 含义 | 能否解封 |
|---|---|---|
| 手动 | 面板或 cscli 封的 | 能 |
| 自动 | 本地场景检出的（爆破、扫描） | 能 |
| 社区 | CrowdSec 中心同步的黑名单 | 不能，解了会被同步回来 |

**防自锁**：内网段（`192.168/16`、`10/8`、`172.16/12`）、回环、Tailscale
CGNAT 段（`100.64/10`）在代码里硬保护，请求会被拒绝并说明原因。要额外保护别的
网段，加到 `crowdsec.protected_networks`。

**访问控制**：面板本身没有登录，任何能打开它的人都能改防火墙。当前只走内网和
Tailscale 所以可以接受。若要放宽访问范围，在 `firewall.write_token` 填一串随机
字符，前端会多出令牌输入框（存 localStorage）；或直接 `firewall.enabled: false`
退回只读。

## 告警与推送

异常时主动推 Server 酱，不用你盯着面板。

**规则**：磁盘超阈值、服务掉线、证书临期、CPU/内存/温度持续高位、采集器失败、
新增封禁。阈值都在 `config.yaml` 的 `alerts.rules` 里。

**抖动抑制**：异常必须连续存在 `sustain_seconds`（默认 120 秒）才真正推送，
压掉探针偶发超时造成的误报。问题没解决时每 `repeat_hours`（默认 12 小时）
提醒一次，恢复了补一条恢复通知。

**新封禁只报本地检出和手动的**，社区黑名单每次同步几百条，报了就是刷屏。

配置：在 `notify` 段填 Server 酱的 SendKey 并把 `enabled` 改成 true。
`sctp` 开头的走 Server酱³，其余走 Turbo 版，代码自动识别。填完可以调
`POST /api/alerts/test` 发一条测试。

### 外部看门狗（重要）

告警引擎跑在被监控的机器上，**它一挂告警也跟着哑火**——最该报警的时候没有声音。
所以 `scripts/watchdog.sh` 必须部署在它之外的一台常年在线的机器上
（任何一台常年在线的机器都行）：

```bash
mkdir -p /opt/homelab-watchdog && cd /opt/homelab-watchdog
# 上传 scripts/ 下的两个文件后：
chmod +x watchdog.sh
cp watchdog.env.example watchdog.env && vi watchdog.env    # 填 SENDKEY
./watchdog.sh --test                                        # 验证探测与推送
( crontab -l 2>/dev/null; echo "*/5 * * * * /opt/homelab-watchdog/watchdog.sh" ) | crontab -
```

建议探公网入口，它同时验证了机器活着、网络通、
lucky 正常。连续 3 次失败（约 15 分钟）才报，滤掉重启和网络抖动。

## 端口暴露审计

「端口」页列出所有监听端口，按可达范围分三级。分级不靠猜，靠三个客观事实：

| 级别 | 判定依据 |
|---|---|
| 仅本机 | 绑定地址全是 `127.0.0.1`/`::1` |
| 公网暴露 | 在 `ports.public_ports` 里声明过 |

`ports.public_ports` 需要手填——lucky 的公网映射有哪些，只有你知道。

## 容器操作与快照

「容器」页可以重启、启停、看最近 300 行日志。重启是两段式确认。

**保护名单**：`homelab-dashboard` 和 `crowdsec` 不允许从面板停止或重启——
前者停了就再也点不动按钮，后者停了防护直接掀掉。注意 `docker.sock` 挂成
`:ro` 只限制 socket 文件本身的权限，通过它照样能执行任何 docker 动作，
所以保护必须在代码里做，不能指望挂载选项。

**快照只读**：列出各卷快照、标出超过保留数的，但**不执行删除**，只生成命令让你
复制到宿主机上执行。卷是只读挂载，而面板没有登录体系，给它删快照的权限风险大于收益。

## 历史与趋势

指标每分钟采样落 SQLite，保留 90 天。「历史」页有 CPU、内存、上下行、各卷使用率、
负载、封禁数的曲线，可切 6 小时 / 24 小时 / 7 天 / 30 天。

**容量预测**按最近 7 天的增长速度线性外推，给出"约 X 天写满"。存储卡片上也会
直接显示，30 天内写满的标黄。

事件时间线记录所有告警、封禁、容器操作，重启不丢。

## 操作审计

面板没有登录体系，「历史」页底部的操作审计是唯一能看出**谁动过防火墙**的地方。

记录范围：所有写操作（封禁、解封、白名单增删、容器启停），**包括被拒绝的**——
token 不对、封到受保护网段、想停保护名单里的容器，这些失败尝试同样落库。
另外每个来源 IP 每小时记一条"打开面板"。

**GET 不记**：面板每 5 秒轮询一次 `/api/summary`，全记下来一天几万条，
真正有用的写操作反而被埋掉。

来源 IP 优先取 `X-Forwarded-For` 第一跳，面板将来放到反代后面也能记到真实地址。

## 防护引擎

「防火墙」页的引擎卡片回答的是"CrowdSec 本身在不在干活"——读了哪些日志、
解析率多少、哪些检测场景被触发。日志源突然归零往往意味着日志轮转后没跟上，
这种故障不看这一页根本发现不了。

**解析率必须按源单独算。**全局算出来是 1.7%，看着像整个引擎坏了，实际是
syslog 那几万行系统日志本来就没有对应解析器；真正要盯的 nginx 是 100%。
混在一起这个指标就废了。面板另给一个"有效源加权解析率"，只统计至少解析出过
一条的源。

上线首轮就查出 6 个日志源里 4 个解析率为 0，配了采集却没有产出。已清理，
详见 `docs/家庭三台设备定位与利用规划.md`。

## 常用命令

```bash
ssh <主机> "sudo docker ps --filter name=homelab-dashboard"
ssh <主机> "sudo docker logs -f homelab-dashboard"
ssh <主机> "sudo docker restart homelab-dashboard"        # 改完 config.yaml 后
curl -s http://<主机地址>:8770/api/summary | python3 -m json.tool
curl -s http://<主机地址>:8770/api/section/storage
```

---

## 路线图

已完成：历史数据落 SQLite（90 天）、存储增长预测、网络与负载曲线、攻击来源
聚合与一键封禁、容器重启与日志、Server 酱告警推送、外部看门狗、端口暴露审计、
访问审计、告警规则页面化编辑、硬盘 SMART 监控。

还没做：

- 容器资源排行的详情页 — 点开看单个容器的历史占用
- 快照真删除 — 现在只生成命令，要做得先给面板加认证
- 手机端布局再打磨 — 目前能用，表格横向滚动略挤
- `app.js` 已近 1600 行，再加功能需要按页面拆模块

## 已知技术债

- [ ] `certs` 采集器依赖 `openssl` 命令行，没有做无 openssl 环境的降级
- [ ] `containers` 采集器对旧版 Docker 的 `.State` 字段做了兼容回退，
      但未在旧版上实测
- [x] **前端单文件过长** — 已拆成 `index.html` / `app.css` / `app.js` 三个文件。
      仍然零构建、零依赖，图表是手写 SVG
- [ ] `app.js` 已近 800 行，再加功能需要考虑按页面拆模块
- [x] **`deploy.sh` 保留线上 `config.yaml` 导致新配置项下发不了** — 已加
      `--config` 开关强制覆盖（旧配置自动备份为 `config.yaml.bak`）。
      默认仍保留线上配置，新增配置项时记得带上这个参数

## 设计上有意不做的

- **不做公网暴露** — 面板聚合了全部基础设施状态，是攻击者最想要的情报，
  加上防火墙写操作之后更是如此。它的设计前提是只在内网或 VPN 里访问，
  因此没有完整的登录体系。写操作靠 `firewall.write_token` 保护，**不配置就
  默认全部拒绝**；确实在可信内网里图省事，才显式打开 `allow_anonymous_write`。
  真要放到公网，请在前面加一层带认证的反向代理，别只靠这个令牌
- **不做告警规则引擎** — 阈值判断放在配置里够用，不引入规则 DSL
- **不用 privileged** — 容器只加 `SYS_ADMIN` 一个 capability（btrfs ioctl 需要），
  其余靠只读挂载解决。最初判断"容器化必须 privileged"是错的，实测只需这一项
