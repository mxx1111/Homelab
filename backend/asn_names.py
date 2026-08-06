"""把 GeoIP 返回的 AS/ISP 英文名整理成一眼能认的短标签。

原始值长这样：
    China Unicom CHINA169 Shandong Province Network
    Shenzhen Tencent Computer Systems Company Limited
    Cloudflare, Inc.

处理原则分两类：
  国内运营商翻成中文并带上省份 —— "联通 山东"，这是判断"这条连接是谁"最快的信息；
  国际品牌保留原名只做精简 —— Cloudflare 就是 Cloudflare，硬翻成中文反而没人认识。

原始英文名不丢，前端挂在 title 上，需要核对时鼠标一悬停就能看到。
"""
import re

# 匹配到就用这个名字。顺序有意义：先具体后笼统，
# 腾讯/阿里要排在"中国电信"这类通用运营商前面，否则会被先吃掉
CARRIERS = [
    (r"tencent", "腾讯云"),
    (r"alibaba|aliyun|taobao", "阿里云"),
    (r"huawei", "华为云"),
    (r"baidu", "百度"),
    (r"bytedance|douyin|toutiao", "字节"),
    (r"china\s*unicom|unicom|cnc\s*group|china169", "联通"),
    (r"china\s*telecom|chinanet|china\s*railway", "电信"),
    (r"china\s*mobile|cmnet|china\s*tietong", "移动"),
    (r"cernet|china\s*education\s*and\s*research", "教育网"),
    (r"china\s*internet\s*network\s*information\s*center", "CNNIC"),
    (r"great\s*wall\s*broadband|长城", "长城宽带"),
    (r"drpeng|dr\.?peng|鹏博士", "鹏博士"),
]

PROVINCES = {
    "beijing": "北京", "shanghai": "上海", "tianjin": "天津", "chongqing": "重庆",
    "guangdong": "广东", "jiangsu": "江苏", "zhejiang": "浙江", "shandong": "山东",
    "henan": "河南", "hebei": "河北", "shanxi": "山西", "shaanxi": "陕西",
    "liaoning": "辽宁", "jilin": "吉林", "heilongjiang": "黑龙江",
    "anhui": "安徽", "fujian": "福建", "jiangxi": "江西", "hubei": "湖北",
    "hunan": "湖南", "guangxi": "广西", "hainan": "海南", "sichuan": "四川",
    "guizhou": "贵州", "yunnan": "云南", "xizang": "西藏", "tibet": "西藏",
    "gansu": "甘肃", "qinghai": "青海", "ningxia": "宁夏", "xinjiang": "新疆",
    "neimenggu": "内蒙古", "inner mongolia": "内蒙古",
    "hongkong": "香港", "hong kong": "香港", "macau": "澳门", "taiwan": "台湾",
}

# 国际品牌：左边命中就换成右边。只收常见的，其余走通用精简
BRANDS = [
    (r"^amazon|amazon\.com|aws", "AWS"),
    (r"google", "Google"),
    (r"microsoft|azure", "Microsoft"),
    (r"cloudflare", "Cloudflare"),
    (r"akamai", "Akamai"),
    (r"fastly", "Fastly"),
    (r"digitalocean", "DigitalOcean"),
    (r"linode", "Linode"),
    (r"vultr|choopa", "Vultr"),
    (r"hetzner", "Hetzner"),
    (r"ovh", "OVH"),
    (r"oracle", "Oracle"),
    (r"apple", "Apple"),
    (r"tailscale", "Tailscale"),
    (r"github", "GitHub"),
    (r"telegram", "Telegram"),
]

# 公司后缀，纯噪音
SUFFIX = re.compile(
    r"[,\s]+(inc\.?|llc|ltd\.?|limited|corp\.?|corporation|co\.?|company|"
    r"gmbh|s\.?a\.?s?|b\.?v\.?|pty|plc|group|holdings?)\.?\s*$",
    re.I)
NOISE = re.compile(r"\b(province|provincial|network|networks|communications?|"
                   r"backbone|data\s*center|idc|isp|autonomous\s*system)\b", re.I)


def pretty_as(name):
    """返回短标签。认不出来的原样返回（只做后缀精简），绝不编造。"""
    if not name:
        return None
    raw = str(name).strip()
    low = raw.lower()

    for pattern, label in CARRIERS:
        if re.search(pattern, low):
            # 国内运营商带上省份，"联通 山东" 比单说"联通"有用得多
            for key, cn in PROVINCES.items():
                if key in low:
                    return f"{label} {cn}"
            return label

    for pattern, label in BRANDS:
        if re.search(pattern, low):
            return label

    # 不认识的：去掉公司后缀和 Province/Network 之类的填充词
    short = SUFFIX.sub("", raw)
    short = NOISE.sub("", short)
    short = re.sub(r"\s{2,}", " ", short).strip(" ,-")
    return short or raw
