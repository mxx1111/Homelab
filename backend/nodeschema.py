"""一台机器的状态长什么样——面板里唯一的那份契约。

## 为什么需要它

在这之前，本机走 13 个 Python 采集器（读 /proc、跑 smartctl、算速率差值、查 GeoIP），
节点走一个 bash 脚本输出分节文本。两条代码路径的字段集是各自长出来的，
从来没有人规定过"一台机器的状态"该包含什么。所以切换节点后数据对不齐是必然的，
不是哪个页签忘了做。

契约立在这里之后，本机和节点都往同一个盒子里填。**前端只认这个盒子**，
不再有 `node ? renderNodeX : renderX` 那种分叉。

## 契约不要求实现相同

这一点很重要：本机用 Python 采集器填，节点用 shell 脚本填，将来真上了常驻 agent
就换第三种填法。schema 不变，前端一行不用改。所以这里定义的是**数据形状**，
不是采集方式。

## 能力档位

节点采不到某项，不是"坏了"，是"这台没有这个模块"。用 capability 把这件事说清楚，
前端就能统一渲染占位，而不是每处写一段散文解释。

    full         数据完整
    basic        有，但粒度比 full 低（节点的端口只有"对外/回环"两档，
                 本机能分"公网/内网/仅本机"三档）
    readonly     有数据，但不能操作（节点容器：那把受限密钥只能跑采集脚本）
    unsupported  这台没有这个模块

## 关于 services 的一个坑

本机的 `services` 采集器是 HTTP 探针（配置里的 URL 健康检查），节点采集脚本的
`SERVICES` 节是 systemd 单元状态。**同名，但根本不是一回事。**

不拆开的话，前端会把 "docker=active" 画进"服务健康"卡里，和 HTTP 探针的
"响应 200 / 耗时 43ms" 混在一起——看着像同一类数据，其实一个是"进程在不在"，
一个是"服务答不答得出来"。进程在但服务 500 是很常见的故障，混了就分不出来。

所以拆成两个模块：`probes`（HTTP 探针）和 `units`（systemd 单元）。
这是立契约立出来的第一个发现。
"""

# 面板期望的节点采集脚本版本（scripts/node-collect.sh 的 script_version）。
# 节点脚本比这个旧时，新增的模块会缺，但那不是"这台没有这个模块"，
# 是"这台的脚本该更新了"——两件事的处理方式完全不同，得分开说
EXPECTED_SCRIPT_VERSION = 5

# 能力档位
FULL = "full"
BASIC = "basic"
READONLY = "readonly"
UNSUPPORTED = "unsupported"

LEVELS = (FULL, BASIC, READONLY, UNSUPPORTED)

# 模块清单。顺序即前端默认的卡片顺序——按"出事时想先看到什么"排，
# 不是按实现顺序
MODULES = (
    "host",         # 负载、CPU、内存、温度、运行时长
    "storage",      # 卷容量
    "network",      # 网卡速率、公网出口 IP
    "containers",   # Docker 容器
    "ports",        # 监听端口与暴露面
    "connections",  # 此刻谁连着这台
    "guard",        # 本机防护落地：ipset 条数、agent/bouncer、拦截计数
    "engine",       # CrowdSec 引擎 metrics：日志源、场景
    "disks",        # 硬盘 SMART
    "certs",        # 证书到期
    "probes",       # HTTP 服务探针（配置里的 URL）
    "units",        # systemd 单元状态
    "appsec",       # 1Panel WAF 只读观测
)

MODULE_NAMES = {
    "host": "主机",
    "storage": "存储",
    "network": "网络",
    "containers": "容器",
    "ports": "端口暴露",
    "connections": "活跃连接",
    "guard": "本机防护",
    "engine": "防护引擎",
    "disks": "硬盘健康",
    "certs": "证书",
    "probes": "服务健康",
    "units": "系统服务",
    "appsec": "WAF 观测",
}

# 某个模块不可用时给一句"为什么、怎么办"。前端拿这个渲染统一的占位卡，
# 省得在十几处各写一段散文。key 是模块名，值是 (原因, 怎么补)
UNSUPPORTED_HINTS = {
    "network": ("节点采集脚本没算网卡速率",
                "速率要两次采样求差值，脚本得在节点侧存上一次的 /proc/net/dev"),
    "connections": ("节点没采连接数据",
                    "往 node-collect.sh 里加一段 ss -tnH，GeoIP 归属在面板侧查"),
    "certs": ("节点没扫证书",
              "脚本里加一段扫 /etc/letsencrypt 与 1Panel 证书目录，读 notAfter"),
    "disks": ("节点没采 SMART",
              "脚本里加 smartctl -H -A，需要节点装 smartmontools"),
    "engine": ("引擎 metrics 只在本机采（6060 端口）",
               "这台检出的攻击结果已汇总在防火墙页，只是 metrics 没拉过来"),
    "guard": ("本机没统计 ipset 落地条数",
              "面板读的是中央 LAPI 的决策，本机实际落地数要另外查 ipset"),
    "probes": ("HTTP 探针是面板侧发起的，只覆盖 config.yaml 里配的 URL",
               "要探节点上的服务，把它的 URL 加进 services 配置即可"),
    "units": ("本机没查 systemd 单元",
              "面板跑在容器里，看不到宿主机的 systemd"),
    "appsec": ("这台没有 1Panel WAF", "挂载 1pwaf/data 目录后自动出现"),
}


def blank_capabilities(default=UNSUPPORTED):
    return {m: default for m in MODULES}


def make(node_id, name, role, *, ok=True, error=None, **meta):
    """造一个空的 NodeSnapshot。模块由调用方逐个填。

    role 只有 local / remote 两种。**本机不是特殊实体，是 id 为 local 的普通一员**——
    这样 fleet 视图能把本机和节点排在一起，前端也只需要写一遍渲染。
    """
    node = {"id": node_id, "name": name, "role": role, "ok": ok, "error": error,
            "hostname": None, "os": None, "collected_at": None,
            "latency_ms": None, "clock_skew_seconds": None, "uptime_seconds": None,
            # 节点采集脚本的版本。低于面板期望时前端提示升级，而不是让某几个
            # 模块无声无息地空着——"没数据"和"脚本太老"是两个完全不同的问题
            "script_version": None}
    node.update({k: v for k, v in meta.items() if k in node})
    return {"node": node, "capabilities": blank_capabilities(), "modules": {}}


def put(snap, module, data, level=FULL):
    """填一个模块。data 为空就当没有这个模块，避免"有 capability 但没数据"
    这种前端最难处理的中间态。"""
    if module not in MODULES:
        raise KeyError(f"未知模块: {module}")
    if data is None:
        return snap
    snap["modules"][module] = data
    snap["capabilities"][module] = level
    return snap


def hint(module):
    """(原因, 怎么补)。没登记的模块给一句通用的，不留空"""
    return UNSUPPORTED_HINTS.get(module, ("这台没有这个模块", ""))
