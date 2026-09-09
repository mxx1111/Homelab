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
# 仅接受固定的只读核查协议，绝不 eval 客户端命令或转交 shell。
original_command=${SSH_ORIGINAL_COMMAND:-}
unset SSH_ORIGINAL_COMMAND

# 每条采集都套超时。任何一条卡住（NFS 挂了的 df、docker daemon 无响应）
# 都会让整轮采集超时，面板那边表现成"节点离线"，实际只是某一项卡住
run() { timeout "${1}" "${@:2}" 2>/dev/null; }

if [[ "$original_command" == verify-ip* ]]; then
  if [[ ! "$original_command" =~ ^verify-ip\ ([0-9a-fA-F:./]+)$ ]]; then
    echo "supported=false"; echo "error=invalid-target"; exit 2
  fi
  verify_target=${BASH_REMATCH[1]}
  echo "checked_at=$(date +%s)"
  if ! verify_sets=$(run 4 ipset list -name); then
    echo "supported=false"; echo "error=ipset-unavailable"; exit 0
  fi
  verify_found=false; verify_matched=false; verify_referenced=false
  for verify_set in $verify_sets; do
    [[ "$verify_set" =~ ^crowdsec[a-zA-Z0-9_-]*$ ]] || continue
    verify_found=true
    if run 4 ipset test "$verify_set" "$verify_target" >/dev/null; then
      verify_matched=true
      echo "matched_set=$verify_set"
      verify_refs=$(run 4 ipset list "$verify_set" -terse | awk '/^References:/{print $2}')
      if [[ "${verify_refs:-0}" =~ ^[0-9]+$ ]] && (( verify_refs > 0 )); then
        verify_referenced=true
      fi
    fi
  done
  echo "supported=$verify_found"
  echo "matched=$verify_matched"
  echo "referenced=$verify_referenced"
  exit 0
fi

echo "###META"
echo "hostname=$(hostname)"
echo "collected_at=$(date +%s)"
echo "script_version=7"

echo "###HOST"
run 2 cat /proc/loadavg
run 2 cat /proc/uptime
run 2 grep -E "^(MemTotal|MemAvailable|SwapTotal|SwapFree):" /proc/meminfo
# CPU 核数用于把 loadavg 换算成百分比——负载 4 在 2 核和 16 核上完全是两回事
echo "cpucores=$(nproc 2>/dev/null || echo 1)"
# CPU 瞬时占用。不能只拿 loadavg 当"CPU 压力"：Linux 把不可中断睡眠（D 状态）
# 的进程也计进 loadavg，带 NPU/GPU 的板子上一堆常驻驱动线程就卡在 D 状态。
# 香橙派 AiPro 实测 load 稳定在 17（3 核，换算 567%），而 CPU 实际 99% 空闲、
# iowait 0%——17 个 D 状态线程全是昇腾驱动在定时等待，一点 CPU 都不吃。
# 采两次 /proc/stat 求差才是真实使用率。
_cpu_snap() { awk '/^cpu /{idle=$5+$6; tot=0; for(i=2;i<=NF;i++) tot+=$i;
  # 必须 %.0f 强制整数。jiffies 累计值动辄 1e10，awk 默认 OFMT 是 %.6g，
  # 直接 print 会输出 3.06349e+10——两次采样精度丢到完全相同，差值恒为 0，
  # 结果就是开机久的机器永远采不到 CPU 使用率（szch/chen 实测踩中）
  printf "%.0f %.0f\n", idle, tot; exit}' /proc/stat 2>/dev/null; }
_c1=$(_cpu_snap); sleep 0.3 2>/dev/null || sleep 1; _c2=$(_cpu_snap)
if [ -n "$_c1" ] && [ -n "$_c2" ]; then
  awk -v a="$_c1" -v b="$_c2" 'BEGIN{split(a,x," ");split(b,y," ");
    di=y[1]-x[1]; dt=y[2]-x[2];
    if (dt>0) printf "cpupercent=%.1f\n", (1-di/dt)*100 }'
fi
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

echo "###NETWORK"
# 速率要两次采样求差值。面板每轮都是新的 SSH 连接，没法跨轮保存状态，
# 所以上一次的计数存在节点侧，差值也在节点侧算完再报。
# /run 是 tmpfs，重启自动清空，正合适——重启后第一轮没有速率是对的，
# 那时的计数差跨越了关机时间，算出来是个假数字
net_state=/run/homelab-node-net
[ -d /run ] && [ -w /run ] || net_state=/tmp/homelab-node-net
# 挑累计流量最大的物理网卡。虚拟网卡（docker/veth/tailscale）的流量是转发
# 产生的，报出去会让人以为这台机器在对外跑大流量
read -r cur_sum cur_rx cur_tx cur_if <<EOF
$(awk -F: 'NR>2 {
    name=$1; gsub(/[ \t]/, "", name)
    if (name ~ /^(lo|docker|br-|veth|tailscale|virbr|vmbr|cni|flannel|kube|dummy)/) next
    split($2, f, " ")
    if (f[1]+f[9] > 0) print f[1]+f[9], f[1], f[9], name
  }' /proc/net/dev 2>/dev/null | sort -rn | head -1)
EOF
if [ -n "${cur_if:-}" ]; then
  now_ts=$(date +%s)
  echo "interface=$cur_if"
  echo "rx_total=$cur_rx"
  echo "tx_total=$cur_tx"
  if [ -r "$net_state" ]; then
    read -r p_ts p_rx p_tx p_if < "$net_state" 2>/dev/null || true
    # 换了网卡就不能相减——两块卡的计数器毫无关系，相减出来是垃圾。
    # 计数器回绕（32 位机器或网卡重置）会得到负数，同样丢掉这一轮
    if [ "${p_if:-}" = "$cur_if" ] && [ "${p_ts:-0}" -lt "$now_ts" ]; then
      d=$((now_ts - p_ts))
      drx=$((cur_rx - p_rx)); dtx=$((cur_tx - p_tx))
      if [ "$drx" -ge 0 ] && [ "$dtx" -ge 0 ] && [ "$d" -gt 0 ]; then
        echo "rx_bytes_per_sec=$((drx / d))"
        echo "tx_bytes_per_sec=$((dtx / d))"
        echo "window_seconds=$d"
      fi
    fi
  fi
  printf '%s %s %s %s\n' "$now_ts" "$cur_rx" "$cur_tx" "$cur_if" > "$net_state" 2>/dev/null || true
fi

echo "###CONNS"
# 只报已建立的 TCP。IP 原样传给面板，GeoIP 归属在面板侧查——节点上装 GeoIP 库
# 等于每台都要维护一份几十 MB 的数据文件，而面板本来就有
run 6 ss -tnH state established

echo "###CERTS"
# 扫本地证书文件读到期时间，不做 TLS 探测。探测要出网，在节点上发起既慢又可能
# 被防火墙挡；而且面板真正关心的是"这台机器上放着的证书还有几天过期"
if command -v openssl >/dev/null 2>&1; then
  for d in /etc/letsencrypt/live/*/ /opt/1panel/data/ssl/*/ /etc/ssl/homelab/*/; do
    [ -d "$d" ] || continue
    for f in "${d}fullchain.pem" "${d}cert.pem" "${d}fullchain.crt" "${d}cert.crt"; do
      [ -r "$f" ] || continue
      end=$(run 4 openssl x509 -enddate -noout -in "$f" 2>/dev/null | cut -d= -f2-)
      [ -n "$end" ] || continue
      epoch=$(date -d "$end" +%s 2>/dev/null) || epoch=""
      # 证书里的 CN 比目录名可靠：目录可能是手工建的，CN 是签发时写进去的
      cn=$(run 4 openssl x509 -subject -noout -in "$f" 2>/dev/null |
           sed -n 's/.*CN[ ]*=[ ]*\([^,/]*\).*/\1/p' | head -1)
      name=${cn:-$(basename "$d")}
      [ -n "$epoch" ] && echo "$name|$epoch"
      break        # 一个目录只报一张，fullchain 和 cert 是同一张证书
    done
  done
fi

echo "###SMART"
# 只读健康状态，不跑自检——smartctl -t 会占用磁盘几分钟，不该由监控触发
if command -v smartctl >/dev/null 2>&1 && command -v lsblk >/dev/null 2>&1; then
  for dev in $(run 4 lsblk -dn -o NAME,TYPE 2>/dev/null | awk '$2=="disk"{print $1}'); do
    out=$(run 12 smartctl -H -A -i "/dev/$dev" 2>/dev/null) || continue
    [ -n "$out" ] || continue
    health=$(printf '%s' "$out" | grep -iE "SMART overall-health|SMART Health Status" |
             sed 's/.*: *//' | head -1)
    model=$(printf '%s' "$out" | grep -i "^Device Model\|^Model Number" |
            sed 's/.*: *//' | head -1)
    # SATA 盘看属性表第 10 列 RAW_VALUE，NVMe 是 "Power On Hours: 1,234" 这种格式
    hours=$(printf '%s' "$out" | awk '/Power_On_Hours/ {print $10; exit}')
    [ -n "$hours" ] || hours=$(printf '%s' "$out" |
      awk -F: '/Power On Hours/ {gsub(/[ ,]/,"",$2); print $2; exit}')
    realloc=$(printf '%s' "$out" | awk '/Reallocated_Sector_Ct/ {print $10; exit}')
    pending=$(printf '%s' "$out" | awk '/Current_Pending_Sector/ {print $10; exit}')
    temp=$(printf '%s' "$out" | awk '/Temperature_Celsius|Temperature:/ {print $10; exit}')
    echo "$dev|${health:-unknown}|${hours:-}|${realloc:-}|${pending:-}|${temp:-}|${model:-}"
  done
fi

echo "###ENGINE"
# CrowdSec agent 的 prometheus 端点默认只监听 127.0.0.1:6060——从面板那边连不上，
# 但这个脚本就跑在节点本地，正好够得着。
# 只取需要的几个指标：全量输出有几百 KB，每 60 秒经 SSH 传一次不值当。
# 格式是 prometheus 文本，面板侧直接复用 collectors/engine.py 已有的解析器
if command -v curl >/dev/null 2>&1; then
  run 6 curl -sf --max-time 5 http://127.0.0.1:6060/metrics 2>/dev/null |
    grep -E '^cs_(filesource_hits_total|parser_hits_ok_total|parser_hits_ko_total|bucket_poured_total|bucket_overflowed_total|buckets|alerts)' |
    head -400
fi

echo "###SERVICES"
# 关注的服务写死在节点侧，而不是面板下发名单——面板能指定要查什么服务，
# 就等于恢复了任意命令执行的一部分能力，受限密钥的意义就打了折
for u in ssh sshd docker nginx crowdsec crowdsec-firewall-bouncer tailscaled; do
  st=$(systemctl is-active "$u" 2>/dev/null)
  [ -n "$st" ] && [ "$st" != "inactive" ] && echo "$u=$st"
done

echo "###END"
