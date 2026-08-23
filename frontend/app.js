/* Homelab 面板前端 · 页签与调度

   连接、端口、历史、设置、审计、容器这几个页签，加上整个调度层：
   导航、机器切换、5 秒轮询、事件委托、启动。

   调度必须最后加载——它引用前面三个文件里的几乎所有渲染函数。
   全站唯一一批顶层立即执行的语句也都在这个文件里，其余三个文件只有
   函数与常量声明，所以加载顺序只有这一条约束。

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
  /* 节点也有历史了。以前这页在节点视图下整页盖住，理由是"跨节点存时序要另设计
     一套 schema"——那个代价当时被高估了：指标 key 加个 node: 前缀就够，
     metrics 表一列没加，series() 一行没改。

     节点采的项比本机少（60 秒一轮，只落负载/内存/最满的盘/容器/落地封禁/
     温度/网络），所以曲线分组也少几组，但不再是一片空白。 */
  const node = isLocal() ? null : activeNode;
  const wanted = node
    ? ["load_percent", "mem", "disk_max", "temp", "net_rx", "net_tx",
       "containers_running", "guard_entries"]
    : ["cpu", "mem", "net_rx", "net_tx", "load1", "temp", "bans"];
  const vols = node ? [] : (lastSections?.storage?.data?.volumes || [])
    .filter(v => v.ok).map(v => `vol:${v.label}`);
  const metrics = wanted.concat(vols).join(",");
  let data;
  try {
    const res = await fetch(
      `/api/history/multi?metrics=${encodeURIComponent(metrics)}&hours=${histRange}&points=140` +
      (node ? `&node=${encodeURIComponent(node)}` : ""));
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
  const groups = node ? [
    ["负载与内存", [["负载", "load_percent"], ["内存", "mem"]],
     {floor: 0, ceil: 100, minSpan: 15, fmt: pct}],
    ["网络流量", [["下行", "net_rx"], ["上行", "net_tx"]], {floor: 0, fmt: rate}],
    ["最满的盘", [["使用率", "disk_max"]],
     {floor: 0, ceil: 100, minSpan: 12, fmt: pct}],
    ["容器与落地封禁", [["运行中容器", "containers_running"], ["落地规则", "guard_entries"]],
     {floor: 0, minSpan: 3, fmt: v => Math.round(v).toLocaleString()}],
  ] : [
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
  }).join("") || `<div class="card full flat"><div class="empty center"
    style="padding:30px 20px; line-height:1.7">${node
      ? `还没有 ${esc(currentFleet()?.name || node)} 的历史数据<br>
         <span style="font-size:12px; color:var(--faint)">
           节点指标每 60 秒采一次，接入后要等几轮才画得出趋势</span>`
      : "历史数据采集中，稍后再来看"}</div></div>`;

  // 时间范围在几张图里是同一段，标在区块标题上一次就够
  const span = [S.cpu, S.mem, S.load1, S.load_percent].find(s => (s || []).length >= 2);
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

/* ================= 调度 ================= */

let activeTab = "overview", lastData = null, lastSections = null, sparkCache = {};
/* 当前查看的机器。"local" 是跑着面板的那一台，其余是节点名。
   以前这里 null 表示本机，本机因此成了 if 的另一个分支，每个页签都要写两遍
   （renderNodeOverview / renderOverview 那种）。现在本机只是 fleet 里 id 为
   "local" 的一员，走同一条渲染路径 */
let activeNode = "local";
let fleetItems = [];       // /api/nodes 的一行摘要，节点切换器和 fleet 条都读它
let nodeSnap = null;       // 当前机器的 NodeSnapshot
// 站点名来自后端 config 的 site_name，用于头部与主机卡片标题。
// 拿到之前先用中性占位，别写死任何一台机器的名字
let siteName = "主机";
let demoShown = false;

document.querySelectorAll("nav button").forEach(b => {
  b.onclick = () => {
    activeTab = b.dataset.tab;
    document.querySelectorAll("nav button").forEach(x => x.classList.toggle("on", x === b));
    ["overview","firewall","security","conns","ports","history","containers","settings"].forEach(t =>
      $(t).classList.toggle("hide", t !== activeTab));
    // 这几个是本机专属的数据源，节点视图下不拉——省一次请求，
    // 也避免拉回来的本机数据被误当成节点的
    // 历史曲线本机和节点都有；审计是面板自身的操作流水，只对本机有意义
    if (activeTab === "history") { loadHistory(); if (isLocal()) loadAudit(); }
    if (activeTab === "containers" && isLocal()) loadSnapshots();
    if (activeTab === "firewall") loadWhitelist();
    if (activeTab === "security") loadSecurity(true);
    if (activeTab === "settings" && isLocal()) loadSettings();
    refresh();
  };
});

const isLocal = () => activeNode === "local";
const currentFleet = () => fleetItems.find(n => n.id === activeNode) || null;

/* 节点切换器。选中哪台，各页签就显示哪台的数据；不掺别的机器的数据进来，
   宁可显示"这台没有这个模块"也不要让人误以为看到的是它的。
   本机在这个列表里是普通一项，不是固定在最前面的特例 */
function syncNodePicker() {
  const sel = $("nodePick"), tabs = $("nodeTabs");
  // 只有一台（没配节点）时不显示切换器，单机部署看不到这个控件
  if (fleetItems.length < 2) {
    sel.classList.add("hide"); tabs.classList.add("hide");
    return;
  }
  tabs.classList.remove("hide");
  sel.classList.remove("hide");
  // 标签条：每台一个标签，带状态点。状态或选中项变了才重绘——
  // 每 5 秒重绘会让鼠标悬停的高亮闪一下
  const tsig = fleetItems.map(n => `${n.id}:${n.level}:${n.ok ? 1 : 0}`).join("|") +
               "#" + activeNode;
  if (tabs.dataset.sig !== tsig) {
    tabs.dataset.sig = tsig;
    tabs.innerHTML = fleetItems.map(n => `
      <button class="ntab${n.id === activeNode ? " on" : ""} fleetPick"
              data-node="${esc(n.id)}"
              title="${esc(n.ok ? (n.issues || []).join("、") || "正常" : n.error || "离线")}">
        <span class="dot ${n.ok ? n.level : "crit"}"></span>${esc(n.name)}
      </button>`).join("");
  }
  const sig = fleetItems.map(n => `${n.id}:${n.ok ? 1 : 0}`).join("|");
  // 只在机器集合或在线状态变化时重建。每 5 秒重建一次会让下拉在展开时被抽掉
  if (sel.dataset.sig !== sig) {
    sel.dataset.sig = sig;
    sel.innerHTML = fleetItems.map(n => `<option value="${esc(n.id)}">${
      esc(n.name)}${n.role === "local" ? "（本机）" : ""}${n.ok ? "" : "（离线）"}</option>`).join("");
  }
  if (sel.value !== activeNode) sel.value = activeNode;
}

$("nodePick").onchange = e => {
  switchNode(e.target.value || "local");
};

function switchNode(id) {
  if (id === activeNode) return;
  activeNode = id;
  nodeSnap = null;                 // 立刻作废，免得旧机器的数据闪一下
  document.body.classList.toggle("nodeview", !isLocal());
  // 这几个数据源只对本机有意义，切回来时补拉
  if (activeTab === "history") { loadHistory(); if (isLocal()) loadAudit(); }
  // 安全中心的按机器过滤在前端做，切换时直接用缓存重渲染，不必再请求一次
  if (activeTab === "security" && secRaw) renderSecurityCenter();
  if (isLocal()) {
    if (activeTab === "containers") loadSnapshots();
    if (activeTab === "settings") loadSettings();
  }
  refresh();
}

/* 页签整体不适用于某台机器时的说明。模块级的缺失由 moduleCard 统一处理，
   这里只管"整个页签都不适用"这一种 */
function notCollected(what, why) {
  const name = currentFleet()?.name || activeNode;
  return `<div class="card full flat"><h2><span class="dot"></span>${esc(what)}
      <span class="right">${esc(name)}</span></h2>
    <div class="empty center" style="padding:30px 20px; line-height:1.7">
      ${why}<br>
      <span style="font-size:12px; color:var(--faint)">
        切到「本机」可以看这台的完整数据</span>
    </div></div>`;
}

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
document.querySelectorAll("[data-sec-range]").forEach(c => {
  c.onclick = () => {
    secRange = parseInt(c.dataset.secRange);
    document.querySelectorAll("[data-sec-range]").forEach(x => x.classList.toggle("on", x === c));
    secLoadedAt = 0; loadSecurity(true);
  };
});
document.querySelectorAll("[data-sec-map]").forEach(c => {
  c.onclick = () => {
    secMapMode = c.dataset.secMap;
    secMapRenderedMode = null;
    renderSecurityMap(secData?.incidents?.items || [], secData?.map || {});
  };
});
$("secRefresh").onclick = () => { secLoadedAt = 0; loadSecurity(true); };

// 列表里的按钮每次重绘都是新元素，统一用事件委托
document.addEventListener("click", e => {
  const t = e.target;
  // 节点行展开/收起。用 closest 是因为点到的多半是行内的 span 而不是行本身
  const fleetRow = t.closest?.(".fleetPick");
  if (fleetRow) {
    switchNode(fleetRow.dataset.node);
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
  // 告警整行可点，但"忽略"按钮除外——那是行内的另一个动作
  const jump = t.closest?.(".alertJump");
  if (jump && !t.dataset?.mute) {
    jumpToAlert(jump.dataset.tab, jump.dataset.mod);
    return;
  }
  if (t.dataset?.unmute) {
    api(`/api/alerts/mute/${encodeURIComponent(t.dataset.unmute)}`, "DELETE")
      .then(() => { toast("已恢复", "该告警会重新出现"); loadSettings(); refresh(); })
      .catch(e => toast("恢复失败", e.message, true));
    return;
  }
  if (t.dataset?.logs) { showLogs(t.dataset.logs); return; }
  if (t.dataset?.secCti) { showSecurityCti(t.dataset.secCti); return; }
  if (t.dataset?.secNote) {
    const item = (secData?.incidents?.items || []).find(x => x.key === t.dataset.secNote) || {};
    const note = prompt("事件备注", item.note || "");
    if (note !== null) updateSecurityIncident(t.dataset.secNote, {note});
    return;
  }
  if (t.dataset?.secStatus) {
    updateSecurityIncident(t.dataset.secStatus, {status:t.dataset.status}); return;
  }
  if (t.dataset?.secFp) {
    const item = (secData?.incidents?.items || []).find(x => x.key === t.dataset.secFp) || {};
    updateSecurityIncident(t.dataset.secFp, {false_positive:!item.false_positive,
      status: item.false_positive ? "open" : "ignored"}); return;
  }
  if (t.dataset?.secBan) {
    const ip = t.dataset.secBan;
    if (secBanConfirm === ip) doSecurityBan(ip);
    else {
      secBanConfirm = ip; renderSecurityCenter(secData);
      setTimeout(() => { if (secBanConfirm === ip) { secBanConfirm=null; renderSecurityCenter(secData); } }, 5000);
    }
    return;
  }
  if (t.dataset?.secRollback) {
    const id = t.dataset.secRollback;
    if (secRollbackConfirm === id) doSecurityRollback(id);
    else {
      secRollbackConfirm = id; renderSecurityCenter(secData);
      setTimeout(() => { if (secRollbackConfirm === id) { secRollbackConfirm=null; renderSecurityCenter(secData); } }, 5000);
    }
    return;
  }
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

/* ---------- fleet：全部机器排在一起 ----------
   以前是每台节点一张进度条卡插在总览第 2 位，本机的负载则画在"主机"卡里——
   同一个指标两个位置两种画法，机器多几台还会把本机指标挤下去大半屏。

   改成一张横排卡：一台一行，列是统一指标，本机也在里面。多机场景下最常问的
   是"哪台不对劲"，横着扫一眼比逐张翻卡片快，也不占地方。 */

function fleetCell(pct, label) {
  if (pct == null) return `<span class="fcell dim">—</span>`;
  return `<span class="fcell" title="${esc(label || "")}">
    <b class="${pctTone(pct)}">${pct}%</b>
    <i class="fbar"><i class="${pctClass(pct)}" style="width:${Math.min(100, pct)}%"></i></i>
  </span>`;
}

const pctTone = p => p >= 90 ? "crit" : p >= 75 ? "warn" : "";

function renderFleetStrip() {
  if (fleetItems.length < 2) return "";       // 单机部署不需要这张卡
  const offline = fleetItems.filter(n => !n.ok).length;
  const bad = fleetItems.filter(n => n.level === "crit").length;
  const rows = fleetItems.map(n => {
    const on = n.id === activeNode;
    if (!n.ok) {
      return `<div class="frow${on ? " on" : ""} fleetPick" data-node="${esc(n.id)}">
        <span class="fname"><span class="dot crit"></span>${esc(n.name)}</span>
        <span class="fdown">${esc(n.error || "连不上")}</span></div>`;
    }
    return `<div class="frow${on ? " on" : ""} fleetPick" data-node="${esc(n.id)}">
      <span class="fname"><span class="dot ${n.level}"></span>${esc(n.name)}
        ${n.role === "local" ? '<span class="tag">本机</span>' : ""}
        ${n.issues.length ? `<span class="tag crit">${esc(n.issues[0])}</span>` : ""}</span>
      ${fleetCell(n.load_percent, `${n.cores ?? "?"} 核`)}
      ${fleetCell(n.memory_percent, "内存")}
      ${fleetCell(n.disk_percent, n.disk_mount || "最满的盘")}
      <span class="fmeta">${n.containers_running ?? "—"}/${n.containers_total ?? "—"} 容器</span>
      <span class="fmeta">${n.ports_exposed ?? "—"} 端口</span>
      <span class="fmeta">${n.guard_entries != null
        ? n.guard_entries.toLocaleString() + " 规则" : "规则未采"}</span>
      <span class="fmeta dim">${n.latency_ms != null ? n.latency_ms + "ms" : "本地"}</span>
    </div>`;
  }).join("");
  const summary = offline ? `${offline} 台离线`
    : bad ? `${bad} 台需要处理` : "全部正常";
  return card(`全部机器 <span class="right">${fleetItems.length} 台 · ${summary}</span>`,
    offline || bad ? "crit" : "ok", `
    <div class="fhead">
      <span class="fname">机器</span><span class="fcell">负载</span>
      <span class="fcell">内存</span><span class="fcell">最满的盘</span>
      <span class="fmeta">容器</span><span class="fmeta">端口</span>
      <span class="fmeta">落地封禁</span><span class="fmeta">延迟</span>
    </div>
    ${rows}
    <div class="note">点任意一行切到那台。指标口径全部一致，切过去后各页签显示的
      就是那台的数据——采不到的项会明说"未启用"，不会拿本机数据顶替</div>`,
    "full flat");
}

/* ---------- 快照拉取 ---------- */

async function loadSnapshot(id) {
  try {
    const r = await fetch(`/api/nodes/${encodeURIComponent(id)}/snapshot`, {cache: "no-store"});
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

/* ---------- 总览页 ----------
   三段：不随节点切换的集群级卡片、全部机器横排、当前这台的模块卡。
   层级在结构上就分开了，不靠每张卡自己记得该不该跟着切 */

function renderOverviewPage(s, snap) {
  /* fleet 横排要占满宽度，所以渲染到瀑布流外面的独立容器。
     放进 #overview 是错的：那里是 CSS columns，grid-column 在里面完全无效
     （CSS 里那行 `#overview .card.span2{grid-column:auto}` 就是这个原因），
     .card.full 拿不到整行，只能拿到一列 366px，而 fleet 内部是 8 列 grid、
     最小要 678px，硬塞进去会溢出并把相邻卡片挤变形 */
  const top = [renderFleetStrip()];
  if (snap && !snap.node.ok) {
    // 节点离线时总览页几乎只剩这一张卡，压成一列宽右边会空一大片
    top.push(renderOfflineNode(snap));
  } else if (snap) {
    top.push(scriptVersionNotice(snap));
  }
  $("overviewTop").innerHTML = top.filter(Boolean).join("");

  const parts = [];
  // L0：CrowdSec 的决策是全集群的，跟看哪台无关，所以它不随切换变。
  // 它和其余卡片等宽走瀑布流——内容只有三个数字加一段列表，拉成全宽会空一大片
  parts.push(renderSecurity(s.crowdsec));
  if (snap) {
    parts.push(renderSnapshotOverview(snap));
  } else {
    parts.push(`<div class="card flat"><div class="empty center">读不到这台的状态</div></div>`);
  }
  // remote 是"探测别人家的机器"（NPU 那类），不属于被管理节点，只在本机视图显示
  if (isLocal()) parts.push(renderRemote(s.remote));
  $("overview").innerHTML = parts.join("");
}

/* ---------- 节点视图下的其他页签 ----------
   conns / ports / containers 三个页签的本机渲染很丰富（GeoIP 归属、容器日志、
   快照清理），节点采不到那些。这里用模块卡渲染到独立容器，缺的照样出占位卡，
   不再是以前那种整页空白配一段散文。

   页签级的深度统一（让本机也走这条路）排在后面做，见
   private/多节点重构规划.md 阶段 A'。 */

/* 每个页签在节点视图下画哪些模块。null = 整页不适用（不是缺数据，是这页
   本来就跟节点无关）。集中登记在这里，refresh 只查表，不再一处一处写 if */
const NODE_TAB_MODULES = {
  conns:      ["connections"],
  ports:      ["ports"],
  containers: ["containers"],
  settings:   null,
  // history 不在这里：节点指标已经落进历史库了（key 带 node: 前缀），
  // 这页在节点视图下走的是和本机相同的渲染，只是曲线分组少几组
};

const NODE_TAB_NOTICE = {
  settings: ["设置",
    "这里配的是<b>面板自身</b>的告警规则和推送，不分节点——" +
    "各节点的告警本来就汇总到同一个 CrowdSec 中央，走同一套规则。"],
};

/* 只填内容，不管显隐 */
function fillNodeNotice() {
  const mods = NODE_TAB_MODULES[activeTab];
  if (mods === null) {
    const [what, why] = NODE_TAB_NOTICE[activeTab] || ["这个页签", "对节点不适用。"];
    $("nodeNotice").innerHTML = notCollected(what, why);
    return;
  }
  if (!nodeSnap) { $("nodeNotice").innerHTML = ""; return; }
  $("nodeNotice").innerHTML = !nodeSnap.node.ok
    ? renderOfflineNode(nodeSnap)
    : mods.map(m => moduleCard(nodeSnap, m)).join("");
}

async function refresh() {
  try {
    // 两个请求并行。fleet 那个只是读内存缓存做投影，很便宜；分开发是为了
    // 让"当前看哪台"和"全局告警"各走各的，切换节点不用等 summary
    const [res, fleetRes] = await Promise.all([
      fetch("/api/summary", {cache: "no-store"}),
      fetch("/api/nodes", {cache: "no-store"}),
    ]);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const body = await res.json();
    const s = body.sections || {};
    if (fleetRes.ok) fleetItems = (await fleetRes.json()).items || [];
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

    // 选中的机器不在列表里了（节点被移除），退回本机而不是僵在空视图上
    if (fleetItems.length && !currentFleet()) {
      activeNode = "local";
      document.body.classList.remove("nodeview");
      toast("这台机器已不在列表中", "已切回本机");
    }
    syncNodePicker();
    nodeSnap = await loadSnapshot(activeNode);
    const node = isLocal() ? null : currentFleet();

    if (activeTab === "overview") {
      renderOverviewPage(s, nodeSnap);
    } else if (activeTab === "firewall") {
      renderFirewall(s.crowdsec, s.engine);
    } else if (activeTab === "security") {
      loadSecurity();
    } else if (activeTab === "conns" && isLocal()) {
      renderConns(s.connections);
    } else if (activeTab === "ports" && isLocal()) {
      renderPorts(s.ports);
    } else if (activeTab === "containers" && isLocal()) {
      renderContainerTab(s.containers);
    }

    /* 节点视图下，这几个页签的本机静态结构填不进节点数据，改用 nodeNotice
       这个独立容器渲染。不直接改页签自己的 innerHTML——那会毁掉 #history 里的
       静态骨架，切回本机时 loadHistory 就填不回去了。
       显隐只在这一处决定，避免和上面的渲染互相覆盖 */
    const useNotice = !isLocal() && activeTab in NODE_TAB_MODULES;
    if (useNotice) fillNodeNotice();
    $("nodeNotice").classList.toggle("hide", !useNotice);
    $(activeTab).classList.toggle("hide", useNotice);

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
