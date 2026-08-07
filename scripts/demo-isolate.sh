#!/usr/bin/env bash
# 阻断演示容器主动连接宿主机。
#
# 为什么还需要它：docker-compose.demo.hardening.yml 里的 internal 网络
# 已经断掉了容器到外部网络的路由（公网、其他 docker 网段都不通），
# 但容器和网关处在同一个二层网络里，宿主机在该网桥上的地址仍然可达。
# 也就是说 internal 挡不住 "容器 -> 宿主机的 22/80/443"。
#
# 规则顺序要紧：先放行 ESTABLISHED。反向代理是宿主机主动连容器，
# 它的响应包在 INPUT 方向且属于已建立连接，无条件 DROP 会把站点打死。
#
# 用法:
#   ./demo-isolate.sh apply     加规则（幂等，重复执行安全）
#   ./demo-isolate.sh remove    删规则
#   ./demo-isolate.sh status    看当前状态
#
# 开机自动生效见本文件末尾的 systemd 单元示例。
set -euo pipefail

SUBNET="${DEMO_SUBNET:-172.31.240.0/28}"
TAG="homelab-demo"

need_root() {
  [[ $EUID -eq 0 ]] || { echo "需要 root 权限" >&2; exit 1; }
}

rule_reply=(-s "$SUBNET" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
            -m comment --comment "$TAG: allow reply")
rule_block=(-s "$SUBNET" -m conntrack --ctstate NEW -j DROP
            -m comment --comment "$TAG: block container->host")

remove_rules() {
  # -C 判断存在再删，循环是为了清掉历史上重复插入的副本
  while iptables -C INPUT "${rule_block[@]}" 2>/dev/null; do
    iptables -D INPUT "${rule_block[@]}"
  done
  while iptables -C INPUT "${rule_reply[@]}" 2>/dev/null; do
    iptables -D INPUT "${rule_reply[@]}"
  done
}

case "${1:-apply}" in
  apply)
    need_root
    remove_rules                       # 先清干净，保证幂等且顺序正确
    iptables -I INPUT 1 "${rule_reply[@]}"
    iptables -I INPUT 2 "${rule_block[@]}"
    echo "已应用：$SUBNET 不能主动连接宿主机（已建立连接不受影响）"
    ;;
  remove)
    need_root
    remove_rules
    echo "已移除 $SUBNET 的隔离规则"
    ;;
  status)
    if iptables -C INPUT "${rule_block[@]}" 2>/dev/null; then
      echo "生效中"
      iptables -L INPUT -n --line-numbers | grep -- "$TAG" || true
    else
      echo "未生效"
      exit 1
    fi
    ;;
  *)
    echo "用法: $0 {apply|remove|status}" >&2; exit 1 ;;
esac

# ---------------------------------------------------------------------------
# 开机自动应用（iptables 规则重启即失效，而且是静默失效，不做持久化
# 会在某次重启后悄悄失去保护）：
#
#   cat > /etc/systemd/system/homelab-demo-isolate.service <<'EOF'
#   [Unit]
#   Description=Isolate homelab demo container from host
#   After=docker.service
#   Wants=docker.service
#
#   [Service]
#   Type=oneshot
#   RemainAfterExit=yes
#   ExecStart=/opt/homelab-demo/scripts/demo-isolate.sh apply
#   ExecStop=/opt/homelab-demo/scripts/demo-isolate.sh remove
#
#   [Install]
#   WantedBy=multi-user.target
#   EOF
#   systemctl daemon-reload && systemctl enable --now homelab-demo-isolate
# ---------------------------------------------------------------------------
