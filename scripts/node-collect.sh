#!/usr/bin/env bash
# 节点采集脚本。装在被管理的机器上，由主面板通过 SSH 调用，输出分节文本。
#
# 为什么是脚本而不是让面板远程执行命令：配合 authorized_keys 的强制命令，
# 这把钥匙就只能跑这一个脚本，登不了 shell、开不了隧道。即使私钥泄漏，
# 攻击者拿到的也只是读监控数据的能力。
#
#   command="/opt/homelab/node-collect.sh",no-port-forwarding,no-agent-forwarding,\
#   no-pty,no-X11-forwarding,restrict ssh-ed25519 AAAA... homelab-panel
#
# 为什么输出分节文本而不是 JSON：节点侧要零依赖。拼 JSON 得处理转义，
# 用 shell 手写迟早会在某个带引号的容器名上崩掉；调 python3/jq 又等于
# 给节点加依赖。分节文本让脚本保持只有 echo 和管道，解析放在面板那边用
# Python 做——那里本来就有完整的运行时。
#
# 输出格式：###节名 一行，后面跟该节的原始内容，直到下一个 ### 或 ###END。
set -u
export LC_ALL=C
# 强制命令模式下客户端传来的命令在 SSH_ORIGINAL_COMMAND 里，一律忽略——
# 认它就等于把强制命令这层防护自己拆了
unset SSH_ORIGINAL_COMMAND

# 每条采集都套超时。任何一条卡住（NFS 挂了的 df、docker daemon 无响应）
# 都会让整轮采集超时，面板那边表现成"节点离线"，实际只是某一项卡住
run() { timeout "${1}" "${@:2}" 2>/dev/null; }

echo "###META"
echo "hostname=$(hostname)"
echo "collected_at=$(date +%s)"
echo "script_version=4"

echo "###HOST"
run 2 cat /proc/loadavg
run 2 cat /proc/uptime
run 2 grep -E "^(MemTotal|MemAvailable|SwapTotal|SwapFree):" /proc/meminfo
# CPU 核数用于把 loadavg 换算成百分比——负载 4 在 2 核和 16 核上完全是两回事
echo "cpucores=$(nproc 2>/dev/null || echo 1)"
[ -r /etc/os-release ] && . /etc/os-release && echo "os=${PRETTY_NAME:-unknown}"

echo "###TEMP"
# 优先 thermal_zone，树莓派和大多数 x86 板子都有；读不到就空着
for z in /sys/class/thermal/thermal_zone*/temp; do
  [ -r "$z" ] || continue
  t=$(cat "$z" 2>/dev/null)
  ty=$(cat "${z%/temp}/type" 2>/dev/null)
  echo "$ty=$t"
done

echo "###DISK"
# -P 保证一行一条不折行，-x 排除伪文件系统，否则 overlay/tmpfs 会淹没真实磁盘
run 8 df -PT -x tmpfs -x devtmpfs -x squashfs -x overlay

echo "###CONTAINERS"
if command -v docker >/dev/null 2>&1; then
  # 用 \t 分隔而不是默认的对齐空格：容器名和镜像名里都可能有空格
  run 10 docker ps -a --format '{{.Names}}\t{{.State}}\t{{.Status}}\t{{.Image}}'
fi

echo "###PORTS"
# 只要监听态。-n 不解析端口名，-p 带进程名
run 6 ss -lntupH

echo "###CROWDSEC"
if command -v cscli >/dev/null 2>&1; then
  # 本机 bouncer 实际落地的封禁条数。取 ipset 而不是问 LAPI——
  # 这里要答的是"这台机器上真的拦了多少"，不是"中央下发了多少"
  if command -v ipset >/dev/null 2>&1; then
    total=0
    for s in $(run 4 ipset list -n | grep '^crowdsec-blacklists'); do
      n=$(run 4 ipset list "$s" | grep -c '^[0-9]')
      total=$((total + n))
    done
    echo "ipset_entries=$total"
  fi
  echo "agent=$(systemctl is-active crowdsec 2>/dev/null || echo unknown)"
  echo "bouncer=$(systemctl is-active crowdsec-firewall-bouncer 2>/dev/null || echo unknown)"
  # bouncer 的 ipset 条数只能证明规则已下发；链计数才说明规则真的拦到过包。
  # 只读规则与计数，不改防火墙。IPv4/IPv6、nft 兼容层都尽量覆盖。
  blocked_packets=0
  blocked_bytes=0
  for fw in iptables ip6tables; do
    command -v "$fw" >/dev/null 2>&1 || continue
    chains=$(run 4 "$fw" -S | awk '$1=="-N" && tolower($2) ~ /crowdsec/ {print $2}')
    for chain in $chains; do
      counters=$(run 4 "$fw" -nvx -L "$chain" | awk '
        NR>2 && ($3=="DROP" || $3=="REJECT" || tolower($0) ~ /crowdsec.*blacklist/) {
          p+=$1; b+=$2
        }
        END {printf "%d %d",p,b}')
      p=${counters%% *}; b=${counters##* }
      case "$p" in ''|*[!0-9]*) p=0;; esac
      case "$b" in ''|*[!0-9]*) b=0;; esac
      blocked_packets=$((blocked_packets + p))
      blocked_bytes=$((blocked_bytes + b))
    done
  done
  echo "blocked_packets=$blocked_packets"
  echo "blocked_bytes=$blocked_bytes"
fi

echo "###APPSEC"
# 1Panel WAF 在部分节点上，不一定和中央面板同机。这里只读输出聚合值，
# 不传站点域名、规则内容、请求 URI 或 IP。没有 1Panel 的节点保持 unavailable。
waf_data=/opt/1panel/apps/openresty/openresty/1pwaf/data
if [ -d "$waf_data" ] && command -v python3 >/dev/null 2>&1; then
  timeout 6 python3 - "$waf_data" <<'PY' 2>/dev/null
import json
import sqlite3
import sys
from pathlib import Path

root = Path(sys.argv[1])

def load(name):
    try:
        with (root / "conf" / name).open(encoding="utf-8") as fp:
            return json.load(fp)
    except (OSError, ValueError, TypeError):
        return None

def count(name, table, where=""):
    path = root / "db" / "waf" / name
    try:
        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=2)
        try:
            return conn.execute(f"SELECT COUNT(*) FROM {table} {where}").fetchone()[0]
        finally:
            conn.close()
    except sqlite3.Error:
        return None

cfg = load("global.json")
sites = load("sites.json")
enabled = set()
if isinstance(cfg, dict):
    enabled = {k for k, v in cfg.items()
               if isinstance(v, dict) and
               (v.get("enable", v.get("enabled")) is True or
                str(v.get("state") or "").lower() == "on")}
print("adapter=onepanel")
print("available=true")
print(f"site_count={len(sites) if isinstance(sites, (dict, list)) else ''}")
print(f"request_rows={count('nginx_logs.db', 'nginx_logs') or 0}")
print(f"attack_rows={count('attack_logs.db', 'attack_logs') or 0}")
print(f"blocked_rows={count('attack_logs.db', 'attack_logs', 'WHERE is_block=1') or 0}")
print(f"waf={'true' if enabled.intersection({'waf','sql','xss'}) else 'false'}")
print(f"rate_limit={'true' if enabled.intersection({'cc','urlcc','attackCount'}) else 'false'}")
print(f"bot={'true' if 'bot' in enabled else 'false'}")
print(f"geo={'true' if 'geoRestrict' in enabled else 'false'}")
print(f"allow_deny={'true' if enabled.intersection({'ipWhite','ipBlack','urlWhite','urlBlack'}) else 'false'}")
PY
else
  echo "available=false"
fi

echo "###SERVICES"
# 关注的服务写死在节点侧，而不是面板下发名单——面板能指定要查什么服务，
# 就等于恢复了任意命令执行的一部分能力，受限密钥的意义就打了折
for u in ssh sshd docker nginx crowdsec crowdsec-firewall-bouncer tailscaled; do
  st=$(systemctl is-active "$u" 2>/dev/null)
  [ -n "$st" ] && [ "$st" != "inactive" ] && echo "$u=$st"
done

echo "###END"
