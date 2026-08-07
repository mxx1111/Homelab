#!/usr/bin/env bash
# 修复 Tailscale 与云厂商内网地址的 CGNAT 段冲突。
#
# 问题：Tailscale 会装这条防伪造规则
#     -A ts-input -s 100.64.0.0/10 ! -i tailscale0 -j DROP
# 丢弃源地址在 CGNAT 段、却不是从 tailscale0 进来的包。
#
# 而云厂商普遍拿 100.64.0.0/10 做内网服务——华为云的 DNS 是 100.125.x.x，
# 阿里云的 metadata 是 100.100.100.200。这些服务的响应从物理网卡回来，
# 正好撞上那条 DROP，于是 DNS 静默超时。
#
# 症状很有迷惑性：域名全解析不了，但路由、网关、DNS 配置看着都正常，
# 很难联想到是 VPN 干的。
#
# 本脚本自动发现本机用到的 100.64/10 地址（DNS、网关、metadata），
# 在 ts-input 链首插入放行规则。幂等，可重复执行。
set -uo pipefail

CGNAT_RE='^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.'
TAG='cloud-internal: must precede tailscale CGNAT drop'

in_cgnat() { [[ $1 =~ $CGNAT_RE ]]; }

# 等 ts-input 链出现——tailscaled 刚起来时它还不存在
for _ in $(seq 1 30); do
  iptables -L ts-input -n >/dev/null 2>&1 && break
  sleep 2
done
iptables -L ts-input -n >/dev/null 2>&1 || { echo "ts-input 链不存在，Tailscale 可能未运行"; exit 0; }

targets=()
# 1. resolv.conf 里的 DNS
while read -r ip; do in_cgnat "$ip" && targets+=("$ip"); done < <(
  grep -hE '^nameserver' /etc/resolv.conf /run/resolvconf/resolv.conf 2>/dev/null |
  awk '{print $2}' | sort -u)
# 2. 默认网关
while read -r ip; do in_cgnat "$ip" && targets+=("$ip"); done < <(
  ip route show default 2>/dev/null | awk '/via/{print $3}' | sort -u)
# 3. 云 metadata 服务（阿里云 100.100.100.200 等）
for extra in ${EXTRA_CGNAT:-}; do in_cgnat "$extra" && targets+=("$extra"); done

if [[ ${#targets[@]} -eq 0 ]]; then
  echo "本机没有落在 100.64/10 的内网地址，无需处理"; exit 0
fi

# 按 /16 聚合，避免同一网段插一堆规则
declare -A nets
for ip in "${targets[@]}"; do nets["$(echo "$ip" | cut -d. -f1,2).0.0/16"]=1; done

n=0
for net in "${!nets[@]}"; do
  if iptables -C ts-input -s "$net" ! -i tailscale0 -j RETURN -m comment --comment "$TAG" 2>/dev/null; then
    echo "已存在: $net"
  else
    iptables -I ts-input 1 -s "$net" ! -i tailscale0 -j RETURN -m comment --comment "$TAG"
    echo "已放行: $net"; n=$((n+1))
  fi
done
echo "本次新增 $n 条"
