#!/usr/bin/env bash
# 外部看门狗：从一台常年在线的机器探测你的 NAS，挂了推 Server 酱。
#
# 它存在的唯一理由：面板自己的告警跑在被监控的机器上，那台机器一挂告警也跟着
# 哑火。这个脚本必须部署在它之外，才能在最该报警的时候还活着。
#
# 安装（在另一台常年在线的机器上）:
#   mkdir -p /opt/homelab-watchdog && cd /opt/homelab-watchdog
#   # 上传本脚本后:
#   chmod +x watchdog.sh
#   cp watchdog.env.example watchdog.env && vi watchdog.env    # 填 SENDKEY
#   ./watchdog.sh --test                                       # 验证推送通
#   ( crontab -l 2>/dev/null; echo "*/5 * * * * /opt/homelab-watchdog/watchdog.sh" ) | crontab -
set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ -f "$SELF_DIR/watchdog.env" ]] && . "$SELF_DIR/watchdog.env"

SENDKEY="${SENDKEY:-}"
# 空格分隔的探测目标。带 :// 的走 HTTP，host:port 走 TCP 连通性
TARGETS="${TARGETS:-}"
# 连续失败多少次才报。cron 每 5 分钟一次，3 次 = 15 分钟，能滤掉重启和网络抖动
THRESHOLD="${THRESHOLD:-3}"
TIMEOUT="${TIMEOUT:-12}"
STATE_DIR="${STATE_DIR:-$SELF_DIR/state}"
NAME="${NAME:-NAS}"

mkdir -p "$STATE_DIR"

push() {
  local title="$1" desp="${2:-}"
  [[ -z "$SENDKEY" ]] && { echo "未配置 SENDKEY，跳过推送"; return 1; }
  local url
  if [[ "$SENDKEY" =~ ^sctp([0-9]+)t ]]; then
    url="https://${BASH_REMATCH[1]}.push.ft07.com/send/${SENDKEY}.send"
  else
    url="https://sctapi.ftqq.com/${SENDKEY}.send"
  fi
  curl -sS --max-time 15 -o /dev/null -w '%{http_code}' \
       --data-urlencode "title=$title" --data-urlencode "desp=$desp" "$url"
}

probe() {
  local target="$1"
  if [[ "$target" == *"://"* ]]; then
    # 只看能否建连拿到响应，状态码是 401/403 也算活着
    curl -skf --max-time "$TIMEOUT" -o /dev/null "$target" && return 0
    local code
    code=$(curl -sk --max-time "$TIMEOUT" -o /dev/null -w '%{http_code}' "$target" 2>/dev/null)
    [[ "$code" =~ ^[2345][0-9][0-9]$ ]] && [[ "$code" != "000" ]] && return 0
    return 1
  fi
  local host="${target%:*}" port="${target##*:}"
  if command -v nc >/dev/null 2>&1; then
    nc -z -w "$TIMEOUT" "$host" "$port" >/dev/null 2>&1 && return 0
    return 1
  fi
  timeout "$TIMEOUT" bash -c "exec 3<>/dev/tcp/$host/$port" 2>/dev/null && return 0
  return 1
}

if [[ "${1:-}" == "--test" ]]; then
  echo "探测目标: $TARGETS"
  for t in $TARGETS; do
    probe "$t" && echo "  可达    $t" || echo "  不可达  $t"
  done
  echo -n "推送测试: HTTP "
  push "[看门狗] 测试" "看门狗已在 $(hostname) 上就位，探测目标: $TARGETS"
  echo
  exit 0
fi

now=$(date '+%Y-%m-%d %H:%M:%S')
for target in $TARGETS; do
  slug=$(echo "$target" | tr -c 'A-Za-z0-9' '_')
  fail_file="$STATE_DIR/$slug.fail"
  sent_file="$STATE_DIR/$slug.sent"
  fails=$(cat "$fail_file" 2>/dev/null || echo 0)

  if probe "$target"; then
    # 恢复：之前报过警才推恢复通知，避免每次正常都发
    if [[ -f "$sent_file" ]]; then
      down_since=$(cat "$sent_file")
      push "[看门狗] $NAME 已恢复" \
           "目标 $target 重新可达。\n\n中断开始于 $down_since\n恢复时间 $now"
      rm -f "$sent_file"
      echo "$now 恢复 $target"
    fi
    echo 0 > "$fail_file"
  else
    fails=$((fails + 1))
    echo "$fails" > "$fail_file"
    echo "$now 失败 $target (连续 $fails 次)"
    if [[ "$fails" -ge "$THRESHOLD" && ! -f "$sent_file" ]]; then
      echo "$now" > "$sent_file"
      push "[看门狗] $NAME 失联" \
           "目标 $target 连续 $fails 次探测失败。\n\n检测机 $(hostname)\n时间 $now\n\n> 面板自身的告警可能也已失效，请直接检查设备。"
      echo "$now 已推送告警 $target"
    fi
  fi
done
