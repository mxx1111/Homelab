#!/usr/bin/env bash
# 演示实例自动跟随上游代码。
#
# 为什么要它：demo 跑的是和主仓库同一份代码，改了前端却不更新 demo，它就悄悄
# 旧了——没有任何东西会提醒你，直到有人照着 README 找某个功能却在 demo 上看不到。
# 这类"每次记得顺手做一下"的约定执行率很低，不是态度问题，是它没有失败反馈。
#
# 关键是探活和回滚，不能只做"拉取 + 重建"：
# 那样只是把"忘记更新"换成了"自动更新成一个坏的"，反而更糟。
#
#   无新提交    什么都不做，零消耗
#   有新提交    拉取 → 重建 → 探活
#   探活失败    回滚到更新前的提交重建，再探活，两种结果都推送告警
#
# 安装（在跑 demo 的机器上）:
#   crontab -e
#   17 4 * * * /opt/homelab-demo/scripts/demo-autoupdate.sh >> /var/log/homelab-demo-update.log 2>&1
set -uo pipefail

REPO_DIR="${REPO_DIR:-/opt/homelab-demo}"
HEALTH_URL="${HEALTH_URL:-http://172.31.240.2:8770/api/summary}"
# 探活重试：构建后容器要起 uvicorn、跑首轮采集，给足时间
TRIES="${TRIES:-15}"
INTERVAL="${INTERVAL:-6}"
LOCK="/var/lock/homelab-demo-update.lock"
# 复用外部看门狗的 SendKey，没有就静默跳过推送
SENDKEY="${SENDKEY:-}"
[[ -z "$SENDKEY" && -f /opt/homelab-watchdog/watchdog.env ]] && \
  SENDKEY=$(. /opt/homelab-watchdog/watchdog.env 2>/dev/null; echo "${SENDKEY:-}")

log() { echo "[$(date '+%F %T')] $*"; }

push() {
  [[ -z "$SENDKEY" ]] && return 0
  local url
  if [[ "$SENDKEY" == sctp* ]]; then
    url="https://${SENDKEY%%t*}t.push.ft07.com/send/${SENDKEY}.send"
  else
    url="https://sctapi.ftqq.com/${SENDKEY}.send"
  fi
  curl -s --max-time 12 -o /dev/null \
    -d "title=$1" --data-urlencode "desp=$2" "$url" || true
}

# 探活看的是实质内容而不是 HTTP 200：容器起来了但采集器全挂，
# 首页照样返回 200，那种状态对访客毫无价值
healthy() {
  local i body
  for ((i = 1; i <= TRIES; i++)); do
    body=$(curl -s --max-time 8 "$HEALTH_URL" 2>/dev/null || true)
    if [[ -n "$body" ]] && printf '%s' "$body" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(1)
secs = d.get("sections") or {}
ok = sum(1 for v in secs.values() if (v.get("data") or {}).get("ok"))
# demo 标志必须在，采集器至少 10 个正常，否则不算healthy
sys.exit(0 if d.get("demo") and ok >= 10 else 1)
' 2>/dev/null; then
      log "探活通过（第 $i 次）"
      return 0
    fi
    sleep "$INTERVAL"
  done
  return 1
}

compose() {
  local files=(-f docker-compose.demo.yml)
  # 公开实例会叠加隔离配置。少带这个文件会退回桥接网络、丢掉隔离，
  # 而且反代指向的固定 IP 会失效，站点直接 502
  [[ -f docker-compose.demo.hardening.yml ]] && files+=(-f docker-compose.demo.hardening.yml)
  docker compose "${files[@]}" "$@"
}

exec 9>"$LOCK" || exit 1
flock -n 9 || { log "已有实例在跑，跳过"; exit 0; }

cd "$REPO_DIR" || { log "目录不存在: $REPO_DIR"; exit 1; }

if ! git fetch -q origin 2>/dev/null; then
  log "git fetch 失败，跳过本轮（网络问题不值得告警）"
  exit 0
fi

BRANCH=$(git rev-parse --abbrev-ref HEAD)
OLD=$(git rev-parse HEAD)
NEW=$(git rev-parse "origin/$BRANCH")

if [[ "$OLD" == "$NEW" ]]; then
  log "无新提交（$(git rev-parse --short HEAD)），跳过"
  exit 0
fi

log "发现新提交: $(git rev-parse --short "$OLD") -> $(git rev-parse --short "$NEW")"
git log --oneline "$OLD..$NEW" | sed 's/^/    /'

git reset -q --hard "$NEW"

if ! compose up -d --build >/tmp/demo-build.log 2>&1; then
  log "构建失败，旧容器仍在运行"
  tail -20 /tmp/demo-build.log | sed 's/^/    /'
  git reset -q --hard "$OLD"
  push "[Demo] 自动更新失败" "构建阶段报错，已保留旧版本继续运行。$(tail -5 /tmp/demo-build.log)"
  exit 1
fi

if healthy; then
  log "更新完成: $(git rev-parse --short HEAD)"
  exit 0
fi

log "探活失败，回滚到 $(git rev-parse --short "$OLD")"
git reset -q --hard "$OLD"
if compose up -d --build >/tmp/demo-rollback.log 2>&1 && healthy; then
  log "回滚成功，demo 恢复"
  push "[Demo] 已回滚" "新提交 $(git rev-parse --short "$NEW") 探活失败，已回滚到 $(git rev-parse --short "$OLD")，演示站恢复正常。"
else
  log "回滚后仍不健康，需要人工处理"
  push "[Demo] 回滚失败，站点异常" "新版本探活失败且回滚后仍不健康，需要登录处理。仓库 $REPO_DIR"
fi
exit 1
