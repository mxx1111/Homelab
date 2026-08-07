/* Homelab 面板前端。无构建、无依赖，图表是手写 SVG。 */

const $ = id => document.getElementById(id);

/* 会话过期的统一处理。
   包一层 fetch 而不是在二十来个调用点各写一遍 401 分支：那样不但啰嗦，
   以后新加的接口还会漏掉，表现成"页面某一块默默空着"。
   放在文件最顶上，保证后面所有代码拿到的都是包过的版本。 */
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

/* ================= 总览 ================= */

function renderSecurity(sec) {
  const d = sec?.data;
  if (!d) return fail(sec, "安全态势");
  const c = d.ban_counts || {};
  const alerts = d.alerts_24h ?? 0;
  const dot = alerts > 5 ? "crit" : alerts > 0 ? "warn" : "ok";
  const recent = (d.alerts || []).slice(0, 7).map(a => `
    <div class="row">
      <span class="k"><span class="mono">${esc(a.ip || "?")}</span>
        ${a.country ? `<span class="tag">${esc(cname(a.country))}</span>` : ""}
        <span class="tag" title="${esc(a.scenario||"")}">${
          esc(a.scenario_cn || (a.scenario||"").split("/").pop())}</span>
        ${machineTag(a.machine)}</span>
      <span class="v dim">${agoHours(a.age_hours)}</span>
    </div>`).join("");
  return card("安全态势", dot, `
    <div class="stats">
      <div class="stat"><div class="n">${d.active_bans ?? 0}</div><div class="l">当前封禁</div></div>
      <div class="stat"><div class="n" style="color:${alerts?"var(--warn)":"inherit"}">${alerts}</div>
        <div class="l">24h 告警</div></div>
      <div class="stat"><div class="n">${c.manual ?? 0}</div><div class="l">手动封禁</div></div>
    </div>
    ${recent ? `<div class="list">${recent}</div>`
             : `<div class="empty center">近期无攻击</div>`}`);
}

function renderStorage(sec, growth) {
  const d = sec?.data;
  if (!d?.volumes) return fail(sec, "存储");
  const rows = d.volumes.map(v => {
    if (!v.ok) return `<div class="row"><span class="k">${esc(v.label)}</span>
      <span class="v dim">${esc(v.error || "不可用")}</span></div>`;
    const snap = v.snapshot_count != null
      ? `<span class="tag">${v.snapshot_count} 快照</span>` : "";
    const g = growth?.[v.label];
    const pred = (g && !g.insufficient && g.days_to_full != null)
      ? `<span class="tag ${g.days_to_full < 30 ? "warn" : ""}">约 ${g.days_to_full} 天写满</span>`
      : "";
    return `<div style="padding:8px 0">
      <div class="row" style="border:none; padding:0 0 3px">
        <span class="k"><span>${esc(v.label)}</span>${snap}${pred}</span>
        <span class="v">${fmtBytes(v.free)} 可用<span class="unit">/ ${fmtBytes(v.total)}</span></span>
      </div>
      <div class="bar"><i class="${pctClass(v.percent)}" style="width:${Math.min(100,v.percent)}%"></i></div>
      <div class="sub" style="margin:0">已用 ${v.percent}%</div>
    </div>`;
  }).join("");
  return card("存储", d.level === "crit" ? "crit" : d.level === "warn" ? "warn" : "ok", rows);
}

function renderServices(sec) {
  const d = sec?.data;
  if (!d?.items) return fail(sec, "服务健康");
  const rows = d.items.map(s => `
    <div class="row">
      <span class="k"><span class="dot ${s.ok?"ok":"crit"}"></span><span>${esc(s.name)}</span></span>
      <span class="v ${s.ok?"":"dim"}">${s.ok ? s.latency_ms + " ms"
        : esc(s.error || s.status_code || "异常")}</span>
    </div>`).join("");
  return card("服务健康", d.down > 0 ? "crit" : "ok", `
    <div class="stats">
      <div class="stat"><div class="n" style="color:var(--ok)">${d.up}</div><div class="l">正常</div></div>
      <div class="stat"><div class="n" style="color:${d.down?"var(--crit)":"var(--faint)"}">${d.down}</div>
        <div class="l">异常</div></div>
    </div><div class="list">${rows}</div>`);
}

function renderHost(sec, series) {
  const d = sec?.data;
  if (!d?.ok) return fail(sec, siteName);
  const m = d.memory || {}, load1 = d.load?.[0];
  const loadPct = load1 != null && d.cpu_cores ? load1 / d.cpu_cores * 100 : null;
  const dot = (m.percent >= 90 || (loadPct != null && loadPct >= 100)) ? "warn" : "ok";
  return card(siteName, dot, `
    <div class="big">${d.cpu_percent ?? "—"}<span class="unit">% CPU</span></div>
    ${sparkline(series?.cpu, {min: 0, emptyText: "CPU 历史采集中"})}
    <div class="sub">${d.cpu_cores} 核 · 负载 ${d.load ? d.load.map(x=>x.toFixed(2)).join(" / ") : "—"}</div>
    <div style="margin-top:11px">
      <div class="row" style="border:none; padding:0 0 3px">
        <span class="k"><span>内存</span></span>
        <span class="v">${fmtBytes(m.used)} <span class="unit">/ ${fmtBytes(m.total)}</span></span>
      </div>
      <div class="bar"><i class="${pctClass(m.percent)}" style="width:${m.percent||0}%"></i></div>
    </div>
    <div class="row"><span class="k"><span>运行时长</span></span>
      <span class="v">${fmtDur(d.uptime_seconds)}</span></div>
    ${d.temperature != null ? `<div class="row"><span class="k"><span>温度</span></span>
      <span class="v">${d.temperature} °C</span></div>` : ""}`);
}

function renderNetwork(sec, series) {
  const d = sec?.data;
  if (!d?.ok) return fail(sec, "网络");
  return card("网络", "info", `
    <div class="stats">
      <div class="stat"><div class="n" style="font-size:19px">${fmtRate(d.rx_bytes_per_sec)}</div>
        <div class="l">下行</div></div>
      <div class="stat"><div class="n" style="font-size:19px">${fmtRate(d.tx_bytes_per_sec)}</div>
        <div class="l">上行</div></div>
    </div>
    ${sparkline(series?.net_rx, {min: 0, emptyText: "流量历史采集中"})}
    <div class="row"><span class="k"><span>网卡</span></span><span class="v">${esc(d.interface)}</span></div>
    <div class="row"><span class="k"><span>公网 IP</span></span>
      <span class="v mono">${esc(d.public_ip || "—")}</span></div>
    <div class="row"><span class="k"><span>累计收/发</span></span>
      <span class="v">${fmtBytes(d.rx_total)} / ${fmtBytes(d.tx_total)}</span></div>`);
}

function renderCerts(sec) {
  const d = sec?.data;
  if (!d?.items) return fail(sec, "证书");

  // 按剩余天数升序：域名一多，配置顺序就没意义了，最紧急的必须在最上面。
  // 读不到的排最前——那是比"快过期"更需要立刻看的状态
  const items = [...d.items].sort((a, b) =>
    (a.ok ? (a.days_left ?? 9999) : -1) - (b.ok ? (b.days_left ?? 9999) : -1));
  const urgent = items.filter(c => !c.ok || c.level === "crit" || c.level === "warn");
  const calm = items.filter(c => c.ok && c.level === "ok");
  // 异常的全列，正常的补到 7 行为止，剩下的收成一句话
  const show = urgent.concat(calm.slice(0, Math.max(0, 7 - urgent.length)));
  const hidden = items.length - show.length;

  const rows = show.map(c => {
    // 显示配置里的目标域名而不是证书 subject：用了通配符证书之后，
    // 一堆站点的 subject 全是同一个 *.example.com，光看它分不清是哪个
    const name = String(c.target || "").replace(/:443$/, "");
    if (!c.ok) return `<div class="row">
      <span class="k"><span>${esc(name)}</span></span>
      <span class="v"><span class="tag crit">读不到</span></span></div>`;
    const cls = c.level === "crit" ? "crit" : c.level === "warn" ? "warn" : "ok";
    return `<div class="row" title="${esc(c.subject || "")}　${esc(c.expires_at || "")}">
      <span class="k"><span>${esc(name)}</span>
        ${c.chain_valid ? "" : '<span class="tag warn">链不完整</span>'}</span>
      <span class="v"><span class="tag ${cls}">${c.days_left} 天</span></span>
    </div>`;
  }).join("");

  const bad = items.filter(c => !c.ok).length;
  const crit = items.filter(c => c.ok && c.level === "crit").length;
  const warn = items.filter(c => c.ok && c.level === "warn").length;
  const head = `<div class="stats">
    <div class="stat"><div class="n">${items.length}</div><div class="l">监控中</div></div>
    ${warn ? `<div class="stat"><div class="n" style="color:var(--warn)">${warn}</div>
      <div class="l">30 天内</div></div>` : ""}
    ${crit ? `<div class="stat"><div class="n" style="color:var(--crit)">${crit}</div>
      <div class="l">7 天内</div></div>` : ""}
    ${bad ? `<div class="stat"><div class="n" style="color:var(--crit)">${bad}</div>
      <div class="l">读不到</div></div>` : ""}
  </div>`;
  const tail = hidden > 0
    ? `<div class="note">其余 ${hidden} 张均在 ${calm[Math.max(0, 7 - urgent.length) - 1]?.days_left ?? 30} 天以上</div>`
    : "";
  return card("证书到期",
    d.level === "crit" ? "crit" : d.level === "warn" ? "warn" : "ok",
    head + rows + tail);
}

function renderPortsCard(sec) {
  const d = sec?.data;
  if (!d?.ok) return fail(sec, "端口暴露");
  const c = d.counts || {};
  const dot = c.public > 0 ? "warn" : "ok";
  const pub = (d.items || []).filter(x => x.level === "public").slice(0, 6).map(x => `
    <div class="row">
      <span class="k"><span class="mono">${x.port}</span>
        <span>${esc(x.owner || x.container || "未识别")}</span></span>
      <span class="v"><span class="tag warn">公网</span></span>
    </div>`).join("");
  return card("端口暴露", dot, `
    <div class="stats">
      <div class="stat"><div class="n" style="color:${c.public?"var(--warn)":"var(--faint)"}">${c.public ?? 0}</div>
        <div class="l">公网</div></div>
      <div class="stat"><div class="n">${c.lan ?? 0}</div><div class="l">内网</div></div>
      <div class="stat"><div class="n" style="color:var(--ok)">${c.safe ?? 0}</div>
        <div class="l">仅本机</div></div>
    </div>
    ${pub ? `<div class="list">${pub}</div>` : `<div class="empty center">无公网暴露端口</div>`}`);
}

function renderConnCard(sec) {
  const d = sec?.data;
  if (!d?.ok) return fail(sec, "活跃连接");
  const ext = (d.items || []).filter(x => !x.private && x.inbound).slice(0, 7);
  return card("活跃连接", d.external > 0 ? "info" : "ok", `
    <div class="stats">
      <div class="stat"><div class="n">${d.total}</div><div class="l">总连接</div></div>
      <div class="stat"><div class="n" style="color:${d.external?"var(--accent)":"var(--faint)"}">${d.external}</div>
        <div class="l">外部对端</div></div>
      <div class="stat"><div class="n">${d.inbound}</div><div class="l">入站</div></div>
    </div>
    ${ext.length ? `<div class="list">${ext.map(x => `
      <div class="row">
        <span class="k"><span class="mono">${esc(x.ip)}</span>
          ${x.country ? `<span class="tag">${esc(cname(x.country))}</span>` : ""}
          <span class="tag">:${x.port}</span></span>
        <span class="v dim">${x.count} 条</span>
      </div>`).join("")}</div>`
    : `<div class="empty center">当前无外部入站连接</div>`}`);
}

function renderDisksCard(sec) {
  const d = sec?.data;
  if (!d?.ok) return fail(sec, "硬盘健康");
  const dot = d.failing ? "crit" : d.aging ? "warn" : "ok";
  const rows = (d.items || []).map(x => {
    const cls = x.level === "crit" ? "crit" : x.level === "warn" ? "warn" : "ok";
    return `<div class="row">
      <span class="k"><span class="mono" style="color:var(--text)">${esc(x.device)}</span>
        <span style="font-size:12px">${esc((x.model || "").slice(0, 18))}</span>
        ${x.issues?.length ? `<span class="tag crit">${esc(x.issues[0])}</span>` : ""}
        ${x.stale_note ? `<span class="tag" title="${esc(x.stale_note)}">旧错误</span>` : ""}</span>
      <span class="v"><span class="tag ${cls}">${
        x.years != null ? x.years + " 年" : "—"}</span>${
        x.temp != null ? ` <span class="v dim">${x.temp}°C</span>` : ""}</span>
    </div>`;
  }).join("");
  const noRedund = (d.no_redundancy || []).length;
  return card("硬盘健康", dot, `
    <div class="stats">
      <div class="stat"><div class="n">${d.total}</div><div class="l">块硬盘</div></div>
      <div class="stat"><div class="n" style="color:${d.failing?"var(--crit)":"var(--faint)"}">${d.failing}</div>
        <div class="l">有坏道</div></div>
      <div class="stat"><div class="n" style="color:${d.aging?"var(--warn)":"var(--faint)"}">${d.aging}</div>
        <div class="l">高龄</div></div>
    </div>
    <div class="list">${rows}</div>
    ${noRedund ? `<div class="note"><b style="color:var(--warn)">${noRedund} 个阵列无冗余</b>：
      mdstat 里显示 raid1，但都是 [1/1] 单成员，只是为了以后能加盘扩容。
      任一盘故障即丢数据。</div>` : ""}
    ${(d.items || []).filter(x => x.stale_note).map(x =>
      `<div class="note">${esc(x.device)}：${esc(x.stale_note)}——
       坏道没有扩散，不计入告警</div>`).join("")}
    ${d.unavailable?.length ? `<div class="note">读不到 SMART：${
      d.unavailable.map(esc).join("、")}</div>` : ""}`);
}

function renderEngineCard(sec) {
  const d = sec?.data;
  if (!d?.ok) return fail(sec, "防护引擎");
  const wasted = (d.wasted_sources || []).length;
  const top = (d.sources || []).slice(0, 4).map(s => `
    <div class="row">
      <span class="k"><span>${esc(s.name)}</span>
        ${s.wasted ? '<span class="tag crit">白读</span>' : ""}</span>
      <span class="v dim">${s.lines.toLocaleString()} 行 ${
        s.parse_rate === null ? "" : `· ${s.parse_rate}%`}</span>
    </div>`).join("");
  return card("防护引擎", wasted ? "warn" : "ok", `
    <div class="stats">
      <div class="stat"><div class="n">${d.effective_sources}<span class="unit">/${(d.sources||[]).length}</span></div>
        <div class="l">有效日志源</div></div>
      <div class="stat"><div class="n">${d.overflowed_total}</div><div class="l">确认攻击</div></div>
      <div class="stat"><div class="n" style="color:${wasted?"var(--warn)":"var(--faint)"}">${wasted}</div>
        <div class="l">白读源</div></div>
    </div>
    <div class="list">${top}</div>`);
}

function renderContainersCard(sec) {
  const d = sec?.data;
  if (!d?.items) return fail(sec, "容器");
  const rows = d.items.slice(0, 14).map(c => `
    <div class="row">
      <span class="k"><span class="dot ${c.running?"ok":""}"></span><span>${esc(c.name)}</span></span>
      <span class="v ${c.running?"":"dim"}">${c.running
        ? (c.cpu_percent != null ? c.cpu_percent.toFixed(1) + "% · " : "") + fmtBytes(c.memory_bytes)
        : "已停止"}</span>
    </div>`).join("");
  return card("Docker 容器", d.stopped > 0 ? "warn" : "ok", `
    <div class="stats">
      <div class="stat"><div class="n" style="color:var(--ok)">${d.running}</div><div class="l">运行中</div></div>
      <div class="stat"><div class="n" style="color:var(--faint)">${d.stopped}</div><div class="l">已停止</div></div>
    </div><div class="list">${rows}</div>`, "span2");
}

/* 总览整块重绘。抽出来是为了让"展开某个节点"这类纯本地状态变化
   能直接重画，不用重新发一轮请求 */
function renderOverview(s) {
  const growth = window._growthCache;
  $("overview").innerHTML = [
    renderSecurity(s.crowdsec),
    renderNodesCard(s.nodes),
    renderStorage(s.storage, growth),
    renderHost(s.host, sparkCache),
    renderNetwork(s.network, sparkCache),
    renderServices(s.services),
    renderPortsCard(s.ports),
    renderConnCard(s.connections),
    renderEngineCard(s.engine),
    renderDisksCard(s.disks),
    renderCerts(s.certs),
    renderRemote(s.remote),
    renderContainersCard(s.containers),
  ].join("");
}

/* 被管理节点。每台一个带进度条的小格子，宽屏并排、手机单列。
   一开始做的是每台一行文字，横向对比是快，但"这台到底忙不忙"要读数字才知道；
   进度条能扫一眼看出来，多几台也不累。点格子展开细节。 */
let nodeOpen = null;

function nodeMetric(label, pct, extra) {
  const v = pct == null ? "—" : pct + "%";
  return `<div class="nm">
    <div class="nmk"><span>${label}</span><b>${v}</b></div>
    <div class="bar"><i class="${pctClass(pct || 0)}" style="width:${Math.min(100, pct || 0)}%"></i></div>
    ${extra ? `<div class="nmx">${extra}</div>` : ""}
  </div>`;
}

function renderNodesCard(sec) {
  const d = sec?.data;
  if (!d?.items?.length) return "";
  const bad = d.items.filter(n => !n.ok).length;
  const boxes = d.items.map(n => {
    if (!n.ok) {
      return `<div class="nodebox off">
        <div class="nodehead">${machineTag(n.name)}
          <span class="tag crit">离线</span></div>
        <div class="nmx" style="margin-top:8px">${esc(n.error || "")}</div>
      </div>`;
    }
    const m = n.memory || {}, c = n.containers || {}, cs = n.crowdsec || {};
    const worst = (n.disks || [])[0];          // 已按使用率降序，第一个最满
    // 三个百分比里最高的那个决定灯色。分开看容易漏——内存 90% 和磁盘 90%
    // 都是问题，但只盯负载就都看不见
    const peak = Math.max(n.load_percent || 0, m.percent || 0, worst?.percent || 0);
    const down = [
      cs.agent && cs.agent !== "active" ? "agent 停了" : null,
      cs.bouncer && cs.bouncer !== "active" ? "bouncer 停了" : null,
    ].filter(Boolean);
    return `<div class="nodebox nodeRow${nodeOpen === n.name ? " on" : ""}"
                 data-node="${esc(n.name)}">
      <div class="nodehead">
        <span class="dot ${peak > 90 ? "crit" : peak > 75 ? "warn" : "ok"}"></span>
        ${machineTag(n.name)}
        <span class="nodehost">${esc(n.hostname || "")}</span>
        <span class="nodelat">${n.latency_ms}ms</span>
      </div>
      ${down.length ? `<div class="nodealert">${down.map(esc).join(" · ")}</div>` : ""}
      <div class="nodemetrics">
        ${nodeMetric("负载", n.load_percent, `${n.cores} 核 · ${
          (n.load || []).map(x => x.toFixed(2)).join(" ")}`)}
        ${nodeMetric("内存", m.percent, `${fmtBytes(m.used)} / ${fmtBytes(m.total)}`)}
        ${worst ? nodeMetric(esc(worst.mount), worst.percent,
          `${fmtBytes(worst.available)} 可用${
            n.disks.length > 1 ? ` · 另 ${n.disks.length - 1} 个卷` : ""}`) : ""}
      </div>
      <div class="nodefoot">
        <span>容器 <b>${c.running}</b>/${c.total}</span>
        <span>端口 <b>${n.ports?.exposed ?? "—"}</b></span>
        ${cs.ipset_entries != null
          ? `<span>拦截 <b>${cs.ipset_entries.toLocaleString()}</b></span>` : ""}
        ${n.temp_c != null ? `<span>${n.temp_c}°C</span>` : ""}
        <span class="dim">${fmtDur(n.uptime_seconds)}</span>
      </div>
      ${nodeOpen === n.name ? nodeDetail(n) : ""}
    </div>`;
  }).join("");
  return card(`节点 <span class="right">${d.online}/${d.configured} 在线</span>`,
    bad ? "crit" : "ok",
    `<div class="nodegrid">${boxes}</div>
     <div class="note">通过 SSH 受限密钥采集，那把钥匙只能执行采集脚本，
       登不了 shell。点一台看磁盘、端口、服务明细</div>`, "full flat");
}

function nodeDetail(n) {
  const disks = (n.disks || []).map(x => `
    <div style="padding:4px 0">
      <div class="row" style="border:none; padding:0 0 3px">
        <span class="k"><span class="mono" style="font-size:12px">${esc(x.mount)}</span>
          <span class="tag">${esc(x.fs)}</span></span>
        <span class="v">${fmtBytes(x.used)}<span class="unit">/ ${fmtBytes(x.total)}</span></span>
      </div>
      <div class="bar"><i class="${pctClass(x.percent)}" style="width:${x.percent}%"></i></div>
    </div>`).join("");
  const ports = (n.ports?.items || []).slice(0, 14).map(p =>
    `<span class="tag" title="${esc(p.proc || "")}">${p.port}${
      p.proc ? " " + esc(p.proc) : ""}</span>`).join(" ");
  const svc = Object.entries(n.services || {}).map(([k, v]) =>
    `<span class="tag ${v === "active" ? "" : "crit"}">${esc(k)}</span>`).join(" ");
  return `<div class="nodedetail">
    <div class="nmx" style="margin-bottom:8px">
      ${esc(n.os || "")}
      ${Math.abs(n.clock_skew_seconds || 0) > 60
        ? ` · <span style="color:var(--warn)">时钟偏差 ${n.clock_skew_seconds}s</span>` : ""}
    </div>
    ${n.disks.length > 1 ? disks : ""}
    ${ports ? `<div style="margin-top:8px"><div class="nmx" style="margin-bottom:5px">
      对外监听 ${n.ports.exposed} 个端口（回环 ${n.ports.loopback} 个不计）</div>
      <div class="tagwrap">${ports}</div></div>` : ""}
    ${svc ? `<div style="margin-top:8px"><div class="nmx" style="margin-bottom:5px">服务</div>
      <div class="tagwrap">${svc}</div></div>` : ""}
  </div>`;
}

function renderRemote(sec) {
  const d = sec?.data;
  if (!d?.items?.length) return "";
  return d.items.map(h => {
    if (!h.ok) return card(esc(h.name), "crit",
      `<div class="empty center">${esc(h.error || "离线")}</div>`);
    const m = h.memory || {}, n = h.npu;
    let npuHtml = "";
    if (n) {
      const memPct = n.mem_total_mb ? (n.mem_used_mb / n.mem_total_mb * 100) : 0;
      npuHtml = `
        <div class="row"><span class="k"><span>NPU 算力</span></span>
          <span class="v">${n.aicore_percent != null ? n.aicore_percent + " %" : "—"}</span></div>
        <div class="row"><span class="k"><span>NPU 显存</span></span>
          <span class="v">${n.mem_used_mb ?? "—"} / ${n.mem_total_mb ?? "—"} MB</span></div>
        <div class="bar"><i class="${pctClass(memPct)}" style="width:${memPct}%"></i></div>
        ${n.temp_c != null ? `<div class="row"><span class="k"><span>温度</span></span>
          <span class="v">${n.temp_c} °C</span></div>` : ""}
        ${n.health_is_false_alarm
          ? `<div class="note">npu-smi 报 Alarm 属板级传感器缺失的固有现象，算力实测正常</div>` : ""}`;
    }
    return card(esc(h.name), "ok", `
      <div class="big sm">${h.load ? h.load[0].toFixed(2) : "—"}<span class="unit">负载</span></div>
      <div class="sub">运行 ${fmtDur(h.uptime_seconds)}</div>
      <div style="margin-top:11px">
        <div class="row" style="border:none; padding:0 0 3px"><span class="k"><span>内存</span></span>
          <span class="v">${fmtBytes(m.used)} <span class="unit">/ ${fmtBytes(m.total)}</span></span></div>
        <div class="bar"><i class="${pctClass(m.percent)}" style="width:${m.percent||0}%"></i></div>
      </div>${npuHtml}`);
  }).join("");
}

/* ================= 告警条 ================= */

let alertsExpanded = false;

function renderAlertBar(alerts) {
  // 被忽略的不占地方，pending 的还没坐实也不显示
  const items = (alerts?.active || []).filter(a => !a.pending && !a.muted);
  if (!items.length) { $("alertbar").innerHTML = ""; return; }

  const line = a => `
    <div class="alertline ${a.level === "crit" ? "crit" : ""}">
      <span class="dot ${a.level}"></span>
      <span class="t">${esc(a.title)}</span>
      <span class="d">${esc(a.detail || "")}</span>
      <span class="when">持续 ${fmtShort(a.duration)}${a.notified ? " · 已推送" : ""}</span>
      <button class="btn sm ghost" data-mute="${esc(a.key)}"
        title="不再显示也不再推送，可在设置页恢复">忽略</button>
    </div>`;

  // 三条以上默认折叠。硬盘服役年限这种告警会长期挂着，
  // 全摊开会把首屏顶掉一大块
  if (items.length > 2 && !alertsExpanded) {
    const crit = items.filter(a => a.level === "crit").length;
    $("alertbar").innerHTML = line(items[0]) + `
      <div class="alertline" style="cursor:pointer" id="alertMore">
        <span class="dot ${crit ? "crit" : "warn"}"></span>
        <span class="t">还有 ${items.length - 1} 条告警</span>
        <span class="d">${esc(items.slice(1, 4).map(a => a.title).join("、"))}</span>
        <span class="when">点击展开</span>
      </div>`;
    $("alertMore").onclick = () => { alertsExpanded = true; renderAlertBar(alerts); };
    return;
  }
  $("alertbar").innerHTML = items.map(line).join("") +
    (items.length > 2 ? `<div class="alertline" style="cursor:pointer" id="alertLess">
      <span class="t" style="color:var(--dim)">收起</span></div>` : "");
  const less = $("alertLess");
  if (less) less.onclick = () => { alertsExpanded = false; renderAlertBar(alerts); };
}

/* ================= 防火墙 ================= */

const KIND_LABEL = {manual:"手动", community:"社区", detected:"自动"};
const KIND_TAG = {manual:"accent", community:"", detected:"warn"};
let fwFilter = "all", fwQuery = "", fwMeta = null, fwConfirm = null;
let fwSearchResult = null, fwSearchTimer = null;

/* agent 心跳 30 秒一次、bouncer 默认 10 秒拉一次，所以两分钟没动静就是不对劲了。
   分三档而不是"在线/离线"：刚超时和断了一小时，处理的紧迫程度不一样 */
function liveState(sec) {
  if (sec == null) return {cls: "", txt: "未知"};
  if (sec < 120) return {cls: "ok", txt: fmtShort(sec) + "前"};
  if (sec < 900) return {cls: "warn", txt: fmtShort(sec) + "前"};
  return {cls: "crit", txt: fmtShort(sec) + "前"};
}

function renderFwNodes(d) {
  const nodes = d.nodes || [];
  const alertsBy = {};
  (d.by_machine || []).forEach(x => { alertsBy[x.machine] = x; });
  if (!nodes.length) {
    $("fwNodes").innerHTML = `<h2><span class="dot"></span>防护节点</h2>
      <div class="empty center">${esc(d.nodes_error || "读不到节点清单")}</div>`;
    return;
  }
  /* agent 和 bouncer 分开显示，不合并成一个"在线"状态：
     agent 停了是不再检测（已有封禁仍然拦），bouncer 停了是新决策落不了地，
     两种故障的后果完全不同，合并成一个灯就分不出该先修哪个 */
  const body = nodes.map(n => {
    const a = liveState(n.heartbeat_seconds);
    const b = n.bouncers.length
      ? liveState(Math.min(...n.bouncers.map(x => x.pull_seconds ?? 1e9)))
      : {cls: "crit", txt: "未接入"};
    const hit = alertsBy[n.name];
    return `<div class="row nodeLine">
      <span class="k">
        ${machineTag(n.name)}
        ${n.ip ? `<span class="mono" style="font-size:12px">${esc(n.ip)}</span>` : ""}
        ${n.os ? `<span class="tag">${esc(n.os)}</span>` : ""}
        ${!n.validated ? '<span class="tag crit">未批准</span>' : ""}
        ${hit ? `<span class="tag warn">告警 ${hit.count}${
          hit.recent ? ` · 24h ${hit.recent}` : ""}</span>` : ""}
      </span>
      <span class="v" style="font-size:12px">
        <span><span class="dot ${a.cls}"></span>检测 ${a.txt}</span>
        <span style="margin-left:10px"><span class="dot ${b.cls}"></span>拦截 ${b.txt}</span>
      </span>
    </div>`;
  }).join("");
  const orphans = d.orphan_bouncers || [];
  $("fwNodes").innerHTML = `<h2><span class="dot ${
    nodes.some(n => (n.heartbeat_seconds ?? 1e9) > 900) ? "warn" : "ok"}"></span>防护节点
    <span class="right">${nodes.length} 台接入同一套决策</span></h2>
    <div class="list">${body}</div>
    <div class="note">检测=本机 agent 上报心跳，拦截=本机 bouncer 拉取决策。
      在任意一台上的封禁操作对全部节点生效${
      orphans.length ? `。另有 ${orphans.length} 个未关联到机器的接入方（${
        orphans.map(o => esc(o.name)).join("、")}）` : ""}</div>`;
}

function renderFwStat(d) {
  const c = d.ban_counts || {};
  $("fwStat").innerHTML = `<h2><span class="dot ${d.active_bans?"warn":"ok"}"></span>封禁概况</h2>
    <div class="big">${(d.active_bans ?? 0).toLocaleString()}<span class="unit">条生效中</span></div>
    <div class="sub">数据源 ${esc(d.decisions_source || "—")}${
      d.truncated ? ` · 列表载入 ${d.listed}` : ""}</div>
    <div style="margin-top:14px">
      <div class="row"><span class="k"><span>手动封禁</span></span><span class="v">${c.manual ?? 0}</span></div>
      <div class="row"><span class="k"><span>本地检出</span></span><span class="v">${c.detected ?? 0}</span></div>
      <div class="row"><span class="k"><span>社区黑名单</span></span><span class="v">${c.community ?? 0}</span></div>
      <div class="row"><span class="k"><span>24h 告警</span></span><span class="v">${d.alerts_24h ?? 0}</span></div>
    </div>
    ${(d.nodes || []).length > 1
      ? `<div class="note">这些封禁下发到全部 ${d.nodes.length} 个节点，不区分是哪台检出的</div>`
      : ""}`;
}

function renderFwTop(d) {
  const top = d.top_sources || [];
  const banned = new Set((d.decisions || []).map(x => x.ip));
  const body = top.length ? top.map(s => {
    const isBanned = banned.has(s.ip);
    return `<div class="row">
      <span class="k">
        <span class="mono" style="color:var(--text)">${esc(s.ip)}</span>
        <span class="tag">${s.count} 次</span>
        ${(s.machines || []).map(m => machineTag(m)).join("")}
        ${(s.machines || []).length > 1
          ? '<span class="tag warn" title="同一个 IP 打了多台，说明它在扫全网，不是冲某一台来的">扫全网</span>'
          : ""}
        ${s.country ? `<span class="tag accent">${esc(cname(s.country))}</span>` : ""}
        ${s.as_name ? `<span style="font-size:12px">${esc(s.as_name)}</span>` : ""}
      </span>
      <span class="v">${isBanned
        ? '<span class="tag crit">已封禁</span>'
        : `<button class="btn sm ghost" data-ban="${esc(s.ip)}">封禁</button>`}</span>
    </div>`;
  }).join("") : `<div class="empty center">暂无攻击记录</div>`;
  $("fwTop").innerHTML = `<h2><span class="dot ${top.length?"warn":"ok"}"></span>攻击来源 TOP</h2>
    <div class="list">${body}</div>`;
}

function renderFwList(d) {
  // 搜索有结果时用后端返回的，否则用采集器下发的那批
  const source = fwSearchResult !== null ? fwSearchResult : (d.decisions || []);
  const rows = source.filter(x => fwFilter === "all" || x.kind === fwFilter);
  if (!rows.length) {
    $("fwList").innerHTML = `<div class="empty">${
      fwSearchResult !== null ? "库里没有匹配的封禁记录"
        : source.length ? "当前筛选下没有记录" : "当前无封禁"}</div>`;
    return;
  }
  const body = rows.slice(0, 400).map(x => {
    const kind = x.kind || "detected";
    const where = [x.country ? cname(x.country) : null, x.as_label || x.as_name]
      .filter(Boolean).join(" · ");
    const canUnban = kind !== "community";
    const pending = fwConfirm === x.ip;
    return `<tr>
      <td class="ipcell">${esc(x.ip)}${x.scope === "Range" ? ' <span class="tag">网段</span>' : ""}${
        x.machine ? " " + machineTag(x.machine) : ""}</td>
      <td><span class="tag ${KIND_TAG[kind]}">${KIND_LABEL[kind] || kind}</span></td>
      <td class="why opt" title="${esc(x.reason || "")}">${
        esc(x.reason_cn || (x.reason || "—").replace(/^.*\//, ""))}</td>
      <td class="why opt">${esc(where || "—")}</td>
      <td style="color:var(--dim); white-space:nowrap">${fmtLeft(x.expires_in)}</td>
      <td class="act">${canUnban
        ? `<button class="btn sm ${pending ? "confirm" : "ghost"}" data-unban="${esc(x.ip)}">${
            pending ? "确认解封" : "解封"}</button>`
        : `<span class="tag" title="社区黑名单由 CrowdSec 中心同步，解了会被同步回来">不可解</span>`}</td>
    </tr>`;
  }).join("");
  const hint = fwSearchResult !== null
    ? `搜索命中 ${rows.length} 条（直接查库，覆盖全部 ${d.active_bans} 条封禁）`
    : d.truncated
      ? `手动与自动检出的已全部列出；社区黑名单共 ${d.ban_counts?.community ?? 0} 条，
         此处只载入最近 ${(d.listed ?? 0) - (d.ban_counts?.manual ?? 0) - (d.ban_counts?.detected ?? 0)} 条。
         要找具体 IP 请用上方搜索框，它直接查库`
      : "";
  $("fwList").innerHTML = `<table class="tbl">
    <thead><tr><th>IP</th><th>来源</th><th class="opt">场景</th><th class="opt">归属</th><th>剩余</th><th></th></tr></thead>
    <tbody>${body}</tbody></table>
    ${hint ? `<div class="note">${hint}</div>` : ""}`;
}

function renderFwGeo(d) {
  const rows = d.by_country || [];
  const total = rows.reduce((s, x) => s + x.count, 0) || 1;
  $("fwGeo").innerHTML = `<h2><span class="dot info"></span>攻击来源国家
    <span class="right">近 ${(d.alerts || []).length} 条告警</span></h2>
    ${rows.length ? `<div class="list">${rows.map(x => {
      const pct = x.count / total * 100;
      return `<div style="padding:6px 0">
        <div class="row" style="border:none; padding:0 0 4px">
          <span class="k"><span style="color:var(--text)">${esc(cname(x.code))}</span>
            <span class="tag">${x.ips} 个 IP</span></span>
          <span class="v">${x.count} 次<span class="unit">${pct.toFixed(0)}%</span></span>
        </div>
        <div class="bar"><i style="width:${pct}%; background:var(--accent)"></i></div>
      </div>`;
    }).join("")}</div>
    <div class="note">按告警条数统计。同一个 IP 反复攻击会累加，所以另附独立 IP 数</div>`
    : `<div class="empty center">暂无来源数据</div>`}`;
}

function renderFwAsn(d) {
  const rows = d.by_asn || [];
  $("fwAsn").innerHTML = `<h2><span class="dot info"></span>来源网络运营商</h2>
    ${rows.length ? `<div class="list">${rows.map(x => `
      <div class="row">
        <span class="k"><span title="${esc(x.as_name || "")}">${esc(x.as_label || x.as_name)}</span>
          ${x.country ? `<span class="tag">${esc(cname(x.country))}</span>` : ""}</span>
        <span class="v">${x.count}</span>
      </div>`).join("")}</div>
    <div class="note">大量攻击集中在同一家 IDC 时，可以考虑整段封禁</div>`
    : `<div class="empty center">暂无 ASN 数据</div>`}`;
}

function renderFwSources(sec) {
  const d = sec?.data;
  if (!d?.ok) {
    $("fwSources").innerHTML = `<h2><span class="dot crit"></span>防护引擎</h2>
      <div class="empty center">${esc(sec?.error || d?.error || "读不到 metrics")}</div>`;
    return;
  }
  const wasted = d.wasted_sources || [];
  const rows = (d.sources || []).map(s => {
    const rate = s.parse_rate;
    const cls = rate === null ? "" : rate >= 50 ? "ok" : rate > 0 ? "warn" : "crit";
    return `<div class="row">
      <span class="k">
        <span style="color:var(--text)">${esc(s.name)}</span>
        <span class="tag">${esc(s.kind)}</span>
        ${s.wasted ? '<span class="tag crit">白读</span>' : ""}
      </span>
      <span class="v">${s.lines.toLocaleString()} 行
        <span class="tag ${cls}">${rate === null ? "—" : rate + "%"}</span></span>
    </div>`;
  }).join("");
  return $("fwSources").innerHTML = `
    <h2><span class="dot ${wasted.length ? "warn" : "ok"}"></span>防护引擎 · 日志源
      <span class="right">本机 · 有效 ${d.effective_sources}/${(d.sources||[]).length} 个</span></h2>
    <div class="list">${rows || '<div class="empty">无日志源</div>'}</div>
    ${wasted.length ? `<div class="note"><b style="color:var(--warn)">${wasted.length} 个源白读</b>：
      ${wasted.map(esc).join("、")}——配了采集但解析率 0%，说明缺对应的
      parser/collection，这些源上的攻击检测实际没生效。装上对应 collection 或从
      acquis.yaml 里移除，省 CPU。</div>` : ""}
    <div class="note">解析率按源单独算。全局算没意义——syslog 那几万行系统日志
      本来就没有对应解析器，混在一起会把 nginx 的 100% 拉到 1.7%。
      这块读的是<b>本机</b>引擎的 metrics（6060 端口），其他节点的日志源要登上去看，
      它们的告警结果则已经汇总在上面的列表里。</div>`;
}

function renderFwScenarios(sec) {
  const d = sec?.data;
  if (!d?.ok) { $("fwScenarios").innerHTML = ""; return; }
  const rows = (d.scenarios || []).slice(0, 10).map(s => `
    <div class="row">
      <span class="k"><span>${esc(s.short)}</span></span>
      <span class="v">${s.poured}
        ${s.overflowed ? `<span class="tag crit">${s.overflowed} 触发</span>`
                       : '<span class="tag">未触发</span>'}</span>
    </div>`).join("");
  $("fwScenarios").innerHTML = `
    <h2><span class="dot ${d.overflowed_total ? "warn" : "ok"}"></span>检测场景
      <span class="right">本机</span></h2>
    <div class="stats">
      <div class="stat"><div class="n">${d.poured_total}</div><div class="l">可疑事件</div></div>
      <div class="stat"><div class="n" style="color:${d.overflowed_total?"var(--crit)":"var(--faint)"}">${d.overflowed_total}</div>
        <div class="l">确认攻击</div></div>
    </div>
    ${rows ? `<div class="list">${rows}</div>` : '<div class="empty center">暂无场景命中</div>'}
    <div class="note">左边是进桶的可疑事件，右边是达到阈值真正触发决策的。
      两者差距大说明阈值设得合适，没有一有风吹草动就封人。
      白名单放过 ${d.whitelist_hits} 次。</div>`;
}

function renderFirewall(sec, engineSec) {
  const d = sec?.data;
  renderFwSources(engineSec); renderFwScenarios(engineSec);
  if (!d) {
    $("fwList").innerHTML = `<div class="empty">${esc(sec?.error || "CrowdSec 数据不可用")}</div>`;
    return;
  }
  renderFwNodes(d);
  renderFwStat(d); renderFwTop(d); renderFwGeo(d); renderFwAsn(d); renderFwList(d);
}

/* ================= 连接 ================= */

let connFilter = "external", connQuery = "";

function renderConns(sec) {
  const d = sec?.data;
  if (!d?.ok) {
    $("connList").innerHTML = `<div class="empty">${
      esc(sec?.error || d?.error || "连接数据不可用")}</div>`;
    $("connStat").innerHTML = `<h2><span class="dot crit"></span>连接概况</h2>
      <div class="empty center">不可用</div>`;
    $("connPorts").innerHTML = "";
    return;
  }

  $("connStat").innerHTML = `<h2><span class="dot ${d.external?"info":"ok"}"></span>连接概况</h2>
    <div class="big">${d.total}<span class="unit">条连接</span></div>
    <div class="sub">来自 ${d.peers} 个对端</div>
    <div style="margin-top:14px">
      <div class="row"><span class="k"><span>外部 IP</span></span>
        <span class="v" style="color:${d.external?"var(--accent)":"inherit"}">${d.external}</span></div>
      <div class="row"><span class="k"><span>入站</span></span><span class="v">${d.inbound}</span></div>
      <div class="row"><span class="k"><span>出站</span></span><span class="v">${d.outbound}</span></div>
    </div>
    ${d.odd ? `<div class="note"><b style="color:var(--warn)">${d.odd} 个对端状态异常</b>——
      握手未完成或程序没关连接，鼠标悬停状态标签看说明</div>` : ""}
    <div class="note"><b>状态怎么看</b>：<span class="tag ok">已建立</span>正在通信；
      <span class="tag">等待回收</span>连接已结束，系统按规范等约 60 秒再回收端口，
      属正常现象；<span class="tag warn">握手中 / 待关闭</span>值得看一眼。</div>
    <div class="note">默认只统计外网对端。内网连接量大且无风险，
      在 config.yaml 里把 connections.show_private 设为 true 才会采集</div>`;

  const bp = d.by_port || [];
  $("connPorts").innerHTML = `<h2><span class="dot info"></span>入站连接按端口分布</h2>
    ${bp.length ? `<div class="list">${bp.map(p => `
      <div class="row">
        <span class="k"><span class="mono" style="color:var(--text)">${p.port}</span>
          <span>${esc(p.service || "未识别")}</span>
          <span class="tag">${p.peers} 个对端</span></span>
        <span class="v">${p.conns} 条</span>
      </div>`).join("")}</div>`
    : `<div class="empty center">当前没有入站连接</div>`}`;

  const q = connQuery.toLowerCase();
  const rows = (d.items || []).filter(x => {
    if (connFilter === "external" && x.private) return false;
    if (connFilter === "inbound" && !x.inbound) return false;
    if (connFilter === "outbound" && x.inbound) return false;
    if (!q) return true;
    return [x.ip, x.port, x.service, x.as_name, x.as_label, cname(x.country)]
      .some(v => String(v ?? "").toLowerCase().includes(q));
  });

  $("connNote").textContent = `${rows.length} 条匹配` + (d.truncated ? "（已截断）" : "");
  $("connList").innerHTML = rows.length ? `<table class="tbl">
    <thead><tr><th>对端 IP</th><th>方向</th><th>本地端口</th><th class="opt">归属</th>
      <th>连接数</th><th class="opt">状态</th><th></th></tr></thead>
    <tbody>${rows.map(x => {
      const where = [x.country ? cname(x.country) : null, x.as_label || x.as_name]
        .filter(Boolean).join(" · ");
      return `<tr>
        <td class="ipcell">${esc(x.ip)}${x.private
          ? ' <span class="tag">内网</span>' : ""}</td>
        <td><span class="tag ${x.inbound ? "accent" : ""}">${
          x.inbound ? "对方连我" : "我连出去"}</span></td>
        <td class="ipcell">${x.port}${x.service
          ? ` <span style="font-family:var(--sans); color:var(--dim)">${esc(x.service)}</span>` : ""}</td>
        <td class="why opt">${esc(where || "—")}</td>
        <td style="font-variant-numeric:tabular-nums">${x.count}</td>
        <td class="opt"><span class="tag ${
          x.state_tone === "live" ? "ok" : x.state_tone === "odd" ? "warn" : ""}"
          title="${esc(x.state_desc || "")}${x.state_mix ? "\n本对端状态分布：" + esc(x.state_mix) : ""}"
          >${esc(x.state)}${x.state_mix ? " +" : ""}</span></td>
        <td class="act">${x.private ? "" :
          `<button class="btn sm ghost" data-ban="${esc(x.ip)}">封禁</button>
           <button class="btn sm ghost" data-wl="${esc(x.ip)}">加白</button>`}</td>
      </tr>`;
    }).join("")}</tbody></table>` : `<div class="empty">没有匹配的连接</div>`;
}

/* ================= 白名单 ================= */

let wlConfirm = null;

async function loadWhitelist() {
  let d;
  try {
    d = await (await fetch("/api/firewall/whitelist")).json();
  } catch (e) {
    $("wlList").innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`;
    return;
  }
  const items = d.items || [];
  const released = d.recent_released || [];
  $("wlList").innerHTML = (items.length ? `<table class="tbl">
    <thead><tr><th>IP / 网段</th><th>备注</th><th>加入时间</th>
      <th>已放行</th><th></th></tr></thead>
    <tbody>${items.map(x => {
      const pending = wlConfirm === x.ip;
      return `<tr>
        <td class="ipcell">${esc(x.ip)}</td>
        <td class="why">${esc(x.note || "—")}</td>
        <td style="color:var(--dim); white-space:nowrap">${clock(x.added_at)}</td>
        <td style="font-variant-numeric:tabular-nums">${x.hits || 0} 次${
          x.last_hit ? `<span style="color:var(--faint)"> · ${ago(x.last_hit)}</span>` : ""}</td>
        <td class="act"><button class="btn sm ${pending ? "confirm" : "ghost"}"
          data-wldel="${esc(x.ip)}">${pending ? "确认移除" : "移除"}</button></td>
      </tr>`;
    }).join("")}</tbody></table>`
    : `<div class="empty">白名单为空</div>`) +
    (released.length ? `<div class="note">最近自动放行：${
      released.slice(-5).map(r => esc(r.ip)).join("、")}</div>` : "") +
    `<div class="note">这不是 CrowdSec 原生 whitelist（那要改配置文件加重启，容器里做不到）。
     实现方式是每轮采集后比对封禁列表，命中就立刻调 LAPI 解封——IP 仍会被封最多一个
     采集周期（30 秒），但不用碰 CrowdSec 任何配置，社区黑名单同步进来也照样能捞回。</div>`;
}

async function doWhitelistAdd(ip, note) {
  try {
    const r = await api("/api/firewall/whitelist", "POST", {ip, note});
    toast(`已加入白名单 ${r.ip}`,
      r.released ? `顺带解封了 ${r.released} 条现有封禁` : "");
    $("wlIp").value = ""; $("wlNote").value = "";
    await loadWhitelist();
    await refresh();
  } catch (e) {
    toast("加白名单失败", e.message, true);
  }
}

async function doWhitelistRemove(ip) {
  try {
    await api(`/api/firewall/whitelist/${encodeURIComponent(ip)}`, "DELETE");
    toast(`已移出白名单 ${ip}`, "");
  } catch (e) {
    toast("移除失败", e.message, true);
  }
  wlConfirm = null;
  await loadWhitelist();
}

/* ================= 端口 ================= */

let portFilter = "all", portQuery = "";
const PLEVEL = {public:{t:"公网暴露",c:"warn"}, lan:{t:"内网可达",c:""}, safe:{t:"仅本机",c:"ok"}};

function renderPorts(sec) {
  const d = sec?.data;
  if (!d?.ok) {
    $("portList").innerHTML = `<div class="empty">${esc(sec?.error || d?.error || "端口数据不可用")}</div>`;
    $("portStat").innerHTML = `<h2><span class="dot crit"></span>端口概况</h2>
      <div class="empty center">不可用</div>`;
    $("portPublic").innerHTML = "";
    return;
  }
  const c = d.counts || {};
  $("portStat").innerHTML = `<h2><span class="dot ${c.public?"warn":"ok"}"></span>端口概况</h2>
    <div class="big">${d.total}<span class="unit">个监听</span></div>
    <div style="margin-top:14px">
      <div class="row"><span class="k"><span>公网暴露</span></span>
        <span class="v" style="color:${c.public?"var(--warn)":"inherit"}">${c.public ?? 0}</span></div>
      <div class="row"><span class="k"><span>内网可达</span></span><span class="v">${c.lan ?? 0}</span></div>
      <div class="row"><span class="k"><span>仅本机</span></span><span class="v">${c.safe ?? 0}</span></div>
      <div class="row"><span class="k"><span>放行脚本</span></span>
        <span class="v">${d.guard_found ? d.guard_ports.length + " 个放行" : "未读到"}</span></div>
    </div>
    ${d.guard_found ? "" : `<div class="note">未配置或读不到放行脚本，无法判断防火墙放行情况，
      所有绑 0.0.0.0 的端口一律按内网可达处理</div>`}`;

  const pub = (d.items || []).filter(x => x.level === "public");
  $("portPublic").innerHTML = `<h2><span class="dot ${pub.length?"warn":"ok"}"></span>公网暴露面</h2>
    ${pub.length ? `<div class="list">${pub.map(x => `
      <div class="row">
        <span class="k"><span class="mono" style="color:var(--text)">${x.port}/${x.proto}</span>
          <span>${esc(x.owner || x.container || "未识别")}</span></span>
        <span class="v dim" style="font-size:12px">${esc(x.addrs.join(" "))}</span>
      </div>`).join("")}</div>
      <div class="note">这些端口配置里声明了对公网开放。确认每一个都是你有意开的</div>`
    : `<div class="empty center">配置里没有声明任何公网端口</div>`}`;

  const q = portQuery.toLowerCase();
  const rows = (d.items || []).filter(x => {
    if (portFilter !== "all" && x.level !== portFilter) return false;
    if (!q) return true;
    return [x.port, x.owner, x.container, x.note].some(v =>
      String(v ?? "").toLowerCase().includes(q));
  });
  $("portList").innerHTML = rows.length ? `<table class="tbl">
    <thead><tr><th>端口</th><th class="opt">协议</th><th>归属</th><th class="opt">绑定地址</th>
      <th>可达范围</th><th class="opt">说明</th></tr></thead>
    <tbody>${rows.map(x => {
      const lv = PLEVEL[x.level] || {t:x.level, c:""};
      return `<tr>
        <td class="ipcell" style="font-weight:600">${x.port}</td>
        <td class="opt" style="color:var(--dim)">${esc(x.proto)}</td>
        <td>${esc(x.owner || x.container || "—")}
          ${x.container ? '<span class="tag">容器</span>' : ""}</td>
        <td class="mono opt" style="color:var(--dim); font-size:12px">${esc(x.addrs.join(" "))}</td>
        <td><span class="tag ${lv.c}">${lv.t}</span></td>
        <td class="why opt">${esc(x.note)}</td>
      </tr>`;
    }).join("")}</tbody></table>` : `<div class="empty">没有匹配的端口</div>`;
}

/* ================= 历史 ================= */

let histRange = 24, histLoaded = false;
const SPARK_METRICS = "cpu,mem,net_rx,net_tx,load1,bans";

async function loadHistory() {
  const wanted = ["cpu", "mem", "net_rx", "net_tx", "load1", "temp", "bans"];
  const vols = (lastSections?.storage?.data?.volumes || [])
    .filter(v => v.ok).map(v => `vol:${v.label}`);
  const metrics = wanted.concat(vols).join(",");
  let data;
  try {
    const res = await fetch(
      `/api/history/multi?metrics=${encodeURIComponent(metrics)}&hours=${histRange}&points=140`);
    data = await res.json();
  } catch (e) {
    $("histCharts").innerHTML = `<div class="card full"><div class="empty">
      历史数据加载失败：${esc(e.message)}</div></div>`;
    return;
  }
  const S = data.series || {};
  const has = k => (S[k] || []).length >= 2;
  const pct = v => v.toFixed(0) + "%";
  const rate = v => fmtBytes(v) + "/s";

  // 单位相同的指标合并成一张多线图：九张各画一条线的小图占了满满两行，
  // 而且 CPU 和内存分开看反而难判断"是谁在吃资源"。上下行流量同理，
  // 共用一根纵轴才比得出比例。
  // floor/ceil 是数值天花板（占用率不可能为负、不会超 100），minSpan 决定
  // 平稳数据留多大的"呼吸空间"，两者一起防住纵轴被噪音撑爆
  const groups = [
    ["处理器与内存", [["CPU", "cpu"], ["内存", "mem"]],
     {floor: 0, ceil: 100, minSpan: 15, fmt: pct}],
    ["网络流量", [["下行", "net_rx"], ["上行", "net_tx"]],
     {floor: 0, fmt: rate}],
    ["存储使用率", vols.map(v => [v.replace("vol:", ""), v]),
     {floor: 0, ceil: 100, minSpan: 12, fmt: pct}],
    ["系统负载", [["1 分钟", "load1"]],
     {floor: 0, minSpan: 0.5, fmt: v => v.toFixed(2)}],
  ];

  $("histCharts").innerHTML = groups.map(([title, defs, opts]) => {
    const lines = defs.filter(([, k]) => has(k))
                      .map(([name, k]) => ({name, points: S[k]}));
    // 一条线都没有的分组直接不渲染，别留一堆"暂无数据"的空卡片
    if (!lines.length) return "";
    return card(title, "info", chart(lines, opts), "flat");
  }).join("") || `<div class="card full flat"><div class="empty">
    历史数据采集中，稍后再来看</div></div>`;

  // 时间范围在四张图里是同一段，标在区块标题上一次就够
  const span = [S.cpu, S.mem, S.load1].find(s => (s || []).length >= 2);
  $("histSpan").textContent = span
    ? timeSpan(span[0].ts, span[span.length - 1].ts) : "";

  // 封禁数量常年是一条水平线（社区黑名单基本不动），画成趋势图纯属浪费
  // 一整张卡；改成数字 + 窗口内净增，反而一眼看得出有没有变化
  const bans = S.bans || [];
  const delta = bans.length >= 2 ? bans[bans.length - 1].avg - bans[0].avg : null;
  $("banStat").innerHTML = `<h2><span class="dot"></span>封禁总量</h2>
    <div class="stats"><div class="stat">
      <div class="n">${bans.length ? Math.round(bans[bans.length-1].avg) : "—"}</div>
      <div class="l">当前生效</div></div>
      ${delta != null ? `<div class="stat">
        <div class="n" style="color:${delta > 0 ? "var(--warn)" : "inherit"}">${
          delta > 0 ? "+" : ""}${Math.round(delta)}</div>
        <div class="l">本窗口净增</div></div>` : ""}</div>
    <div class="note">绝大部分来自社区黑名单，平时几乎不动。
      短时间内大幅上涨说明本机检出了新的攻击源</div>`;

  const stats = await fetch("/api/history/metrics").then(r => r.json()).catch(() => null);
  const st = stats?.stats;
  $("histNote").innerHTML = `<h2><span class="dot ${st?.enabled ? "ok" : "warn"}"></span>采样健康</h2>
    ${!st?.enabled ? `<div class="empty">历史记录未启用</div>` : `
    <div class="stats">
      <div class="stat"><div class="n">${st.metric_rows ?? 0}</div><div class="l">指标采样</div></div>
      <div class="stat"><div class="n">${st.event_rows ?? 0}</div><div class="l">事件</div></div>
      <div class="stat"><div class="n">${fmtBytes(st.db_bytes)}</div><div class="l">库大小</div></div>
    </div>
    <div class="row"><span class="k"><span>最早记录</span></span>
      <span class="v dim">${st.oldest_ts ? `${clock(st.oldest_ts)} · ${ago(st.oldest_ts)}`
        : "—"}</span></div>
    <div class="row"><span class="k"><span>保留期</span></span>
      <span class="v">${st.retain_days} 天</span></div>`}`;

  const ev = await fetch("/api/history/events?limit=80").then(r => r.json()).catch(() => null);
  const events = ev?.events || [];
  $("histEvents").innerHTML = events.length ? events.map(e => `
    <div class="tl-item ${e.level}">
      <div class="t">${esc(e.title)}
        <span class="tag ${e.kind === "ban" ? "accent" : ""}">${esc(e.kind)}</span></div>
      ${e.detail ? `<div class="d">${esc(e.detail)}</div>` : ""}
      <div class="when">${clock(e.ts)} · ${ago(e.ts)}</div>
    </div>`).join("") : `<div class="empty">还没有事件记录</div>`;

  const gr = await fetch(`/api/history/growth?hours=${Math.max(24, histRange)}`)
    .then(r => r.json()).catch(() => null);
  const gv = gr?.volumes || {};
  const grows = Object.entries(gv);
  $("histGrowth").innerHTML = `<h2><span class="dot info"></span>容量预测</h2>
    ${grows.length ? grows.map(([label, g]) => `
      <div class="row">
        <span class="k"><span>${esc(label)}</span></span>
        <span class="v">${!g ? '<span class="tag">数据不足</span>'
          : g.insufficient
            ? `<span class="tag" title="线性外推需要足够长的观测窗口，否则启动波动会被放大成趋势">
               积累中 ${g.span_hours}/24 小时</span>`
          : g.days_to_full == null ? '<span class="tag ok">未见增长</span>'
          : `<span class="tag ${g.days_to_full < 30 ? "warn" : ""}">${g.days_to_full} 天写满</span>`}</span>
      </div>
      ${g && g.per_day ? `<div class="sub" style="margin:0 0 6px">
        日均 ${g.per_day > 0 ? "+" : ""}${g.per_day}%</div>` : ""}`).join("")
    : `<div class="empty">采集满 24 小时后给出预测</div>`}
    <div class="note">按最近 ${Math.max(24, histRange)} 小时的增长速度线性外推。
      观测窗口不足 24 小时不给结论——启动阶段的波动外推出来会是个吓人的假数字。</div>`;
  histLoaded = true;
}

/* ================= 设置 ================= */

let setData = null;

async function loadSettings() {
  try {
    setData = await (await fetch("/api/alerts/settings")).json();
  } catch (e) {
    $("setRules").innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`;
    return;
  }
  const g = setData.global || {};
  $("setNotify").innerHTML = setData.notify_enabled
    ? '<span class="tag ok">Server 酱已接入</span>'
    : '<span class="tag warn">推送未启用</span>';

  $("setGlobal").innerHTML = `
    <div class="row">
      <span class="k"><span>启用告警</span></span>
      <span class="v"><input type="checkbox" id="gEnabled" ${g.enabled ? "checked" : ""}
        style="width:auto"></span>
    </div>
    <div class="row">
      <span class="k"><span>抖动抑制</span>
        <span class="tag">异常持续这么久才推送</span></span>
      <span class="v"><input type="number" id="gSustain" value="${g.sustain_seconds}"
        min="0" max="3600" style="width:88px"> 秒</span>
    </div>
    <div class="row">
      <span class="k"><span>重复提醒间隔</span>
        <span class="tag">问题没解决时隔多久再提醒</span></span>
      <span class="v"><input type="number" id="gRepeat" value="${g.repeat_hours}"
        min="1" max="720" style="width:88px"> 小时</span>
    </div>`;

  $("setRules").innerHTML = (setData.rules || []).map(r => `
    <div style="padding:11px 0; border-bottom:1px solid var(--border)">
      <div class="row" style="border:none; padding:0">
        <span class="k">
          <input type="checkbox" data-rule="${esc(r.key)}" ${r.enabled ? "checked" : ""}
            style="width:auto; margin-right:4px">
          <span style="color:var(--text); font-weight:500">${esc(r.name)}</span>
          ${r.overridden ? '<span class="tag accent">已调整</span>' : ""}
        </span>
        <span class="v">${r.fields.map(f => `
          <span style="margin-left:12px; color:var(--dim); font-size:12.5px">${esc(f.label)}
            <input type="number" data-field="${esc(r.key)}.${esc(f.key)}"
              value="${f.value ?? ""}" min="${f.min ?? 0}" max="${f.max ?? 9999}"
              style="width:72px; margin-left:5px"> ${esc(f.unit || "")}</span>`).join("")}</span>
      </div>
      <div class="sub" style="margin:3px 0 0 24px">${esc(r.desc)}</div>
    </div>`).join("");

  const muted = setData.muted || [];
  $("setMuted").innerHTML = muted.length ? `<table class="tbl">
    <thead><tr><th>告警</th><th>忽略至</th><th></th></tr></thead>
    <tbody>${muted.map(m => `<tr>
      <td class="ipcell">${esc(m.key)}</td>
      <td style="color:var(--dim)">${m.until ? clock(m.until) : "永久"}</td>
      <td class="act"><button class="btn sm ghost" data-unmute="${esc(m.key)}">恢复</button></td>
    </tr>`).join("")}</tbody></table>`
    : `<div class="empty">没有被忽略的告警</div>`;
}

async function saveSettings() {
  const rules = {};
  document.querySelectorAll("[data-rule]").forEach(el => {
    rules[el.dataset.rule] = {enabled: el.checked};
  });
  document.querySelectorAll("[data-field]").forEach(el => {
    const [key, field] = el.dataset.field.split(".");
    if (el.value !== "") {
      rules[key] = rules[key] || {};
      rules[key][field] = parseFloat(el.value);
    }
  });
  const body = {rules, global: {
    enabled: $("gEnabled").checked,
    sustain_seconds: parseInt($("gSustain").value) || 120,
    repeat_hours: parseFloat($("gRepeat").value) || 12,
  }};
  try {
    await api("/api/alerts/settings", "PUT", body);
    toast("告警规则已保存", "立即生效，无需重启");
    await loadSettings();
    await refresh();
  } catch (e) {
    toast("保存失败", e.message, true);
  }
}

async function doMute(key, hours) {
  try {
    await api("/api/alerts/mute", "POST", {key, hours});
    toast(`已忽略 ${key}`, hours ? `${hours} 小时后恢复` : "可在设置页恢复");
    await refresh();
    if (activeTab === "settings") loadSettings();
  } catch (e) {
    toast("操作失败", e.message, true);
  }
}

/* ================= 操作审计 ================= */

let auditFailedOnly = false;

const ACTION_LABEL = [
  [/\/api\/firewall\/ban$/, "封禁 IP"],
  [/\/api\/firewall\/unban$/, "解封 IP"],
  [/\/api\/firewall\/whitelist$/, "加白名单"],
  [/\/api\/firewall\/whitelist\//, "移除白名单"],
  [/\/api\/containers\/.+\/restart$/, "重启容器"],
  [/\/api\/containers\/.+\/stop$/, "停止容器"],
  [/\/api\/containers\/.+\/start$/, "启动容器"],
  [/\/api\/alerts\/test$/, "测试推送"],
  [/^\/$/, "打开面板"],
];
const actionName = path => {
  for (const [re, name] of ACTION_LABEL) if (re.test(path)) return name;
  return path;
};

async function loadAudit() {
  let d;
  try {
    d = await (await fetch(
      `/api/audit?limit=300&hours=720${auditFailedOnly ? "&failed=true" : ""}`)).json();
  } catch (e) {
    $("auditList").innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`;
    return;
  }
  const sum = d.summary || {};
  $("auditStat").innerHTML = `<h2><span class="dot ${sum.failed ? "warn" : "ok"}"></span>访问概况
    <span class="right">近 30 天</span></h2>
    <div class="stats">
      <div class="stat"><div class="n">${sum.total ?? 0}</div><div class="l">操作次数</div></div>
      <div class="stat"><div class="n" style="color:${sum.failed?"var(--warn)":"var(--faint)"}">${sum.failed ?? 0}</div>
        <div class="l">失败/被拒</div></div>
      <div class="stat"><div class="n">${(sum.by_ip || []).length}</div><div class="l">来源 IP</div></div>
    </div>
    ${(sum.by_ip || []).length ? `<div class="list">${sum.by_ip.map(x => `
      <div class="row">
        <span class="k"><span class="mono">${esc(x.ip)}</span>
          ${x.failed ? `<span class="tag warn">${x.failed} 次失败</span>` : ""}</span>
        <span class="v dim">${x.count} 次 · ${ago(x.last)}</span>
      </div>`).join("")}</div>`
      : `<div class="empty center">还没有记录</div>`}
    <div class="note">面板没有登录体系，这里是唯一能看出"谁动过防火墙"的地方。
      出现意料之外的来源 IP 要当回事。</div>`;

  const items = d.items || [];
  $("auditList").innerHTML = items.length ? `<table class="tbl">
    <thead><tr><th>时间</th><th>来源</th><th>操作</th><th>结果</th><th class="opt">耗时</th></tr></thead>
    <tbody>${items.map(x => {
      const bad = x.status >= 400;
      return `<tr>
        <td style="white-space:nowrap; color:var(--dim)">${clock(x.ts)}</td>
        <td class="ipcell">${esc(x.ip || "?")}</td>
        <td>${esc(actionName(x.path))}
          <span style="color:var(--faint); font-size:11.5px">${esc(x.method)}</span></td>
        <td><span class="tag ${bad ? "crit" : "ok"}">${x.status}</span>
          ${x.detail ? `<span style="color:var(--dim); font-size:12px"> ${esc(x.detail)}</span>` : ""}</td>
        <td class="opt" style="color:var(--faint); font-variant-numeric:tabular-nums">${
          x.ms != null ? x.ms.toFixed(0) + " ms" : "—"}</td>
      </tr>`;
    }).join("")}</tbody></table>`
    : `<div class="empty">${auditFailedOnly ? "没有失败的操作" : "还没有操作记录"}</div>`;
}

/* ================= 容器 ================= */

let ctrConfirm = null;

function renderContainerTab(sec) {
  const d = sec?.data;
  if (!d?.items) {
    $("ctrList").innerHTML = `<div class="empty">${esc(sec?.error || "容器数据不可用")}</div>`;
    return;
  }
  const protectedSet = new Set(fwMeta?.protected_containers || []);
  const canAct = fwMeta?.actions_enabled !== false;
  $("ctrNote").textContent = canAct
    ? `${protectedSet.size} 个容器受保护，不可停止`
    : "容器操作已在配置中禁用";

  $("ctrList").innerHTML = `<table class="tbl">
    <thead><tr><th>容器</th><th>状态</th><th class="opt">CPU</th><th>内存</th><th></th></tr></thead>
    <tbody>${d.items.map(c => {
      const prot = protectedSet.has(c.name);
      const pending = ctrConfirm === c.name;
      let btns = `<button class="btn sm ghost" data-logs="${esc(c.name)}">日志</button>`;
      if (canAct) {
        if (c.running) {
          btns += prot
            ? ` <span class="tag" title="停了面板就失去控制能力">受保护</span>`
            : ` <button class="btn sm ${pending ? "confirm" : "ghost"}"
                 data-ctr="${esc(c.name)}" data-act="restart">${
                 pending ? "确认重启" : "重启"}</button>
               <button class="btn sm ghost" data-ctr="${esc(c.name)}" data-act="stop">停止</button>`;
        } else {
          btns += ` <button class="btn sm" data-ctr="${esc(c.name)}" data-act="start">启动</button>`;
        }
      }
      return `<tr>
        <td><span class="dot ${c.running?"ok":""}" style="display:inline-block;
          margin-right:7px"></span>${esc(c.name)}</td>
        <td>${c.running ? '<span class="tag ok">运行中</span>'
                        : '<span class="tag">已停止</span>'}</td>
        <td class="opt" style="font-variant-numeric:tabular-nums">${
          c.cpu_percent != null ? c.cpu_percent.toFixed(1) + "%" : "—"}</td>
        <td style="font-variant-numeric:tabular-nums">${fmtBytes(c.memory_bytes)}</td>
        <td class="act">${btns}</td>
      </tr>`;
    }).join("")}</tbody></table>`;
}

async function loadSnapshots() {
  const keep = parseInt($("snapKeep").value) || 10;
  let d;
  try {
    d = await (await fetch(`/api/snapshots?keep=${keep}`)).json();
  } catch (e) {
    $("snapList").innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`;
    return;
  }
  const groups = d.groups || [];
  if (!groups.length) {
    $("snapList").innerHTML = `<div class="empty">没有读到快照。
      确认 config.yaml 的 snapshot_mounts 已配置，且容器有 SYS_ADMIN 权限</div>`;
    return;
  }
  $("snapList").innerHTML = groups.map(g => `
    <div style="margin-bottom:18px">
      <div class="row" style="border:none; padding:0 0 8px">
        <span class="k"><span style="color:var(--text); font-weight:500">${esc(g.label)}</span>
          <span class="tag">${g.total} 个快照</span>
          ${g.stale.length ? `<span class="tag warn">${g.stale.length} 个超出保留数</span>`
                           : '<span class="tag ok">无需清理</span>'}</span>
        ${g.stale.length ? `<button class="btn sm ghost" data-copy="${esc(g.command)}">
          复制清理命令</button>` : ""}
      </div>
      ${g.stale.length ? `<div class="scroll" style="max-height:190px">
        <table class="tbl"><tbody>${g.stale.map(s => `
          <tr><td class="mono" style="font-size:12px">${esc(s.path)}</td>
              <td style="color:var(--faint); white-space:nowrap">${esc(s.when || "")}</td></tr>`
        ).join("")}</tbody></table></div>` : ""}
    </div>`).join("") +
    `<div class="callout" style="margin:0"><b>面板不执行删除。</b>${esc(d.note || "")}——
     卷是只读挂载，而面板没有登录，给它删快照的权限风险大于收益。</div>`;
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

/* ================= 调度 ================= */

let activeTab = "overview", lastData = null, lastSections = null, sparkCache = {};
// 站点名来自后端 config 的 site_name，用于头部与主机卡片标题。
// 拿到之前先用中性占位，别写死任何一台机器的名字
let siteName = "主机";
let demoShown = false;

document.querySelectorAll("nav button").forEach(b => {
  b.onclick = () => {
    activeTab = b.dataset.tab;
    document.querySelectorAll("nav button").forEach(x => x.classList.toggle("on", x === b));
    ["overview","firewall","conns","ports","history","containers","settings"].forEach(t =>
      $(t).classList.toggle("hide", t !== activeTab));
    if (activeTab === "history") { loadHistory(); loadAudit(); }
    if (activeTab === "containers") loadSnapshots();
    if (activeTab === "firewall") loadWhitelist();
    if (activeTab === "settings") loadSettings();
    refresh();
  };
});

$("banBtn").onclick = () => {
  const ip = $("banIp").value.trim();
  if (!ip) { toast("请填写 IP", "", true); $("banIp").focus(); return; }
  doBan(ip, $("banDur").value, $("banWhy").value.trim());
};
["banIp","banWhy"].forEach(id =>
  $(id).addEventListener("keydown", e => { if (e.key === "Enter") $("banBtn").click(); }));

$("setSave").onclick = saveSettings;
$("setReset").onclick = async () => {
  if (!confirm("恢复所有告警规则到 config.yaml 的默认值？")) return;
  try {
    await api("/api/alerts/settings", "PUT", {rules: {}, global: {}});
    await api("/api/alerts/settings", "PUT",
      {rules: Object.fromEntries((setData?.rules || []).map(r => [r.key, {}]))});
    toast("已恢复默认", "");
    await loadSettings();
  } catch (e) { toast("失败", e.message, true); }
};

$("tokenSave").onclick = () => {
  localStorage.setItem("panelToken", $("tokenIn").value);
  toast("令牌已保存", "存在本浏览器，不会上传");
};

$("fwSearch").addEventListener("input", e => {
  fwQuery = e.target.value.trim();
  clearTimeout(fwSearchTimer);
  if (!fwQuery) { fwSearchResult = null; if (lastData) renderFwList(lastData); return; }
  // 防抖 300ms，避免每敲一个字母打一次库
  fwSearchTimer = setTimeout(async () => {
    try {
      const r = await (await fetch(
        `/api/firewall/search?q=${encodeURIComponent(fwQuery)}&limit=400`)).json();
      fwSearchResult = r.items || [];
    } catch { fwSearchResult = []; }
    if (lastData) renderFwList(lastData);
  }, 300);
});
$("portSearch").addEventListener("input", e => {
  portQuery = e.target.value.trim();
  if (lastSections) renderPorts(lastSections.ports);
});
$("snapKeep").addEventListener("change", loadSnapshots);
$("connSearch").addEventListener("input", e => {
  connQuery = e.target.value.trim();
  if (lastSections) renderConns(lastSections.connections);
});
$("wlBtn").onclick = () => {
  const ip = $("wlIp").value.trim();
  if (!ip) { toast("请填写 IP", "", true); $("wlIp").focus(); return; }
  doWhitelistAdd(ip, $("wlNote").value.trim());
};
["wlIp","wlNote"].forEach(id =>
  $(id).addEventListener("keydown", e => { if (e.key === "Enter") $("wlBtn").click(); }));

document.querySelectorAll("[data-kind]").forEach(c => {
  c.onclick = () => {
    fwFilter = c.dataset.kind;
    document.querySelectorAll("[data-kind]").forEach(x => x.classList.toggle("on", x === c));
    if (lastData) renderFwList(lastData);
  };
});
document.querySelectorAll("[data-plevel]").forEach(c => {
  c.onclick = () => {
    portFilter = c.dataset.plevel;
    document.querySelectorAll("[data-plevel]").forEach(x => x.classList.toggle("on", x === c));
    if (lastSections) renderPorts(lastSections.ports);
  };
});
document.querySelectorAll("[data-conn]").forEach(c => {
  c.onclick = () => {
    connFilter = c.dataset.conn;
    document.querySelectorAll("[data-conn]").forEach(x => x.classList.toggle("on", x === c));
    if (lastSections) renderConns(lastSections.connections);
  };
});
document.querySelectorAll("[data-audit]").forEach(c => {
  c.onclick = () => {
    auditFailedOnly = c.dataset.audit === "failed";
    document.querySelectorAll("[data-audit]").forEach(x => x.classList.toggle("on", x === c));
    loadAudit();
  };
});
document.querySelectorAll("[data-range]").forEach(c => {
  c.onclick = () => {
    histRange = parseInt(c.dataset.range);
    document.querySelectorAll("[data-range]").forEach(x => x.classList.toggle("on", x === c));
    loadHistory();
  };
});

// 列表里的按钮每次重绘都是新元素，统一用事件委托
document.addEventListener("click", e => {
  const t = e.target;
  // 节点行展开/收起。用 closest 是因为点到的多半是行内的 span 而不是行本身
  const nodeRow = t.closest?.(".nodeRow");
  if (nodeRow) {
    const name = nodeRow.dataset.node;
    nodeOpen = nodeOpen === name ? null : name;
    if (lastSections && activeTab === "overview") renderOverview(lastSections);
    return;
  }
  if (t.dataset?.ban) { doBan(t.dataset.ban, $("banDur").value, "面板一键封禁"); return; }
  if (t.dataset?.unban) {
    const ip = t.dataset.unban;
    // 两段式确认：先点亮，再点才执行，避免在长列表里误触
    if (fwConfirm === ip) doUnban(ip);
    else {
      fwConfirm = ip;
      if (lastData) renderFwList(lastData);
      setTimeout(() => {
        if (fwConfirm === ip) { fwConfirm = null; if (lastData) renderFwList(lastData); }
      }, 4000);
    }
    return;
  }
  if (t.dataset?.ctr) {
    const name = t.dataset.ctr, act = t.dataset.act;
    if (act === "start") { doContainer(name, act); return; }
    if (ctrConfirm === name) doContainer(name, act);
    else {
      ctrConfirm = name;
      if (lastSections) renderContainerTab(lastSections.containers);
      setTimeout(() => {
        if (ctrConfirm === name) {
          ctrConfirm = null;
          if (lastSections && activeTab === "containers")
            renderContainerTab(lastSections.containers);
        }
      }, 4000);
    }
    return;
  }
  if (t.dataset?.wl) { doWhitelistAdd(t.dataset.wl, "从连接列表加白"); return; }
  if (t.dataset?.wldel) {
    const ip = t.dataset.wldel;
    if (wlConfirm === ip) doWhitelistRemove(ip);
    else {
      wlConfirm = ip; loadWhitelist();
      setTimeout(() => { if (wlConfirm === ip) { wlConfirm = null; loadWhitelist(); } }, 4000);
    }
    return;
  }
  if (t.dataset?.mute) { doMute(t.dataset.mute, null); return; }
  if (t.dataset?.unmute) {
    api(`/api/alerts/mute/${encodeURIComponent(t.dataset.unmute)}`, "DELETE")
      .then(() => { toast("已恢复", "该告警会重新出现"); loadSettings(); refresh(); })
      .catch(e => toast("恢复失败", e.message, true));
    return;
  }
  if (t.dataset?.logs) { showLogs(t.dataset.logs); return; }
  if (t.dataset?.copy) {
    navigator.clipboard.writeText(t.dataset.copy)
      .then(() => toast("命令已复制", "到宿主机上以 root 执行"))
      .catch(() => toast("复制失败", "浏览器拒绝了剪贴板访问", true));
  }
});

document.addEventListener("keydown", e => {
  if (e.key === "Escape" && $("modal").innerHTML) $("modal").innerHTML = "";
});

async function loadSparks() {
  try {
    const d = await (await fetch(
      `/api/history/multi?metrics=${SPARK_METRICS}&hours=6&points=60`)).json();
    sparkCache = d.series || {};
  } catch { /* 历史不可用不影响主面板 */ }
}

async function refresh() {
  try {
    const res = await fetch("/api/summary", {cache: "no-store"});
    if (!res.ok) throw new Error("HTTP " + res.status);
    const body = await res.json();
    const s = body.sections || {};
    lastSections = s;
    if (body.site_name && body.site_name !== siteName) {
      siteName = body.site_name;
      $("siteName").textContent = siteName;
    }
    if (body.demo && !demoShown) {
      demoShown = true;
      $("demoBar").classList.remove("hide");
    }
    lastData = s.crowdsec?.data || null;
    renderAlertBar(body.alerts);

    if (activeTab === "overview") {
      renderOverview(s);
    } else if (activeTab === "firewall") {
      renderFirewall(s.crowdsec, s.engine);
    } else if (activeTab === "conns") {
      renderConns(s.connections);
    } else if (activeTab === "ports") {
      renderPorts(s.ports);
    } else if (activeTab === "containers") {
      renderContainerTab(s.containers);
    }

    const crit = body.alerts?.crit || 0, warn = body.alerts?.warn || 0;
    const navBtn = document.querySelector('nav button[data-tab="overview"]');
    navBtn.innerHTML = "总览" + (crit ? `<span class="badge">${crit}</span>`
      : warn ? `<span class="badge warn">${warn}</span>` : "");

    const newest = Math.max(...Object.values(s)
      .map(x => x?.collected_at || 0).filter(Boolean), 0);
    $("updated").textContent = "更新于 " + ago(newest);
    $("pulse").style.background = "var(--ok)";
    document.body.classList.remove("stale");
  } catch (e) {
    $("updated").textContent = "连接失败：" + e.message;
    $("pulse").style.background = "var(--crit)";
    document.body.classList.add("stale");
  }
}

// 容量预测跟着存储采集的节奏走就够了，不必每 5 秒拉一次
async function loadGrowth() {
  try {
    const d = await (await fetch("/api/history/growth?hours=168")).json();
    window._growthCache = d.volumes || {};
  } catch { /* 忽略 */ }
}

// 滚动时收紧顶栏。用 rAF 去抖，scroll 事件触发很密
let ticking = false;
addEventListener("scroll", () => {
  if (ticking) return;
  ticking = true;
  requestAnimationFrame(() => {
    document.querySelector("header").classList.toggle("scrolled", scrollY > 24);
    ticking = false;
  });
}, {passive: true});

$("loginForm")?.addEventListener("submit", doLogin);

checkAuth();
loadMeta();
loadSparks();
loadGrowth();
refresh();
setInterval(refresh, 5000);
setInterval(loadSparks, 60000);
setInterval(loadGrowth, 300000);
document.addEventListener("visibilitychange", () => !document.hidden && refresh());
