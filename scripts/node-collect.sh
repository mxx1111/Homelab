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
echo "script_version=1"

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
fi

echo "###SERVICES"
# 关注的服务写死在节点侧，而不是面板下发名单——面板能指定要查什么服务，
# 就等于恢复了任意命令执行的一部分能力，受限密钥的意义就打了折
for u in ssh sshd docker nginx crowdsec crowdsec-firewall-bouncer tailscaled; do
  st=$(systemctl is-active "$u" 2>/dev/null)
  [ -n "$st" ] && [ "$st" != "inactive" ] && echo "$u=$st"
done

echo "###END"
