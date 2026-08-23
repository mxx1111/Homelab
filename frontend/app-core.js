/* Homelab 面板前端 · 基础设施

   谁都要用的那些：DOM 取值、转义、请求封装、单位格式化、手写 SVG 图表，
   以及写操作和登录——它们是所有页面共用的能力，不属于任何一个页签。

   —— 前端拆成四个文件，按加载顺序：
        app-core.js      工具、格式化、SVG 图表、请求与写操作、登录
        app-nodes.js     机器视图：总览卡片、节点视图、fleet 横排
        app-security.js  防护线：告警条、防火墙、白名单、安全中心
        app.js           其余页签与调度（必须最后加载，它引用前面全部）

   仍然无构建、无 npm 依赖，index.html 里顺序引入即可。不用 ES module：
   那需要把几十个跨文件互相调用的函数逐个 export/import，而这些文件本来就
   共享同一份全局状态（activeNode、fleetItems、lastSections…），
   拆成模块反而要为每个状态再造一层访问器。普通 script 共享全局词法作用域，
   拆完之后函数之间的调用关系一行没变。 */

/* Homelab 面板前端。无构建、无依赖，图表是手写 SVG。 */

const $ = id => document.getElementById(id);

/* 会话过期的统一处理。
   包一层 fetch 而不是在二十来个调用点各写一遍 401 分支：那样不但啰嗦，
   以后新加的接口还会漏掉，表现成"页面某一块默默空着"。
   放在文件最顶上，保证后面所有代码拿到的都是包过的版本。 */
/* 这是全站唯一一处不在 app.js 里的顶层执行语句，可以待在这儿，是因为它只给
   window 打补丁，不碰 DOM 也不引用任何后面文件的东西——加载顺序对它没有约束。
   tests/split.test.mjs 里对应放行了 window.* 赋值这一类 */
const _fetch = window.fetch.bind(window);
window.fetch = async (...args) => {
  const res = await _fetch(...args);
  const url = String(args[0] || "");
  if (res.status === 401 && url.startsWith("/api/") && !url.startsWith("/api/auth/")) {
    showLogin();
  }
  return res;
};
const esc = s => String(s ?? "").replace(/[<>&"]/g, c =>
  ({"<":"&lt;",">":"&gt;","&":"&amp;",'"':"&quot;"}[c]));

/* CrowdSec 返回的是 ISO 3166-1 两位码。表里没有的直接显示原码，
   不做兜底翻译——显示 "ZZ" 至少是准确的，猜错国家更糟 */
const COUNTRY = {
  CN:"中国", HK:"中国香港", TW:"中国台湾", MO:"中国澳门",
  US:"美国", RU:"俄罗斯", DE:"德国", NL:"荷兰", GB:"英国", FR:"法国",
  JP:"日本", KR:"韩国", SG:"新加坡", IN:"印度", BR:"巴西", VN:"越南",
  CA:"加拿大", AU:"澳大利亚", IT:"意大利", ES:"西班牙", TH:"泰国",
  ID:"印尼", MY:"马来西亚", PH:"菲律宾", TR:"土耳其", UA:"乌克兰",
  PL:"波兰", RO:"罗马尼亚", SE:"瑞典", CH:"瑞士", IR:"伊朗", IQ:"伊拉克",
  PK:"巴基斯坦", BD:"孟加拉", EG:"埃及", ZA:"南非", MX:"墨西哥",
  AR:"阿根廷", CL:"智利", CO:"哥伦比亚", PE:"秘鲁", VE:"委内瑞拉",
  NG:"尼日利亚", KE:"肯尼亚", MA:"摩洛哥", DZ:"阿尔及利亚",
  SA:"沙特", AE:"阿联酋", IL:"以色列", QA:"卡塔尔", KW:"科威特",
  FI:"芬兰", NO:"挪威", DK:"丹麦", BE:"比利时", AT:"奥地利",
  CZ:"捷克", HU:"匈牙利", GR:"希腊", PT:"葡萄牙", IE:"爱尔兰",
  NZ:"新西兰", LT:"立陶宛", LV:"拉脱维亚", EE:"爱沙尼亚",
  BG:"保加利亚", RS:"塞尔维亚", HR:"克罗地亚", SK:"斯洛伐克",
  SI:"斯洛文尼亚", MD:"摩尔多瓦", BY:"白俄罗斯", KZ:"哈萨克斯坦",
  UZ:"乌兹别克", GE:"格鲁吉亚", AM:"亚美尼亚", AZ:"阿塞拜疆",
  LU:"卢森堡", IS:"冰岛", MT:"马耳他", CY:"塞浦路斯", PA:"巴拿马",
  SC:"塞舌尔", BZ:"伯利兹", VG:"英属维尔京", KY:"开曼", LI:"列支敦士登",
  NP:"尼泊尔", LK:"斯里兰卡", MM:"缅甸", KH:"柬埔寨", LA:"老挝",
  MN:"蒙古", BN:"文莱", MV:"马尔代夫", AF:"阿富汗", SY:"叙利亚",
};

/* 国家标签点来自 Natural Earth 1:50m Admin 0 Countries（公共领域）。仅当
   旧版 CrowdSec 没有经纬度字段时，作为 Leaflet 国家聚合点的降级坐标。 */
const COUNTRY_POINT = {
  AD:[1.54,42.55],AE:[54.55,23.47],AF:[66.5,34.16],AG:[-61.79,17.35],AI:[-63.03,18.24],
  AL:[20.11,40.65],AM:[44.8,40.46],AO:[17.98,-12.18],AQ:[35.89,-79.84],AR:[-64.17,-33.5],
  AS:[-170.75,-14.33],AT:[14.13,47.52],AU:[134.05,-24.13],AW:[-69.97,12.52],AX:[19.87,60.16],
  AZ:[47.21,40.4],BA:[18.07,44.09],BB:[-59.57,13.16],BD:[89.68,24.21],BE:[4.8,50.79],
  BF:[-1.36,12.67],BG:[25.16,42.51],BH:[50.55,26.06],BI:[29.92,-3.33],BJ:[2.35,10.32],
  BL:[-62.83,17.9],BM:[-64.76,32.3],BN:[114.55,4.45],BO:[-64.59,-16.67],BR:[-49.56,-12.1],
  BS:[-77.15,26.4],BT:[90.04,27.54],BW:[24.18,-22.1],BY:[28.42,53.82],BZ:[-88.71,17.2],
  CA:[-101.91,60.32],CD:[23.46,-1.86],CF:[20.91,6.99],CG:[15.9,.14],CH:[7.46,46.72],
  CI:[-5.57,7.49],CK:[-159.79,-21.22],CL:[-72.32,-38.15],CM:[12.47,4.59],CN:[106.34,32.5],
  CO:[-73.17,3.37],CR:[-84.08,10.07],CU:[-77.98,21.33],CV:[-23.64,15.07],CW:[-68.92,12.15],
  CY:[33.08,34.91],CZ:[15.38,49.88],DE:[9.68,50.96],DJ:[42.5,11.98],DK:[9.02,55.97],
  DM:[-61.34,15.46],DO:[-70.65,19.1],DZ:[2.81,27.4],EC:[-78.19,-1.26],EE:[25.87,58.72],
  EG:[29.45,26.19],EH:[-12.63,23.97],ER:[38.29,15.79],ES:[-3.46,40.09],ET:[39.09,8.03],
  FI:[27.28,63.25],FJ:[177.98,-17.83],FK:[-58.74,-51.61],FM:[158.23,6.89],FO:[-7.06,62.19],
  FR:[2.2,46.2],GA:[11.84,-.44],GB:[-2.12,54.4],GD:[-61.68,12.11],GE:[43.74,41.87],
  GG:[-2.56,49.46],GH:[-1.04,7.72],GL:[-39.34,74.32],GM:[-15,13.64],GN:[-10.02,10.62],
  GQ:[8.99,2.33],GR:[21.73,39.49],GS:[-31.06,-55.68],GT:[-90.5,14.98],GU:[144.7,13.35],
  GW:[-14.52,12.16],GY:[-58.94,5.12],HK:[114.1,22.45],HM:[73.51,-53.1],HN:[-86.89,14.79],
  HR:[16.37,45.81],HT:[-72.22,19.26],HU:[19.45,47.09],ID:[101.89,-.95],IE:[-7.8,53.08],
  IL:[34.85,30.91],IM:[-4.53,54.22],IN:[79.36,22.69],IO:[71.35,-6.19],IQ:[43.26,33.09],
  IR:[54.93,32.17],IS:[-18.67,64.78],IT:[11.08,44.73],JE:[-2.09,49.22],JM:[-77.32,18.14],
  JO:[36.38,30.81],JP:[138.44,36.14],KE:[37.91,.55],KG:[74.53,41.67],KH:[104.5,12.65],
  KI:[-157.38,1.82],KM:[43.32,-11.73],KN:[-62.76,17.34],KP:[126.44,39.89],KR:[128.13,36.38],
  KW:[47.31,29.41],KY:[-81.24,19.32],KZ:[68.69,49.05],LA:[102.53,19.43],LB:[35.99,34.13],
  LC:[-60.98,13.89],LI:[9.56,47.11],LK:[80.7,7.58],LR:[-9.46,6.45],LS:[28.25,-29.48],
  LT:[24.09,55.1],LU:[6.08,49.73],LV:[25.46,57.07],LY:[18.01,26.64],MA:[-7.19,31.65],
  MC:[7.4,43.74],MD:[28.49,47.43],ME:[19.14,42.8],MF:[-63.05,18.08],MG:[46.7,-18.63],
  MH:[171.19,7.08],MK:[21.56,41.56],ML:[-2.04,18.69],MM:[95.8,21.57],MN:[104.15,46],
  MO:[113.56,22.13],MP:[145.73,15.19],MR:[-9.74,19.59],MS:[-62.19,16.74],MT:[14.43,35.89],
  MU:[57.57,-20.3],MV:[73.51,4.17],MW:[33.61,-13.39],MX:[-102.29,23.92],MY:[113.84,2.53],
  MZ:[37.84,-13.94],NA:[17.11,-20.58],NC:[165.08,-21.06],NE:[9.5,17.45],NF:[167.95,-29.03],
  NG:[7.5,9.44],NI:[-85.07,12.67],NL:[5.61,52.42],NO:[9.6,61.3],NP:[83.64,28.3],
  NR:[166.93,-.52],NU:[-169.86,-19.05],NZ:[172.79,-39.76],OM:[57.34,22.12],PA:[-80.35,8.72],
  PE:[-72.9,-12.98],PF:[-149.46,-17.63],PG:[143.91,-5.7],PH:[122.47,11.2],PK:[68.55,29.33],
  PL:[19.49,51.99],PM:[-56.33,47.04],PN:[-128.32,-24.36],PR:[-66.48,18.23],PS:[35.29,32.05],
  PT:[-8.27,39.61],PW:[134.58,7.52],PY:[-60.15,-21.67],QA:[51.14,25.24],RO:[24.97,45.73],
  RS:[20.79,44.19],RU:[44.69,58.25],RW:[30.1,-1.9],SA:[44.7,23.81],SB:[159.17,-8.03],
  SC:[55.48,-4.68],SD:[29.26,16.33],SE:[19.02,65.86],SG:[103.82,1.37],SH:[-5.71,-15.95],
  SI:[14.92,46.06],SK:[19.05,48.73],SL:[-11.76,8.62],SM:[12.44,43.93],SN:[-14.78,15.14],
  SO:[45.19,3.57],SR:[-55.91,4.14],SS:[30.39,7.23],ST:[7.02,.97],SV:[-88.89,13.69],
  SX:[-63.07,18.04],SY:[38.28,35.01],SZ:[31.47,-26.53],TC:[-71.75,21.82],TD:[18.65,15.14],
  TF:[69.12,-49.3],TG:[1.06,8.81],TH:[101.07,15.46],TJ:[72.59,38.2],TL:[125.85,-8.8],
  TM:[58.68,39.86],TN:[9.01,33.69],TO:[-175.16,-21.21],TR:[34.51,39.35],TT:[-60.92,11],
  TV:[179.21,-8.51],TW:[120.87,23.65],TZ:[34.96,-6.05],UA:[32.14,49.72],UG:[32.95,1.97],
  US:[-97.48,39.54],UY:[-55.97,-32.96],UZ:[64.01,41.69],VA:[12.45,41.9],VC:[-61.34,13.09],
  VE:[-64.6,7.18],VG:[-64.64,18.43],VI:[-64.78,17.75],VN:[105.39,21.72],VU:[166.91,-15.37],
  WF:[-178.14,-14.29],WS:[-172.44,-13.64],XK:[20.9,42.6],YE:[45.87,15.33],ZA:[23.67,-29.71],
  ZM:[26.4,-14.66],ZW:[29.93,-18.91],
};
/* 机器名 -> 固定色调。同一台机器在所有卡片里颜色一致，
   多机场景下扫一眼就能归类，不用逐行读文字 */
function machineTone(name) {
  let h = 0;
  for (const ch of String(name || "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 4;
}
const machineTag = (name, cls = "") => name
  ? `<span class="tag mch m${machineTone(name)}${cls ? " " + cls : ""}">${esc(name)}</span>`
  : "";

const cname = code => {
  const c = String(code || "").trim().toUpperCase();
  if (!c || c === "??") return "未知";
  return COUNTRY[c] || c;
};

/* ================= 格式化 ================= */

const fmtBytes = n => {
  if (n === null || n === undefined) return "—";
  const u = ["B","KB","MB","GB","TB","PB"]; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(i === 0 ? 0 : (n < 10 ? 2 : 1)) + " " + u[i];
};
const fmtRate = n => n == null ? "—" : fmtBytes(n) + "/s";
const fmtDur = s => {
  if (s == null) return "—";
  const d = Math.floor(s/86400), h = Math.floor(s%86400/3600), m = Math.floor(s%3600/60);
  if (d) return `${d} 天 ${h} 小时`;
  if (h) return `${h} 小时 ${m} 分`;
  return `${m} 分`;
};
const fmtShort = s => {
  if (s == null) return "—";
  const d = Math.floor(s/86400), h = Math.floor(s%86400/3600), m = Math.floor(s%3600/60);
  if (d) return `${d}天`;
  if (h) return `${h}小时`;
  if (m) return `${m}分`;
  return `${Math.round(s)}秒`;
};
const fmtLeft = s => {
  if (s == null) return "—";
  if (s <= 0) return "即将到期";
  const d = Math.floor(s/86400);
  if (d > 365) return "永久";
  return fmtShort(s);
};
const ago = ts => {
  if (!ts) return "—";
  const s = Math.max(0, Date.now()/1000 - ts);
  if (s < 60) return Math.floor(s) + " 秒前";
  if (s < 3600) return Math.floor(s/60) + " 分钟前";
  if (s < 86400) return Math.floor(s/3600) + " 小时前";
  return Math.floor(s/86400) + " 天前";
};
const agoHours = h => h == null ? "—"
  : h < 1 ? Math.round(h*60) + " 分钟前"
  : h < 24 ? Math.round(h) + " 小时前"
  : Math.round(h/24) + " 天前";
const clock = ts => {
  const d = new Date(ts * 1000);
  const p = n => String(n).padStart(2, "0");
  return `${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const hm = ts => {
  const d = new Date(ts * 1000);
  return `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
};
// 起止同一天就不重复写日期
const timeSpan = (a, b) => new Date(a*1000).toDateString() === new Date(b*1000).toDateString()
  ? `${clock(a)} → ${hm(b)}` : `${clock(a)} → ${clock(b)}`;
const pctClass = p => p >= 90 ? "crit" : p >= 80 ? "warn" : "";

function toast(title, msg, isErr) {
  const el = document.createElement("div");
  el.className = "toast" + (isErr ? " err" : "");
  el.innerHTML = `<b>${esc(title)}</b>${msg ? `<span>${esc(msg)}</span>` : ""}`;
  $("toasts").appendChild(el);
  setTimeout(() => {
    el.style.transition = "opacity .3s"; el.style.opacity = "0";
    setTimeout(() => el.remove(), 300);
  }, isErr ? 7000 : 4000);
}

function card(title, dotClass, bodyHtml, cls) {
  return `<div class="card${cls ? " " + cls : ""}">
    <h2><span class="dot ${dotClass}"></span>${title}</h2>${bodyHtml}</div>`;
}
function fail(sec, title) {
  return card(title, "crit",
    `<div class="empty">${esc(sec?.error || sec?.data?.error || "暂无数据")}</div>`);
}

/* ================= SVG 图表 =================
   viewBox 固定 100x H，配 preserveAspectRatio="none" 横向拉满容器；
   线宽用 vector-effect 抵消拉伸变形，刻度文字走 HTML 不进 SVG。 */

function svgPath(points, h, lo, hi) {
  const n = points.length;
  const span = (hi - lo) || 1;
  const x = i => n === 1 ? 50 : (i / (n - 1)) * 100;
  const y = v => h - ((v - lo) / span) * h;
  let line = "", area = `M 0,${h} `;
  points.forEach((p, i) => {
    const cmd = i === 0 ? "M" : "L";
    line += `${cmd} ${x(i).toFixed(2)},${y(p.avg).toFixed(2)} `;
    area += `L ${x(i).toFixed(2)},${y(p.avg).toFixed(2)} `;
  });
  area += `L 100,${h} Z`;
  return {line, area};
}

function sparkline(points, opts = {}) {
  if (!points || points.length < 2) {
    return `<div class="chart-empty" style="height:34px">${opts.emptyText || "暂无历史"}</div>`;
  }
  const h = 30;
  const vals = points.map(p => p.avg);
  // 缩略图只画线不画面积：从 0 起填的话，CPU 在 10~20% 波动时整块都是色块，
  // 看不出趋势。纵轴也贴合数据实际范围而不是从 0 开始，波动才看得见
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = (hi - lo) * 0.18 || Math.abs(hi) * 0.1 || 1;
  const {line} = svgPath(points, h, lo - pad, hi + pad);
  return `<svg class="chart spark" viewBox="0 0 100 ${h}" preserveAspectRatio="none">
    <path class="line" d="${line}" vector-effect="non-scaling-stroke"/>
  </svg>`;
}

/* 同单位的指标画进一张图。单条线时填面积，多条线只画线——
   半透明面积叠在一起会互相盖住，反而看不清哪条是哪条。
   x 轴按时间戳映射而不是数组下标：各系列的采样点数未必一样，
   按下标画会让两条线在时间上错位。 */
function chart(list, opts = {}) {
  const fmt = opts.fmt || (v => v.toFixed(1));
  const series = (Array.isArray(list) ? list : [{points: list}])
    .filter(s => (s.points || []).length >= 2);
  if (!series.length) {
    return `<div class="chart-empty">${opts.emptyText ||
      "还没有足够的历史数据，采集满一段时间后出现"}</div>`;
  }
  const h = 60;
  const all = series.flatMap(s => s.points);
  const t0 = Math.min(...all.map(p => p.ts)), t1 = Math.max(...all.map(p => p.ts));
  const vals = all.map(p => p.avg);
  const rawHi = Math.max(...vals), rawLo = Math.min(...vals);

  /* 纵轴贴合数据范围，但强制一个最小跨度。
     锁死 0-100% 的话，常年 31%~49% 的存储曲线全挤在底部、上面六成空着；
     可纯按数据缩放又会把 0.1% 的抖动撑满整张图，看着像盘要炸了。
     minSpan 是这两者的分界：波动小于它，图就该是平的，因为它本来就平。 */
  const minSpan = opts.minSpan || 0;
  let lo, hi;
  if (opts.min != null && opts.max != null) {
    lo = opts.min; hi = opts.max;
  } else {
    const pad = (rawHi - rawLo) * .18 || Math.abs(rawHi) * .1 || 1;
    lo = rawLo - pad; hi = rawHi + pad;
    const short = minSpan - (hi - lo);
    if (short > 0) { lo -= short / 2; hi += short / 2; }
    // 撞到数值天花板时把跨度推给另一侧，别把图压扁
    if (opts.floor != null && lo < opts.floor) {
      hi += opts.floor - lo; lo = opts.floor;
    }
    if (opts.ceil != null && hi > opts.ceil) {
      lo -= hi - opts.ceil; hi = opts.ceil;
      if (opts.floor != null) lo = Math.max(opts.floor, lo);
    }
    if (opts.min != null) lo = opts.min;
    if (opts.max != null) hi = opts.max;
  }
  const span = (hi - lo) || 1, tspan = (t1 - t0) || 1;
  const px = ts => (((ts - t0) / tspan) * 100).toFixed(2);
  const py = v => (h - ((v - lo) / span) * h).toFixed(2);

  const paths = series.map((s, i) => {
    const d = s.points.map((p, j) => `${j ? "L" : "M"} ${px(p.ts)},${py(p.avg)}`).join(" ");
    if (series.length === 1) {
      const pts = s.points;
      const area = `M ${px(pts[0].ts)},${h} ` +
        pts.map(p => `L ${px(p.ts)},${py(p.avg)}`).join(" ") +
        ` L ${px(pts[pts.length - 1].ts)},${h} Z`;
      return `<path class="area" d="${area}"/>
        <path class="line" d="${d}" vector-effect="non-scaling-stroke"/>`;
    }
    return `<path class="line s${i}" d="${d}" vector-effect="non-scaling-stroke"/>`;
  }).join("");

  const gridY = [0.25, 0.5, 0.75].map(f =>
    `<line class="grid-line" x1="0" x2="100" y1="${(h*f).toFixed(1)}"
      y2="${(h*f).toFixed(1)}" vector-effect="non-scaling-stroke"/>`).join("");

  // 所有数字统一挂在图例行：单线走同一套排版，不再是"单线看右上角、
  // 多线看左下角"两种规矩。时间范围由区块标题统一给出，图里不再重复
  const legend = `<div class="legend">${series.map((s, i) => {
    const pts = s.points, cur = pts[pts.length - 1].avg;
    const peak = Math.max(...pts.map(p => p.avg));
    return `<span class="s${i}"><i></i>${esc(s.name || "")}<b>${fmt(cur)}</b>
      <em>峰 ${fmt(peak)}</em></span>`;
  }).join("")}</div>`;

  return `<div class="chartbox">
    <div class="hint" title="纵轴范围">${fmt(lo)} – ${fmt(hi)}</div>
    ${legend}
    <svg class="chart" viewBox="0 0 100 ${h}" preserveAspectRatio="none"
         style="height:${opts.height || 128}px">
      ${gridY}
      ${paths}
    </svg>
  </div>`;
}

/* ================= 登录 ================= */

let loginShown = false;

function showLogin(msg) {
  const wall = $("loginWall");
  if (!wall) return;
  wall.classList.remove("hide");
  if (msg) {
    $("loginErr").textContent = msg;
    $("loginErr").classList.remove("hide");
  }
  // 只在第一次弹出时聚焦。轮询每 5 秒撞一次 401，反复抢焦点会让人打不完密码
  if (!loginShown) {
    loginShown = true;
    $("loginUser").focus();
  }
}

function hideLogin() {
  $("loginWall")?.classList.add("hide");
  $("loginErr")?.classList.add("hide");
  loginShown = false;
}

async function doLogin(ev) {
  ev.preventDefault();
  const btn = $("loginBtn"), err = $("loginErr");
  btn.disabled = true; btn.textContent = "登录中…";
  err.classList.add("hide");
  try {
    const res = await _fetch("/api/auth/login", {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({username: $("loginUser").value,
                            password: $("loginPass").value}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
    $("loginPass").value = "";
    hideLogin();
    refresh(); loadMeta(); loadSparks();
  } catch (e) {
    err.textContent = e.message;
    err.classList.remove("hide");
    $("loginPass").select();
  } finally {
    btn.disabled = false; btn.textContent = "登录";
  }
}

async function checkAuth() {
  try {
    const d = await (await _fetch("/api/auth/state")).json();
    if (d.enabled && !d.logged_in) showLogin(
      d.locked_for ? `失败次数过多，请 ${d.locked_for} 秒后再试` : "");
    renderAuthCard(d);
    return d;
  } catch { return null; }
}

function renderAuthCard(d) {
  const box = $("setAuth");
  if (!box) return;
  if (!d?.enabled) {
    // 没开登录时也要说话——多机场景下这是个真实风险，不该静悄悄
    box.innerHTML = `<h2><span class="dot warn"></span>面板登录</h2>
      <div class="note" style="margin-top:8px">未开启。面板能操作所有接入节点的防火墙，
        建议在 config.yaml 的 <code>auth</code> 段填上用户名和密码：
        <br><br><code>auth:<br>
        &nbsp;&nbsp;username: admin<br>
        &nbsp;&nbsp;password: "……"</code><br><br>
        密码可以直接写明文，也可以用
        <code>python -m backend.hashpw '密码'</code> 生成散列后填入——
        config.yaml 常会被贴出来排查问题，散列贴出去不算泄漏。</div>`;
    return;
  }
  box.innerHTML = `<h2><span class="dot ok"></span>面板登录
      <span class="right">已登录为 ${esc(d.username || "")}</span></h2>
    <div class="form" style="margin-top:12px">
      <button class="btn ghost" id="logoutBtn">退出登录</button>
      <span class="note" style="margin:0">退出后本浏览器需要重新登录，
        其他已登录的设备不受影响</span>
    </div>`;
  $("logoutBtn").onclick = async () => {
    await _fetch("/api/auth/logout", {method: "POST"}).catch(() => {});
    showLogin("已退出登录");
  };
}

/* ================= 写操作 ================= */

function token() { return localStorage.getItem("panelToken") || ""; }

async function api(path, method = "POST", body) {
  const headers = {};
  if (body) headers["Content-Type"] = "application/json";
  const t = token();
  if (t) headers["X-Panel-Token"] = t;
  const res = await fetch(path, {method, headers,
    body: body ? JSON.stringify(body) : undefined});
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
  return data;
}

async function doBan(ip, duration, reason) {
  const btn = $("banBtn");
  btn.disabled = true; btn.textContent = "提交中…";
  try {
    const r = await api("/api/firewall/ban", "POST", {ip, duration, reason});
    toast(`已封禁 ${r.ip}`, `${r.duration_label} · bouncer 约 10 秒后下发到 iptables`);
    $("banIp").value = ""; $("banWhy").value = "";
    await refresh();
  } catch (e) {
    toast("封禁失败", e.message, true);
  } finally {
    btn.disabled = false; btn.textContent = "封禁";
  }
}

async function doUnban(ip) {
  try {
    const r = await api("/api/firewall/unban", "POST", {ip});
    toast(`已解封 ${r.ip}`, `移除 ${r.removed} 条决策`);
  } catch (e) {
    toast("解封失败", e.message, true);
  }
  fwConfirm = null;
  await refresh();
}

async function doContainer(name, action) {
  try {
    await api(`/api/containers/${encodeURIComponent(name)}/${action}`);
    toast(`${name} 已${{restart:"重启", stop:"停止", start:"启动"}[action]}`, "");
  } catch (e) {
    toast(`操作失败`, e.message, true);
  }
  ctrConfirm = null;
  await refresh();
  if (activeTab === "history") loadAudit();
}

async function showLogs(name) {
  $("modal").innerHTML = `<div class="modal"><div class="modal-box">
    <div class="modal-head"><h3>${esc(name)}</h3>
      <span class="sp"></span>
      <button class="btn sm ghost" id="logRefresh">刷新</button>
      <button class="btn sm ghost" id="logClose">关闭</button></div>
    <pre class="logbox" id="logBody">加载中…</pre></div></div>`;
  const close = () => { $("modal").innerHTML = ""; };
  $("logClose").onclick = close;
  $("modal").querySelector(".modal").onclick = e => {
    if (e.target.classList.contains("modal")) close();
  };
  const load = async () => {
    try {
      const d = await (await fetch(
        `/api/containers/${encodeURIComponent(name)}/logs?lines=300`)).json();
      if (d.detail) throw new Error(d.detail);
      const box = $("logBody");
      box.textContent = d.text || "(无输出)";
      box.scrollTop = box.scrollHeight;
    } catch (e) {
      $("logBody").textContent = "读取失败：" + e.message;
    }
  };
  $("logRefresh").onclick = load;
  load();
}

async function loadMeta() {
  try {
    fwMeta = await (await fetch("/api/firewall/meta")).json();
  } catch { return; }
  $("banDur").innerHTML = (fwMeta.durations || [])
    .map(d => `<option value="${d.value}"${d.value === "4h" ? " selected" : ""}>${esc(d.label)}</option>`)
    .join("");
  if (!fwMeta.enabled) {
    $("fwOff").classList.remove("hide");
    $("fwOff").innerHTML = "<b>写操作已禁用</b>——在 config.yaml 里把 <code>firewall.enabled</code> 设为 true 后重启容器。";
    ["banIp","banDur","banWhy","banBtn"].forEach(i => $(i).disabled = true);
  }
  if (fwMeta.write_locked) {
    $("fwOff").classList.remove("hide");
    $("fwOff").innerHTML = "<b>写操作已锁定</b>——既没开登录也没配操作令牌时，" +
      "封禁与容器操作一律拒绝。三选一：在 config.yaml 的 <code>auth</code> 段" +
      "填用户名密码（推荐，登录后自动放行）、<code>firewall.write_token</code> " +
      "填一串随机字符（给脚本调用用），或在完全可信的内网里设 " +
      "<code>allow_anonymous_write: true</code>。改完重启容器。";
    ["banIp","banDur","banWhy","banBtn"].forEach(i => $(i).disabled = true);
  } else if (fwMeta.enabled) {
    // 上一轮如果锁着，控件被禁用了，解锁后要恢复——meta 在登录后会重拉，
    // 那时拿到的结果和登录前不同。firewall.enabled 为 false 时不能走这里，
    // 否则会把上面刚禁用的控件又打开
    $("fwOff").classList.add("hide");
    ["banIp","banDur","banWhy","banBtn"].forEach(i => $(i).disabled = false);
  }
  if (fwMeta.token_required) {
    $("tokenRow").classList.remove("hide");
    $("tokenIn").value = token();
  }
  $("fwNote").innerHTML =
    `受保护网段不可封禁：<span class="mono">${(fwMeta.protected_networks || []).join("  ")}</span>` +
    `<br>封禁经 LAPI 写入，firewall-bouncer 轮询后下发 iptables，生效有约 10 秒延迟。` +
    (fwMeta.notify_enabled ? "" : `<br>推送未启用，新封禁不会通知你。在 config.yaml 的 notify 段填 Server 酱 sendkey。`);
}

