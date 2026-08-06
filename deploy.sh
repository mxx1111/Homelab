#!/usr/bin/env bash
# 部署到远程主机（Docker 方式）
#
# 用法: ./deploy.sh              构建并部署
#      ./deploy.sh --config     顺带用仓库里的 config.yaml 覆盖线上的
#      ./deploy.sh --no-build   只重启容器，不重建镜像
#
# 注意 --no-build 不会更新任何代码。backend/ 和 frontend/ 是 COPY 进镜像的
# （只有 config.yaml 是挂载的），所以改了代码必须重建镜像。它只在"仅改了
# config.yaml，想让容器重新读配置"时有用。
#
# 默认不动线上 config.yaml，避免冲掉服务器上的临时调整；
# 新增配置项（如 firewall 段）时必须带 --config，否则功能读不到配置。
# 密码可用环境变量 SUDO_PASS 提供，否则交互输入。
set -euo pipefail

DEST=/opt/homelab-dashboard
NO_BUILD=false
PUSH_CONFIG=false
for arg in "$@"; do
  case "$arg" in
    --no-build) NO_BUILD=true ;;   # 只重启，代码不会更新
    --config)   PUSH_CONFIG=true ;;
    *) echo "未知参数: $arg" >&2; exit 1 ;;
  esac
done

cd "$(dirname "$0")"

# 本机的目标主机与密码放这里，不进版本库。见 deploy.env.example
[[ -f .deploy.env ]] && . .deploy.env
# 目标主机：~/.ssh/config 里的别名或 user@host
HOST="${HOMELAB_HOST:?未设置 HOMELAB_HOST。cp deploy.env.example .deploy.env 后填写，或直接 export}"

if [[ -z "${SUDO_PASS:-}" ]]; then
  read -rsp "sudo 密码: " SUDO_PASS; echo
fi
rsudo() { ssh "$HOST" "echo '$SUDO_PASS' | sudo -S bash -c '$1'" 2>&1 | grep -v '^\[sudo\]' || true; }

echo "==> 打包"
TMP=$(mktemp -d)
EXTRA=()
[[ -f docker-compose.override.yml ]] && EXTRA+=(docker-compose.override.yml)
tar czf "$TMP/app.tgz" backend frontend run.py requirements.txt config.yaml \
    config.example.yaml Dockerfile docker-compose.yml "${EXTRA[@]}"

echo "==> 上传"
scp -q "$TMP/app.tgz" "$HOST:/tmp/homelab-app.tgz"
# .env 装着密钥，不在 tar 包里（tar 会进不了 gitignore 的口径），单独送
if [[ -f .env ]]; then
  scp -q .env "$HOST:/tmp/homelab.env"
  rsudo "mv /tmp/homelab.env $DEST/.env && chmod 600 $DEST/.env"
fi
rm -rf "$TMP"

if [[ "$PUSH_CONFIG" == true ]]; then
  echo "==> 解包到 ${DEST}（含 config.yaml，线上旧配置备份为 config.yaml.bak）"
  rsudo "mkdir -p $DEST && cd $DEST && \
    if [ -f config.yaml ]; then cp config.yaml config.yaml.bak; fi && \
    tar xzf /tmp/homelab-app.tgz -C $DEST && rm -f /tmp/homelab-app.tgz"
else
  echo "==> 解包到 ${DEST}（保留线上 config.yaml）"
  rsudo "mkdir -p $DEST && cd $DEST && \
    if [ -f config.yaml ]; then cp config.yaml /tmp/homelab-config.keep; fi && \
    tar xzf /tmp/homelab-app.tgz -C $DEST && \
    if [ -f /tmp/homelab-config.keep ]; then mv /tmp/homelab-config.keep $DEST/config.yaml; fi && \
    rm -f /tmp/homelab-app.tgz"
fi

if [[ "$NO_BUILD" == true ]]; then
  echo "==> 跳过构建（注意：代码改动不会生效，只有 config.yaml 会重新加载）"
else
  echo "==> 构建镜像（首次约 2-3 分钟）"
  rsudo "cd $DEST && docker compose build 2>&1 | tail -5"
fi

echo "==> 启动容器"
rsudo "cd $DEST && docker compose up -d 2>&1 | tail -3"
sleep 6

echo "==> 状态"
rsudo "docker ps --filter name=homelab-dashboard --format '{{.Names}}  {{.Status}}'"

PORT=$(grep -A3 '^server:' config.yaml | grep 'port:' | tr -dc '0-9')
echo
echo "面板: http://<主机地址>:${PORT:-8770}"
