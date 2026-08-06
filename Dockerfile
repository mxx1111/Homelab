FROM python:3.11-slim

# 容器内必须换国内 apt 源。用官方 deb.debian.org 构建曾耗时 757 秒后超时失败，
# 换中科大源后降到几十秒。境外机器可以删掉这两行换回官方源。
# Debian 12 用 deb822 格式的 debian.sources，旧格式 sources.list 一并兼容。
RUN set -eux; \
    for f in /etc/apt/sources.list.d/debian.sources /etc/apt/sources.list; do \
      [ -f "$f" ] && sed -i 's|deb.debian.org|mirrors.ustc.edu.cn|g; s|security.debian.org|mirrors.ustc.edu.cn|g' "$f" || true; \
    done; \
    apt-get update; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        btrfs-progs \
        openssl \
        openssh-client \
        ca-certificates \
        smartmontools \
        util-linux; \
    rm -rf /var/lib/apt/lists/*

# docker CLI 不在镜像内安装，由 compose 从宿主机挂载 /usr/bin/docker。
# 宿主机与本镜像同为 Debian 12，libc 版本一致，可直接运行。

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt \
    -i https://mirrors.ustc.edu.cn/pypi/simple \
    --trusted-host mirrors.ustc.edu.cn

COPY backend ./backend
COPY frontend ./frontend
COPY run.py .

ENV PYTHONUNBUFFERED=1 \
    HOMELAB_CONFIG=/app/config.yaml

EXPOSE 8770
CMD ["python", "run.py"]
