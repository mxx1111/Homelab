"""把 CrowdSec 的场景名翻成中文。

原始值是 `crowdsecurity/http-admin-interface-probing` 这种，放在推送通知里
要人现场解码。手机上瞄一眼的场合，"后台入口探测"比原名有用得多。

查表优先，查不到落到规则拆解——社区 hub 里有几百个场景，还在持续新增，
全量枚举既不现实也会过期。规则拆解至少能把 `xxx-bf` 认成暴力破解、
把 `http-` 前缀认成 Web 攻击，比原样丢出去强。

原始名不丢：前端挂 title、通知正文附在括号里，要查文档时还能对得上。
"""
import re

# 精确匹配（去掉 crowdsecurity/ 之类的命名空间之后的部分）
EXACT = {
    # SSH
    "ssh-bf": "SSH 暴力破解",
    "ssh-slow-bf": "SSH 慢速暴力破解",
    "ssh-bf_user-enum": "SSH 用户名枚举",
    "ssh-refused-conn": "SSH 连接被拒绝",
    # Web 扫描探测
    "http-probing": "HTTP 路径探测",
    "http-crawl-non_statics": "非静态资源爬取",
    "http-bad-user-agent": "恶意 User-Agent",
    "http-path-traversal-probing": "路径穿越探测",
    "http-sensitive-files": "敏感文件探测",
    "http-admin-interface-probing": "后台入口探测",
    "http-backdoors-attempts": "后门文件探测",
    "http-sqli-probing": "SQL 注入探测",
    "http-sqli-probing-detection": "SQL 注入探测",
    "http-xss-probing": "XSS 探测",
    "http-open-proxy": "开放代理滥用",
    "http-generic-bf": "网页登录暴力破解",
    "http-w00tw00t": "w00tw00t 扫描器",
    "http-cve-probing": "已知漏洞探测",
    "http-wordpress_wpconfig": "WordPress 配置文件探测",
    "http-wordpress_user-enum": "WordPress 用户枚举",
    "http-wordpress-scan": "WordPress 扫描",
    "http-magento-bf": "Magento 后台爆破",
    "http-dos": "HTTP 拒绝服务",
    "nginx-req-limit-exceeded": "请求频率超限",
    # 其他服务
    "mysql-bf": "MySQL 暴力破解",
    "pgsql-bf": "PostgreSQL 暴力破解",
    "postfix-spam": "邮件垃圾投递",
    "smb-bf": "SMB 暴力破解",
    "telnet-bf": "Telnet 暴力破解",
    "ftp-bf": "FTP 暴力破解",
    "vsftpd-bf": "FTP 暴力破解",
    "windows-bf": "Windows 登录暴力破解",
    "iptables-scan-multi_ports": "多端口扫描",
    "port-scan": "端口扫描",
    "netfilter-scan-multi_ports": "多端口扫描",
    # 列表与人工
    "manual": "手动封禁",
    "manual-ban": "手动封禁",
}

# 落不到精确表时按片段拼。顺序有意义：先认协议，再认行为
PROTO = [
    (r"^ssh", "SSH"), (r"^http|^nginx|^apache|^caddy|^traefik", "Web"),
    (r"^mysql", "MySQL"), (r"^pgsql|^postgres", "PostgreSQL"),
    (r"^redis", "Redis"), (r"^mongo", "MongoDB"), (r"^ftp|^vsftpd|^proftpd", "FTP"),
    (r"^smb", "SMB"), (r"^telnet", "Telnet"), (r"^rdp", "远程桌面"),
    (r"^smtp|^postfix|^exim|^dovecot", "邮件"), (r"^dns|^bind", "DNS"),
    (r"^voip|^asterisk|^freeswitch", "VoIP"), (r"^vpn|^openvpn", "VPN"),
]
BEHAVIOR = [
    (r"slow.?bf", "慢速暴力破解"), (r"\bbf\b|brute|bruteforce", "暴力破解"),
    (r"user.?enum", "用户名枚举"), (r"probing|probe", "探测"),
    (r"scan", "扫描"), (r"crawl", "爬取"), (r"dos|flood", "拒绝服务"),
    (r"sqli", "SQL 注入"), (r"xss", "XSS"), (r"traversal", "路径穿越"),
    (r"backdoor", "后门"), (r"exploit|cve", "漏洞利用"),
    (r"spam", "垃圾投递"), (r"proxy", "代理滥用"),
]


def scenario_cn(scenario):
    """返回中文名；认不出来就返回去掉命名空间的原名，不返回空"""
    if not scenario:
        return ""
    short = str(scenario).strip().split("/")[-1]
    low = short.lower()

    hit = EXACT.get(low)
    if hit:
        return hit

    # CVE 编号原样保留——"CVE-2024-6387"本身就是最准确的说法，翻译反而丢信息
    cve = re.search(r"cve[-_](\d{4})[-_](\d{4,7})", low)
    if cve:
        return f"CVE-{cve.group(1)}-{cve.group(2)} 漏洞利用"

    proto = next((n for p, n in PROTO if re.search(p, low)), "")
    behavior = next((n for p, n in BEHAVIOR if re.search(p, low)), "")
    if proto and behavior:
        return f"{proto} {behavior}"
    if behavior:
        return behavior
    if proto:
        return f"{proto} 异常"
    return short
