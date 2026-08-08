# Homelab Dashboard

一屏看完家里那台服务器的全部状态，出事时还能直接动手。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Python](https://img.shields.io/badge/Python-3.11+-3776AB?logo=python&logoColor=white)](https://www.python.org/)
[![FastAPI](https://img.shields.io/badge/FastAPI-009688?logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com/)
[![Docker](https://img.shields.io/badge/Docker-2496ED?logo=docker&logoColor=white)](https://www.docker.com/)

**简体中文** · [English](README.en.md)

安全告警、存储容量、服务健康、主机负载、网络速率、证书到期、端口暴露面、
实时连接、Docker 容器、硬盘 SMART —— 十三个采集器汇成一页。不只是看：
可以一键封禁 IP、重启容器、按趋势预测磁盘写满时间，异常时主动推到手机。
也能[管理多台机器](#管理多台机器)：在一处封禁，全部节点同时生效。

前端零构建、零依赖，图表是手写 SVG，整个前端就三个文件。

**在线体验 → <https://homelab.88688.team>**（数据全部仿真，可随意点击操作）

---

## 目录

- [它解决什么问题](#它解决什么问题)
- [功能](#功能)
- [快速开始](#快速开始)
  - [在线体验](#在线体验)
  - [前置条件](#前置条件)
  - [第一步：装 CrowdSec（可选但推荐）](#第一步装-crowdsec可选但推荐)
  - [第二步：装防火墙 bouncer](#第二步装防火墙-bouncer)
  - [第三步：告诉 CrowdSec 读哪些日志](#第三步告诉-crowdsec-读哪些日志)
  - [第四步：部署面板](#第四步部署面板)
  - [第五步：设置登录](#第五步设置登录)
- [配置详解](#配置详解)
- [容器权限说明](#容器权限说明)
- [安全须知](#安全须知)
- [功能详解](#功能详解)
- [从本机部署到远程主机](#从本机部署到远程主机)
- [管理多台机器](#管理多台机器)
- [外部看门狗](#外部看门狗)
- [故障排查](#故障排查)
- [架构](#架构)
- [开发](#开发)
- [路线图](#路线图)
- [贡献](#贡献)
- [许可](#许可)

---

## 它解决什么问题

家里跑一台 NAS 或小服务器，状态散落在十几个地方：NAS 自带面板看容量、
Portainer 看容器、CrowdSec 的 cscli 看攻击、SSH 上去 `df -h` 看磁盘、
证书快过期了根本没人提醒。真出事的时候，你得挨个翻。

这个面板把它们收进一页，并且**在发现问题的地方就能处理**——看到某个 IP
在爆破 SSH，当场点「封禁」；看到某个容器挂了，当场重启。

### 为什么不用 Grafana

Grafana 强在时序曲线和多数据源，弱在「一屏卡片式概览」，也做不了一键封 IP
这类交互——它是只读的观测台，不是操作台。如果你已经有 Prometheus 那套，
这个面板可以和它共存：Grafana 看趋势细节，这里看「现在是否一切正常」。

### 适合谁

- 家里有一台常年开机的 Linux 机器（NAS、小主机、旧笔记本）
- 装了 Docker，跑了若干服务
- 想知道有没有人在攻击它，并且想直接反击

### 不适合谁

- 大规模集群 —— 能管几台到十几台（见[管理多台机器](#管理多台机器)），
  再多就该上 Prometheus + Ansible 那套了
- 需要长期高精度指标 —— 历史库是分钟级采样，Prometheus 更合适
- 需要多用户和权限体系 —— 登录是单用户的，没有 RBAC，也不打算做

---

## 功能

| 页签 | 内容 |
|---|---|
| **总览** | 安全态势、被管理节点、存储、主机负载、网络、服务健康、端口暴露、容器、硬盘、证书 |
| **防火墙** | 封禁列表（手动/自动检出/社区黑名单三类）、攻击来源 TOP、国家与 ASN 分布、白名单、一键封禁与解封 |
| **安全中心** | 公网资产与保护缺口、防护闭环、跨节点事件处置、CTI、1Panel WAF 只读观测、带核查与回滚的临时封禁 |
| **连接** | 此刻谁连着你，含 GeoIP 归属、连接状态中文化、按服务端口聚合 |
| **端口** | 全部监听端口，按「公网暴露 / 内网可达 / 仅本机」分级 |
| **历史** | 趋势曲线、事件时间线、操作审计、容量预测、采样健康 |
| **容器** | 启停重启、日志查看、保护名单、btrfs 快照清理命令生成 |
| **设置** | 告警规则页面化编辑、单条告警忽略、推送开关 |

十三个采集器：`host` `network` `containers` `services` `crowdsec` `storage`
`certs` `remote` `nodes` `ports` `connections` `engine` `disks`。
每个独立循环、独立失败，某一个挂掉不影响其他卡片。

> 想直接看效果：**<https://homelab.88688.team>**。也欢迎提交你自己的部署截图到
> `docs/screenshots/`。

---

## 快速开始

### 在线体验

**<https://homelab.88688.team>** — 不用装任何东西，打开就能点。

演示站的数据全部是仿真的，不来自任何真实机器。封禁 IP、重启容器这类操作会
真的生效并反映在界面上，但只改内存状态，每小时重置一次。想在自己机器上跑
演示模式（比如给同事看），用演示专用的 compose 文件即可：

```bash
docker compose -f docker-compose.demo.yml up -d --build
```

演示实例不挂载任何宿主机路径、`cap_drop: ALL`、端口只绑回环——它读不到
宿主机的任何东西，这也是为什么可以放心公开。

### 前置条件

**必需**

- **Linux 宿主机** —— 要读 `/proc`、`/sys`、`/proc/mdstat`，macOS 与 Windows 不支持
- **Docker** 与 **docker compose**（compose v2，即 `docker compose` 而非 `docker-compose`）

**可选，但强烈推荐**

- **[CrowdSec](https://www.crowdsec.net/)** —— 装了才有防火墙、封禁、攻击来源
  那几块。不装的话面板照常运行，相关卡片显示「不可用」，其余功能不受影响
- **smartmontools** —— 硬盘 SMART 健康监控需要 `smartctl`
- **btrfs-progs** —— 只有用 btrfs 且想看快照才需要

如果你只想先看看长什么样，跳过全部可选项，直接[第四步](#第四步部署面板)。

---

### 第一步：装 CrowdSec（可选但推荐）

CrowdSec 是一个开源的入侵检测系统：读你的日志（nginx、sshd、smb…），
识别出攻击行为，生成「封禁决策」。它本身不拦截，拦截由 bouncer 做。

**Debian / Ubuntu**

```bash
curl -s https://install.crowdsec.net | sudo sh
sudo apt install crowdsec
```

**RHEL / CentOS / Fedora / Rocky**

```bash
curl -s https://install.crowdsec.net | sudo sh
sudo dnf install crowdsec
```

**Alpine**

```bash
sudo apk add crowdsec
```

**其他**：见[官方安装文档](https://docs.crowdsec.net/docs/getting_started/install_crowdsec/)。

装完确认服务起来了：

```bash
sudo systemctl status crowdsec
sudo cscli metrics          # 看到解析统计就说明在跑
```

CrowdSec 会自动检测机器上有哪些服务，装上对应的规则集（collection）。
看一眼装了什么：

```bash
sudo cscli collections list
```

典型输出会包含 `crowdsecurity/nginx`、`crowdsecurity/sshd`、
`crowdsecurity/linux` 等。缺什么可以手动装：

```bash
sudo cscli collections install crowdsecurity/nginx
sudo systemctl reload crowdsec
```

---

### 第二步：装防火墙 bouncer

**这一步不能省。** CrowdSec 只负责「判断谁该封」，真正把 IP 挡在门外的是
bouncer。没有它，面板上点「封禁」会成功写入决策，但流量照进不误。

```bash
# Debian / Ubuntu（iptables）
sudo apt install crowdsec-firewall-bouncer-iptables

# 如果你的系统用 nftables
sudo apt install crowdsec-firewall-bouncer-nftables

# RHEL 系
sudo dnf install crowdsec-firewall-bouncer-iptables
```

验证它注册上了：

```bash
sudo cscli bouncers list
```

应当看到一个 `cs-firewall-bouncer-xxxxx`，`Valid` 列是勾。

**封禁生效有延迟。** bouncer 默认每 10 秒向 LAPI 拉一次决策，所以在面板上
点封禁到 iptables 真正拦截，中间有大约 10 秒。这是正常的，不是面板卡住了。

---

### 第三步：告诉 CrowdSec 读哪些日志

CrowdSec 靠读日志发现攻击，读不到日志就什么都检测不出来。
配置文件在 `/etc/crowdsec/acquis.yaml` 或 `/etc/crowdsec/acquis.d/*.yaml`。

安装时自动生成的配置通常够用，但**如果你的服务跑在 Docker 里，日志路径
往往不在默认位置**，需要手动补。例如 nginx 容器把日志挂到了宿主机：

```yaml
# /etc/crowdsec/acquis.d/my-nginx.yaml
filenames:
  - /var/log/nginx/*.log
  - /opt/nginx/logs/access.log      # 你自己的路径
labels:
  type: nginx
```

改完重载并检查：

```bash
sudo systemctl reload crowdsec
sudo cscli metrics
```

**重点看「Acquisition Metrics」那张表的解析率。** 如果某个日志源
`Lines parsed` 是 0 而 `Lines unparsed` 很大，说明 `type` 标错了或者
缺少对应的 parser——这个源等于白读，白白消耗 CPU。面板的「防护引擎」卡片
会把这种零产出的源单独标出来。

> 解析率必须**按源分别看**。把所有源混在一起算全局解析率是没有意义的：
> syslog 里绝大多数行本来就没有对应解析器，混进去会把真正健康的 nginx
> 源的数字拖到个位数，让你误以为整个系统坏了。

---

### 第四步：部署面板

```bash
git clone https://github.com/mxx1111/Homelab.git
cd Homelab
cp config.example.yaml config.yaml
```

打开 `config.yaml`，**至少改这几处**：

```yaml
site_name: 我的NAS            # 推送标题的前缀，多台机器时用来区分

storage:
  volumes:
    - label: 系统盘
      path: /hostfs           # 容器里宿主机根分区挂在这
      warn: 80
      crit: 90
    - label: 数据盘            # 按自己的挂载点加
      path: /hostfs/mnt/data
      warn: 80
      crit: 90

services:                     # 想监控的服务，探针在本机发起
  - name: 我的博客
    url: http://127.0.0.1:8080/
    expect: [200, 302]

certs:
  targets:                    # 检查到期的域名，没有就留空列表
    - host: example.com
      port: 443
```

然后启动：

```bash
docker compose up -d --build
```

打开 `http://<你的服务器地址>:8770`。

**首次启动后看一眼日志**，确认各采集器状态：

```bash
docker logs -f homelab-dashboard
```

---

### 第五步：设置登录

面板出厂状态下**所有写操作都是拒绝的**——封禁、解封、重启容器、改告警规则
全部返回 403。因为它能改防火墙、能操作容器。

**推荐：开登录**

```yaml
# config.yaml
auth:
  enabled: true
  username: admin
  password: "你的密码"
```

登录之后写操作自动放行，不用再配令牌。会话默认 7 天，同一 IP 连错 5 次锁
15 分钟。

密码可以直接写明文，也可以填散列——`config.yaml` 常会被 `cat` 出来贴到
issue 里排查问题，散列贴出去不算泄漏：

```bash
docker exec homelab-dashboard python -m backend.hashpw '你的密码'
# 把输出那行整串填进 auth.password
```

**多机部署时这一步不是可选的。** 接入多个节点后，同一个页面能操作全部机器的
防火墙、还持有各节点的 SSH 密钥——无认证等于把整套基础设施挂在网上。

**补充：操作令牌（给脚本用）**

```yaml
firewall:
  write_token: "换成一串随机字符"    # openssl rand -hex 24
```

配了之后，带 `X-Panel-Token` 头的请求不需要登录也能写。用途是脚本调用——
curl 一条命令封个 IP，不必先走登录换 cookie。前端也会多出一个令牌输入框，
填一次记在 localStorage 里。

**兜底：完全信任所在网络**

```yaml
firewall:
  allow_anonymous_write: true
```

只有当面板确实只能从内网或 VPN 访问、且你不打算接多节点时才这么做。

改完重启容器：

```bash
docker compose restart
```

---

## 配置详解

配置文件是 `config.yaml`，从 `config.example.yaml` 复制而来。
查找顺序：环境变量 `HOMELAB_CONFIG` → `/etc/homelab-dashboard/config.yaml`
→ 仓库根目录的 `config.yaml` → `config.example.yaml`（兜底，让新克隆的仓库能起来）。

| 配置段 | 说明 |
|---|---|
| `site_name` | 推送标题前缀，也显示在页面头部 |
| `server` | 监听地址与端口，默认 `0.0.0.0:8770` |
| `intervals` | 各采集器的执行间隔（秒）。慢操作放大间隔，避免拖慢面板 |
| `storage.volumes` | 监控的卷及告警阈值。**容器里宿主机根分区在 `/hostfs`** |
| `storage.snapshot_mounts` | btrfs 快照扫描的挂载点，非 btrfs 留空 |
| `services` | 健康探针，`expect` 是可接受的 HTTP 状态码列表 |
| `certs.targets` | 检查到期的域名与端口 |
| `network.interface` | 留空自动选流量最大的物理网卡 |
| `crowdsec` | LAPI 地址、数据库路径、凭据文件 |
| `firewall` | 写操作开关与令牌，见[第五步](#第五步打开写操作) |
| `history` | SQLite 历史库路径与保留天数 |
| `notify` | Server 酱推送，SendKey 走环境变量不写这里 |
| `alerts.rules` | 各类告警的阈值与开关，**也可以在面板「设置」页改** |
| `ports` | 端口标签、公网端口声明、放行脚本路径 |
| `disks.warn_hours` | 硬盘通电时长告警阈值，默认 35000 小时（约 4 年） |
| `actions` | 容器操作开关与保护名单 |
| `remote_hosts` | SSH 采集的远程主机 |

### 关于采集间隔

默认值是权衡过的，两个特别说明：

- `disks: 1800` —— SMART 查询**会唤醒休眠的机械盘**。间隔太短会让盘永远
  睡不着，既费电又折寿。
- `storage: 300` —— btrfs 快照扫描要遍历子卷，在快照多的机器上要几秒。

### 告警规则

`alerts.rules` 里的阈值是默认值。在面板「设置」页改的值存在 SQLite 里，
按字段深合并覆盖配置文件——所以你改一个阈值不会把其他字段重置掉，
也不用重启容器。想恢复默认，设置页有「恢复默认」按钮。

告警不会一有异常就推送：`sustain_seconds`（默认 120 秒）要求异常持续
存在这么久才算数，用来压掉探针偶发超时造成的误报。

---

## 容器权限说明

面板要读宿主机的数据，靠挂载和两个 capability 实现，**不需要 privileged**。
部署前请逐条看一遍，用不到的功能把对应挂载删掉即可，面板会自动降级。

| 挂载 / 权限 | 用途 | 不给会怎样 |
|---|---|---|
| `network_mode: host` | 读 `/proc/net/*` 拿网卡速率、监听端口、实时连接 | 网络、端口、连接三块失效 |
| `/:/hostfs:ro` | 宿主机根分区容量 | 存储卡片读到的是容器自己的 overlay 层 |
| `/var/run/docker.sock:ro` | 容器列表与资源占用 | 容器页空白 |
| `/usr/bin/docker:ro` | 直接用宿主机的 docker CLI，省掉镜像里再装一份 | 同上 |
| `/var/lib/crowdsec/data:ro` | 读告警明细（SQLite） | 攻击来源、告警统计失效 |
| `/etc/crowdsec/local_api_credentials.yaml:ro` | 封禁/解封要写 LAPI | 只能看不能封 |
| `cap_add: SYS_ADMIN` | btrfs 的 `subvolume list` ioctl | 快照功能失效 |
| `cap_add: SYS_RAWIO` + `/dev:ro` + `device_cgroup_rules` | `smartctl` 读硬盘 SMART | 硬盘健康卡片显示不可用 |
| `/sys/class/thermal:ro` | CPU 温度 | 温度显示为空 |
| `./data:/app/data` | **唯一的可写挂载**，历史库落在这 | 重启后历史丢失 |

本机专属的挂载建议写进 `docker-compose.override.yml`（compose 会自动合并，
且已在 `.gitignore` 里），这样升级时不必每次改主文件：

```yaml
# docker-compose.override.yml
services:
  dashboard:
    volumes:
      - /mnt/data:/mnt/data:ro
```

### 为什么面板能封禁 IP

面板复用 CrowdSec agent 自己的 machine 凭据
（`/etc/crowdsec/local_api_credentials.yaml`，只读挂载）登录 LAPI，
拿到 JWT 后调用 `/v1/decisions` 写入决策。

**为什么不直接改 SQLite**：直接写数据库不会通知 bouncer，规则永远下不到
iptables。所有写操作必须走 LAPI。

---

## 安全须知

**这个面板把整台机器的状态聚合在一页**——服务清单、端口暴露面、容器列表、
内网拓扑——对攻击者而言这是最理想的情报源。加上它还能改防火墙和操作容器，
配置不当直接暴露到公网就是灾难。

设计上的取舍：

1. **写操作默认拒绝。** 没开登录也没配 `write_token` 时，所有写接口返回 403。
   要么开登录，要么配令牌，要么显式声明 `allow_anonymous_write: true`。
2. **登录是单用户的。** 用户名密码 + 内存 session + 失败限速，没有 RBAC、
   没有多用户、没有找回密码。单人自建场景下那些只会变成需要维护的攻击面。
   session 存内存，面板重启即失效——代价是重新登录一次，换来不必持久化
   会话密钥。
3. **受保护网段不可封禁。** 内网段（`10/8`、`172.16/12`、`192.168/16`）、
   回环、Tailscale CGNAT 段（`100.64/10`）在代码里硬保护，防止手滑把自己
   关在门外。可在 `crowdsec.protected_networks` 追加。
4. **快照只生成命令不执行删除。** 卷是只读挂载，面板给你一条命令，
   自己复制到宿主机执行。给一个网页删数据的权限，收益不匹配风险。
5. **审计只记写操作。** 面板每 5 秒轮询一次，GET 全记下来一天几万条，
   有用的写操作反而被埋掉。首页访问按 IP 每小时记一条。

**推荐的部署方式**

- 只监听内网，用防火墙限制来源网段
- 需要外网访问就走 Tailscale / WireGuard / Zerotier，**不要做端口映射**
- 真要放公网，除了开登录，前面再加一层带认证的反向代理
  （Authelia、Cloudflare Access 等）
- **接了多节点就必须开登录**——那时这个页面能操作全部机器的防火墙，
  还持有各节点的 SSH 密钥

**发现漏洞**请见 [SECURITY.md](SECURITY.md)。

---

## 功能详解

### 防火墙

封禁列表分三类，因为它们的处理方式完全不同：

- **手动** —— 你自己封的，可以随时解
- **自动检出** —— CrowdSec 的场景规则命中的，可以解
- **社区黑名单** —— CrowdSec 中央情报，通常上万条。**解了会在下次同步时
  回来**，因为它不是本机的决策

社区黑名单动辄一两万条，全量下发会撑爆前端。策略是：前两类全量返回，
社区黑名单只取最近一批供浏览，**总数用 SQL COUNT 单独统计**，所以你看到的
数字是准的，只是列表不全。搜索直接查库，不受此限制。

### 白名单

CrowdSec 原生的 whitelist 是 parser 层的 YAML 配置，改完要 reload 服务——
面板跑在容器里，既没有配置目录的写权限，也不该去重启宿主机的 systemd 服务。

所以这里用的是「看门」式实现：每轮采集后比对封禁列表，白名单里的 IP
一出现就立刻调 LAPI 解封。代价是有一个采集周期的延迟，好处是不碰
CrowdSec 的任何配置文件。

### 安全中心

安全中心不另造一套防火墙，而是把已有数据归成四个稳定视图：

- **保护覆盖**：把公网服务、监听端口、节点 agent/bouncer、中央决策与节点
  实际落地串起来，区分「检出、决策、下发、生效、命中」五个阶段。数据库、
  Docker API 等高风险端口监听所有网卡时会单独提示
- **事件中心**：按攻击源跨机器聚合 CrowdSec 告警，保存调查中、已处理、误报
  与备注。可选配置 `HOMELAB_CROWDSEC_CTI_KEY` 后按需查询 CrowdSec CTI，结果
  缓存在本地 SQLite；没配 key 时不访问外网
- **攻击态势**：使用随项目一起部署的开源 [Leaflet](https://leafletjs.com/)
  （BSD-2-Clause）与 Natural Earth 本地简图，可缩放、拖动并切换世界/中国
  视图，不依赖 VPN、地图 Key 或第三方底图服务。
  世界视图按国家聚合；中国视图使用 CrowdSec 本地 GeoLite2-City 数据库读取
  中文省市和经纬度，按 0.5° 网格聚合中国大陆及港澳台来源。攻击 IP 和事件数据只在浏览器本地
  叠加，不会传给底图服务；普通连接也不会被算作攻击
- **应用防护**：可把 1Panel OpenResty 的 `1pwaf/data` 目录只读挂到
  `/app/security/1panel-waf`，展示已有规则能力与统计。面板不会修改 WAF 配置

事件中心的「临时封禁」仍然走 CrowdSec LAPI，不直接编辑 iptables。执行前记录
服务和节点基线，执行后重新采集；原本正常的项目若变为异常，会立即尝试自动
解封。每次变更都留流水，仍在生效的变更可以从页面二次确认后回滚。

如果现网已用 1Panel WAF，不要同时把 CrowdSec AppSec 插进 80/443 请求链。
`security_center.crowdsec_appsec.enabled` 默认关闭，保留适配接口用于以后单独的
观察模式验证，避免双 WAF 带来的延迟和误报。

地图默认直接加载 `/static/maps/` 下的 Natural Earth 世界边界、中国省级边界和
本地中文标签；即使完全断开地图外网，攻击点和地理背景仍然可见。需要街道级细节
时，可以显式打开 `security_center.map.external_tiles`，再配置自建或已授权的 XYZ
瓦片与对应 `attribution`；瓦片连续失败时会自动保留本地简图。高德/百度使用不同
坐标系且通常需要平台 Key，不能直接拿 CrowdSec 的 WGS84 经纬度硬套，也不要使用
未授权的内部瓦片地址。

### 告警与推送

走 [Server 酱](https://sct.ftqq.com/)。SendKey **不要写进 config.yaml**，
放 `.env`：

```bash
cp .env.example .env
echo "HOMELAB_SENDKEY=你的SendKey" >> .env
docker compose up -d
```

`sctp` 开头的走 Server酱³，其余走 Turbo 版，代码自动识别。

告警有三层防刷屏：`sustain_seconds` 持续时间门槛、`repeat_hours` 重复提醒
间隔、以及单条告警的「忽略」（可设时长或永久，在设置页管理）。
问题消失时会补一条恢复通知。

### 端口暴露审计

把所有监听端口按可达范围分三级：

- **公网暴露** —— 在 `ports.public_ports` 里声明过的，标红
- **内网可达** —— 绑定在 `0.0.0.0` 但未对外映射
- **仅本机** —— 绑定在 `127.0.0.1`

如果你用一个 iptables 脚本管理放行端口，且脚本里有形如 `PORTS="22,80,443"`
的一行，把路径填进 `ports.homeguard_path`，分级会更准确。留空则跳过。

**`public_ports` 必须手填**——路由器上做了哪些端口映射，只有你自己知道，
系统层面看不出来。

### 历史与趋势

分钟级采样落 SQLite，默认保留 90 天。图表按单位合并：CPU 与内存一张、
上下行流量一张、各存储卷一张——共用纵轴才比得出比例。

纵轴贴合数据范围，但有**最小跨度**保护：存储曲线常年在 40% 附近纹丝不动，
纯按数据缩放会把 0.1% 的抖动撑满整张图，看着像盘要炸了。

容量预测用线性外推，但**观测窗口不足 24 小时不给结论**。启动阶段的波动
外推出来会是个吓人的假数字，宁可显示「数据不足」。

### 硬盘健康

重映射扇区、待处理扇区非零立刻标红——这两个是「当前状态」，非零就是真问题。

`Reported_Uncorrect` 特殊处理：它是**历史累计次数**，只增不减。光看数值
分不清那几次错误是昨天发生的还是六年前。面板会去读 SMART 错误日志里的
power-on 时间戳，和当前通电时长一比，超过一年没有新增就判为陈年旧账，
从告警里摘出来单独说明。

还会检查 `/proc/mdstat`：不少 NAS 会把单块盘也包装成 raid1，看着像有冗余，
实际是 `[1/1]` 单成员。这种「名义冗余」会被单独点出来。

---

## 从本机部署到远程主机

`deploy.sh` 把代码打包上传、在远端构建镜像、重启容器。

```bash
cp deploy.env.example .deploy.env
# 编辑 .deploy.env，填 HOMELAB_HOST（ssh 别名或 user@host）
./deploy.sh              # 构建并部署
./deploy.sh --config     # 顺带用本地 config.yaml 覆盖远端的
./deploy.sh --no-build   # 只重启容器，不重建镜像
```

两个坑：

- **`--no-build` 不会更新代码。** `backend/` 和 `frontend/` 是 COPY 进镜像的，
  只有 `config.yaml` 是挂载的。改了代码必须重建镜像。
- **新增配置项时必须带 `--config`**，否则远端读不到新的配置段。
  旧配置会自动备份为 `config.yaml.bak`。

默认不覆盖远端 `config.yaml`，避免冲掉你在服务器上的临时调整。

---

## 管理多台机器

一个面板看全部机器、在一处封禁 IP 并对所有机器生效。

这件事分成两半，而且**两半是独立的**——只做防火墙那半也完全可用：

| | 靠什么 | 要做什么 |
|---|---|---|
| 防火墙统一 | CrowdSec 原生的分布式架构 | 改几行配置，不用装东西 |
| 状态聚合 | 面板通过 SSH 拉取 | 节点上放一个采集脚本 |

### 先说网络：把安全分档

节点的 agent 要连到中央 LAPI，中央 LAPI 在哪台就得让别人连得进来。
按安全性从高到低：

1. **私有网络（推荐）** — WireGuard / Tailscale / ZeroTier / 内网。
   LAPI 只监听私有网段，公网上根本不存在这个端口，也就没有"白名单配错了
   会怎样"这个问题
2. **公网 + 反代 + 强认证（可接受）** — HTTPS 反代 + 源 IP 白名单 +
   CrowdSec 自带的 machine 认证。三层都要，缺一层就降一档
3. **直接把 8080 暴露到公网（不要）** — CrowdSec 的 machine 认证是
   login/password，明文 HTTP 传输，等于把凭据广播出去

下面的例子用 `10.0.0.1` 代表中央机器在私有网络里的地址，换成你自己的。

### 防火墙统一

**中央机器**（跑 LAPI 的那台）让 LAPI 监听得到：

```yaml
# /etc/crowdsec/config.yaml
api:
  server:
    listen_uri: 0.0.0.0:8080
```

绑 `0.0.0.0` 而不是直接绑私有网络地址，是因为后者会让 crowdsec 的启动
依赖 VPN 先就绪——VPN 没起来 crowdsec 直接启动失败，本机防护跟着一起挂。
绑 `0.0.0.0` 然后用防火墙限制来源，暴露面一样，但没有启动顺序依赖：

```bash
# 只放行私有网络和本机，其余一律拒绝
iptables -A INPUT -i lo -p tcp --dport 8080 -j ACCEPT
iptables -A INPUT -s 10.0.0.0/24 -p tcp --dport 8080 -j ACCEPT
iptables -A INPUT -p tcp --dport 8080 -j DROP
```

**每个节点**上（顺序有讲究，先注册确认通了再关本地 LAPI，中间不留失防窗口）：

```bash
# 1. 装 CrowdSec（同前面的第一步）
curl -s https://install.crowdsec.net | sudo sh
sudo apt-get install -y crowdsec

# 2. 注册到中央。这一步会覆盖 local_api_credentials.yaml，先备份
sudo cp /etc/crowdsec/local_api_credentials.yaml{,.bak}
sudo cscli lapi register --machine node1 --url http://10.0.0.1:8080

# 3. 【在中央机器上】批准
sudo cscli machines validate node1

# 4. 关掉本机 LAPI —— 在 api.server 下加 enable: false
#    注意配置文件里默认没有这个字段（默认是 true），是"加"不是"改"
sudo systemctl restart crowdsec

# 5. bouncer —— 装完必须马上配，本地 LAPI 已经关了，它这时是断的
sudo apt-get install -y crowdsec-firewall-bouncer-iptables
#    【在中央机器上】cscli bouncers add node1-fw -o raw   拿到 key
sudo vi /etc/crowdsec/bouncers/crowdsec-firewall-bouncer.yaml
#    api_url: http://10.0.0.1:8080/
#    api_key: <上一步的 key>
sudo systemctl restart crowdsec-firewall-bouncer
```

验收：中央 `cscli machines list` 看到所有节点且心跳在跳，然后封一个 IP，
到另一台确认规则真的落地了：

```bash
# ipset 名字带分片后缀（-0/-1/-2），直接查 crowdsec-blacklists 会报
# "set does not exist"，很容易误判成没生效
for s in $(ipset list -n | grep '^crowdsec-blacklists'); do
  ipset test $s 1.2.3.4 2>/dev/null && echo "命中 $s"
done
```

做完这一步，面板上就能看到全部节点的告警了——**面板不用改任何配置**。
因为它读的是中央那台的 CrowdSec 数据库，而所有节点的告警都写进了同一个库。
封禁列表会多出一列"检出机器"。

### 状态聚合（容器、磁盘、端口）

CrowdSec 管不到的部分靠 SSH 拉。**关键是用受限密钥**——面板持有所有节点的
私钥，它一旦泄漏，有强制命令保护的话攻击者只能读监控数据，没有的话等于
拿到全部节点的 shell。

**中央机器**上生成一把专用密钥：

```bash
mkdir -p /opt/homelab-dashboard/secrets && chmod 700 $_
ssh-keygen -t ed25519 -N "" -C "homelab-panel" \
  -f /opt/homelab-dashboard/secrets/id_panel
```

挂进容器（`docker-compose.override.yml`）：

```yaml
services:
  homelab-dashboard:
    volumes:
      - ./secrets:/app/secrets:ro
```

**每个节点**上装采集脚本，并给公钥套上强制命令：

```bash
sudo mkdir -p /opt/homelab
sudo install -m 755 scripts/node-collect.sh /opt/homelab/node-collect.sh

# authorized_keys 里加这一行（公钥换成上面生成的那把）
command="/opt/homelab/node-collect.sh",restrict ssh-ed25519 AAAA... homelab-panel
```

`restrict` 是 OpenSSH 7.2+ 的简写，等于关掉端口转发、agent 转发、
X11、pty 和 user-rc。加上 `command=` 之后，这把钥匙**只能**跑那一个脚本。
验证一下：

```bash
ssh -i secrets/id_panel root@10.0.0.2 "cat /etc/shadow"
# 应该返回采集脚本的输出，而不是 /etc/shadow 的内容
```

最后在面板配置里列出节点：

```yaml
nodes:
  - name: node1
    host: root@10.0.0.2
    key: /app/secrets/id_panel
  - name: node2
    host: root@10.0.0.3
    port: 4522              # 非标准 SSH 端口
    key: /app/secrets/id_panel

intervals:
  nodes: 60
```

总览页会多出一张「节点」卡片：每台一行，负载、内存、最满的那块盘、
容器数、本机实际落地规则数、采集延迟，点一行展开细节。安全中心还会汇总
CrowdSec 链的包/字节计数，用来区分「规则存在」和「确实拦到过流量」。

配置里只写 SSH 目标，**不绑定任何具体网络方案**——你走 VPN、内网还是公网，
面板不需要知道。

### 切换到某台节点

配了节点之后，顶栏右侧出现节点选择器。切过去之后各页签显示那台的数据，
顶栏会有一条橙色带提示你不在本机视图——多机场景下最容易犯的错就是
看着 B 机器的数据以为是 A 的。

| 页签 | 节点视图下 |
|---|---|
| 总览 | 主机、存储、容器、端口、本机防护、服务状态 |
| 防火墙 | 该机器检出的攻击来源与国家分布。**封禁列表不按机器过滤**——决策由中央统一下发，每条都对所有节点生效 |
| 端口 | 完整监听列表 |
| 容器 | 列表只读，见下 |
| 连接 / 历史 / 设置 | 显示说明，不适用 |

### 已知边界

- **节点采集是只读的**。面板不会去节点上执行任何操作，受限密钥也不允许。
  所以节点视图下容器不能启停——要支持得另发一把绑定操作脚本的密钥，
  那会削弱受限密钥的价值，值不值得取决于你多需要这个功能
- **节点比本机少采几项**：网络速率、活跃连接、证书到期、硬盘 SMART。
  速率要持续采样算差值，SMART 要 root 直接读设备。
  采集脚本在 `scripts/node-collect.sh`，按需要往里加
- **历史曲线只有中央机器的**。各节点存自己的，中央只聚合当前状态；
  跨节点存时序要另设计一套 schema

---

## 外部看门狗

告警引擎跑在被监控的机器上，**那台机器一挂，告警也跟着哑火**——最该报警的
时候反而没有声音。

`scripts/watchdog.sh` 补上这个盲区。它必须部署在**被监控机器之外**的一台
常年在线的机器上（一台便宜的云服务器就够）：

```bash
mkdir -p /opt/homelab-watchdog && cd /opt/homelab-watchdog
# 上传 watchdog.sh 和 watchdog.env.example
chmod +x watchdog.sh
cp watchdog.env.example watchdog.env && vi watchdog.env   # 填 SENDKEY 和 TARGETS
./watchdog.sh --test                                      # 验证推送通不通
( crontab -l 2>/dev/null; echo "*/5 * * * * /opt/homelab-watchdog/watchdog.sh" ) | crontab -
```

建议探公网入口而不是内网 IP——它同时验证了机器活着、网络通、反向代理正常。
连续 3 次失败（约 15 分钟）才报，滤掉重启和网络抖动。

---

## 故障排查

**面板起来了，但很多卡片显示「不可用」**

正常。没装 CrowdSec 就没有防火墙数据，没装 smartctl 就没有硬盘数据。
`docker logs homelab-dashboard` 会说明每个采集器失败的原因。

**存储容量显示的数字不对**

容器里的 `/` 是自己的 overlay 层，不是宿主机根分区。`config.yaml` 里
路径要写 `/hostfs`，不能写 `/`。

**点封禁提示 403**

写操作默认锁定，见[第五步](#第五步打开写操作)。

**点封禁成功了，但对方还能访问**

1. 检查 bouncer 装了没：`sudo cscli bouncers list`
2. 等 10 秒——bouncer 轮询周期
3. 检查 iptables：`sudo iptables -L CROWDSEC_CHAIN -n | head`
4. 确认封的不是受保护网段（内网、回环、Tailscale 段会被拒绝）

**攻击来源一直是空的**

CrowdSec 没检测到东西，通常是日志源没配对。跑 `sudo cscli metrics` 看
「Acquisition Metrics」，如果某个源的 `Lines parsed` 是 0，说明 `type`
标错或缺 parser。见[第三步](#第三步告诉-crowdsec-读哪些日志)。

**硬盘卡片显示「读不到磁盘列表」**

需要 `SYS_RAWIO` + `/dev` 挂载 + `device_cgroup_rules`，且宿主机装了
`smartmontools`。注意**挂了 `/dev` 不等于有权限访问块设备**，
`device_cgroup_rules` 那两行不能少。

**容器时间和宿主机差 8 小时**

挂上 `/etc/localtime:/etc/localtime:ro`（默认 compose 里已有）。

**历史页显示「数据不足」**

采样窗口不够。容量预测需要至少 24 小时数据，趋势图需要至少 2 个采样点。

---

## 架构

```
采集器(12 个，各自独立循环) ─┬─ 内存缓存 ─→ FastAPI ─→ 前端(5 秒轮询)
                             ├─ SQLite   历史指标与事件，保留 90 天
                             └─ 告警引擎 ─→ Server 酱 ─→ 手机
```

**采集与请求解耦。** 慢采集（btrfs 扫快照几秒、SSH 到远程主机 1 秒）在后台
按自己的节奏跑，前端只读缓存，永远不等待。某个采集器失败时保留上一次的
成功数据，不会让整块卡片变空。

落历史和评估告警走单独一条循环（30 秒一轮），不跟着采集器节奏；两者都是
阻塞操作（SQLite 写、推送 HTTP），丢到线程池执行，不卡事件循环。

### 目录结构

```
backend/
  main.py            FastAPI 路由、认证与审计中间件
  auth.py            单用户登录：会话、口令散列、失败限速
  hashpw.py          生成口令散列的命令行工具
  cache.py           采集调度与内存缓存
  config.py          配置加载
  alerts.py          告警规则引擎、覆盖层、静音
  firewall.py        LAPI 客户端与白名单
  history.py         SQLite：metrics/events/whitelist/audit/settings
  notify.py          Server 酱
  actions.py         容器操作与快照
  asn_names.py       ISP 名称与国家代码本地化
  scenario_names.py  CrowdSec 场景名中文化
  demo.py            演示模式的仿真采集器与写操作沙盒
  collectors/        13 个采集器
frontend/
  index.html         页面骨架
  app.css            样式
  app.js             渲染与交互（零依赖）
scripts/
  watchdog.sh        外部看门狗
  node-collect.sh    装在被管理节点上的采集脚本
```

### API

全部在 `/api/docs`（FastAPI 自动生成）。主要端点：

```
GET  /api/summary                 一次拿到所有采集器数据
GET  /api/section/{name}          单个采集器
GET  /api/history/multi           多条曲线
POST /api/firewall/ban            封禁
POST /api/firewall/unban          解封
POST /api/containers/{name}/{action}   容器操作
PUT  /api/alerts/settings         改告警规则
```

写操作需要 `X-Panel-Token` 头（配了 `write_token` 时）。

---

## 开发

不用 Docker 直接跑：

```bash
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
cp config.example.yaml config.yaml
python run.py
```

前端零构建，改完 `frontend/` 下的文件刷新浏览器即可。

注意直接跑的时候，容器里的路径假设（`/hostfs`）不成立，
`storage.volumes` 里要改成真实路径。

---

## 路线图

已完成：历史数据落 SQLite、存储增长预测、网络与负载曲线、攻击来源聚合与
一键封禁、容器重启与日志、Server 酱告警推送、外部看门狗、端口暴露审计、
访问审计、告警规则页面化、硬盘 SMART 监控、ISP 名称与场景名本地化、
面板登录、多机管理（CrowdSec 多节点 + SSH 受限密钥状态采集）。
安全中心（覆盖审计、事件处置、可选 CTI、1Panel WAF 只读适配、临时变更回滚）。

还没做：

- 容器资源排行的详情页 —— 点开看单个容器的历史占用
- 快照真删除 —— 现在只生成命令。有了登录之后这件事可做了，
  但删数据的权限还是想再想想
- 节点的历史曲线 —— 现在只聚合当前状态，各节点的时序数据留在各自机器上
- 多语言界面 —— 目前界面是中文，欢迎 PR
- 手机端布局再打磨 —— 目前能用，表格横向滚动略挤

---

## 贡献

欢迎 issue 和 PR，见 [CONTRIBUTING.md](CONTRIBUTING.md)。

特别欢迎这几类：

- **其他发行版/NAS 系统的适配经验** —— 群晖、威联通、unRAID 上的路径差异
- **界面翻译** —— 目前只有中文
- **新的采集器** —— 接口很简单，一个 `collect(cfg)` 函数返回 dict

---

## 许可

[MIT](LICENSE)
