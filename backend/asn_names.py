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
    # 括号里的法律形态说明先去掉：德国的 "UG (haftungsbeschrankt)"、
    # 荷兰的 "(besloten vennootschap)" 之类，留着只是噪声
    r"[,\s]*\([^)]*\)\s*$|"
    r"[,\s]+(inc\.?|llc|ltd\.?|limited|corp\.?|corporation|co\.?|company|"
    r"gmbh|ug|ag|kg|oy|ab|as|sa|srl|sro|s\.?a\.?s?|b\.?v\.?|n\.?v\.?|"
    r"pty|plc|group|holdings?)\.?\s*$",
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

    # 不认识的：去掉公司后缀和 Province/Network 之类的填充词。
    # 循环是因为后缀会叠加——"Pfcloud UG (haftungsbeschrankt)" 要先脱括号
    # 才轮得到 UG，而 SUFFIX 锚在词尾，一次 sub 只能剥一层
    short = raw
    for _ in range(3):
        stripped = SUFFIX.sub("", short).rstrip(" ,.")
        if stripped == short or not stripped:
            break
        short = stripped
    short = NOISE.sub("", short)
    short = re.sub(r"\s{2,}", " ", short).strip(" ,-")
    return short or raw


# 国家代码在推送通知里没法悬停查看，"RO" 和"罗马尼亚"对手机上瞄一眼的人差别很大。
# 前端 app.js 有一份同样的表——两处各自渲染，共用一份要么建接口要么塞进配置，
# 都不如各留一份静态表来得省事。
COUNTRIES = {
    "CN": "中国", "HK": "中国香港", "TW": "中国台湾", "MO": "中国澳门",
    "US": "美国", "RU": "俄罗斯", "DE": "德国", "NL": "荷兰", "GB": "英国",
    "FR": "法国", "JP": "日本", "KR": "韩国", "SG": "新加坡", "IN": "印度",
    "BR": "巴西", "VN": "越南", "CA": "加拿大", "AU": "澳大利亚", "IT": "意大利",
    "ES": "西班牙", "TH": "泰国", "ID": "印尼", "MY": "马来西亚", "PH": "菲律宾",
    "TR": "土耳其", "UA": "乌克兰", "PL": "波兰", "RO": "罗马尼亚", "SE": "瑞典",
    "CH": "瑞士", "IR": "伊朗", "IQ": "伊拉克", "PK": "巴基斯坦", "BD": "孟加拉",
    "EG": "埃及", "ZA": "南非", "MX": "墨西哥", "AR": "阿根廷", "CL": "智利",
    "CO": "哥伦比亚", "PE": "秘鲁", "VE": "委内瑞拉", "NG": "尼日利亚",
    "KE": "肯尼亚", "MA": "摩洛哥", "DZ": "阿尔及利亚", "SA": "沙特",
    "AE": "阿联酋", "IL": "以色列", "QA": "卡塔尔", "KW": "科威特",
    "FI": "芬兰", "NO": "挪威", "DK": "丹麦", "BE": "比利时", "AT": "奥地利",
    "CZ": "捷克", "HU": "匈牙利", "GR": "希腊", "PT": "葡萄牙", "IE": "爱尔兰",
    "NZ": "新西兰", "LT": "立陶宛", "LV": "拉脱维亚", "EE": "爱沙尼亚",
    "BG": "保加利亚", "RS": "塞尔维亚", "HR": "克罗地亚", "SK": "斯洛伐克",
    "SI": "斯洛文尼亚", "MD": "摩尔多瓦", "BY": "白俄罗斯", "KZ": "哈萨克斯坦",
    "UZ": "乌兹别克", "GE": "格鲁吉亚", "AM": "亚美尼亚", "AZ": "阿塞拜疆",
    "LU": "卢森堡", "IS": "冰岛", "MT": "马耳他", "CY": "塞浦路斯",
    "PA": "巴拿马", "SC": "塞舌尔", "BZ": "伯利兹", "VG": "英属维尔京",
    "KY": "开曼", "LI": "列支敦士登", "NP": "尼泊尔", "LK": "斯里兰卡",
    "MM": "缅甸", "KH": "柬埔寨", "LA": "老挝", "MN": "蒙古", "BN": "文莱",
    "MV": "马尔代夫", "AF": "阿富汗", "SY": "叙利亚",
}


def country_cn(code):
    c = str(code or "").strip().upper()
    if not c or c == "??":
        return ""
    return COUNTRIES.get(c, c)
