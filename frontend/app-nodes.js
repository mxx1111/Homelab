/* Homelab 面板前端 · 机器视图

   本机和节点走同一份 NodeSnapshot 契约（backend/nodeschema.py），
   这个文件是那份契约在前端的全部实现：总览卡片、13 个模块的渲染器、
   能力缺失的占位、fleet 横排。

   单独成文件是因为它是多节点重构的核心：本机不是特殊分支，只是 id 为
   "local" 的一员，走同一条渲染路径。这条一旦被破坏，多节点就会退回
   "每个页签写两遍"的老样子，而那种退化在页面上不显眼。

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
    <div class="big">${alerts}<span class="unit">条 24h 告警</span></div>
    <div class="sub">当前封禁 ${(d.active_bans ?? 0).toLocaleString()} 条${
      c.manual ? `，其中手动 ${c.manual}` : ""}</div>
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
  // CPU 压力优先看真实使用率。loadavg 把 D 状态进程也算进去，带 NPU/GPU
  // 的板子上常驻驱动线程会把它顶到很高（aipro：load 17／3 核，CPU 却 99% 空闲）
  const loadPct = load1 != null && d.cpu_cores ? load1 / d.cpu_cores * 100 : null;
  const cpuPct = d.cpu_percent ?? loadPct;
  const dot = (m.percent >= 90 || (cpuPct != null && cpuPct >= 100)) ? "warn" : "ok";
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
  // items 已按剩余天数升序，读不到的排最前，所以第一个就是最该操心的那张
  const soonest = items[0];
  const head = `
    <div class="big">${soonest?.ok ? soonest.days_left : "—"}<span class="unit">${
      soonest?.ok ? "天后最先到期" : "有证书读不到"}</span></div>
    <div class="sub">监控 ${items.length} 张${
      bad ? `，<b style="color:var(--crit)">${bad} 张读不到</b>` : ""}${
      crit ? `，<b style="color:var(--crit)">${crit} 张 7 天内到期</b>` : ""}${
      warn ? `，<b style="color:var(--warn)">${warn} 张 30 天内到期</b>` : ""}</div>`;
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
    <div class="big">${c.public ?? 0}<span class="unit">个公网暴露</span></div>
    <div class="sub">另有 ${c.lan ?? 0} 个内网可达、${c.safe ?? 0} 个仅本机</div>
    ${pub ? `<div class="list">${pub}</div>` : `<div class="empty center">无公网暴露端口</div>`}`);
}

function renderConnCard(sec) {
  const d = sec?.data;
  if (!d?.ok) return fail(sec, "活跃连接");
  const ext = (d.items || []).filter(x => !x.private && x.inbound).slice(0, 7);
  return card("活跃连接", d.external > 0 ? "info" : "ok", `
    <div class="big">${d.external}<span class="unit">个外部对端</span></div>
    <div class="sub">共 ${d.total} 条连接，入站 ${d.inbound}</div>
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
    <div class="big">${d.total}<span class="unit">块硬盘</span></div>
    <div class="sub">${d.failing
      ? `<b style="color:var(--crit)">${d.failing} 块有坏道</b>`
      : "无坏道"}${d.aging ? `，<b style="color:var(--warn)">${d.aging} 块服役偏久</b>` : ""}</div>
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
    <div class="big">${d.effective_sources}<span class="unit">/${
      (d.sources||[]).length} 个日志源在产出</span></div>
    <div class="sub">确认攻击 ${d.overflowed_total}${
      wasted ? `，<b style="color:var(--warn)">${wasted} 个源白读</b>` : ""}</div>
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

/* renderOverview / renderNodesCard / nodeMetric / nodeDetail 已删。
   总览改由 renderOverviewPage 组装：集群级卡片 + fleet 横排 + 当前机器的模块卡。
   每台节点一张进度条卡的做法被 fleet 条取代——机器多几台就会把本机指标挤下去
   大半屏，而且节点的负载画在节点卡里、本机的负载画在"主机"卡里，同一个指标
   两个位置两种画法。旧实现留在 git 历史里。 */


/* ================= 节点视图：一份 NodeSnapshot 驱动全部卡片 =================

   在这之前，本机走 renderOverview 那 13 张卡，节点走 renderNodeOverview 那 5 张
   粗卡，两套代码各写各的，切换节点时数据对不齐是必然的。

   现在统一：后端把本机和节点都投影成同一份 NodeSnapshot（backend/nodeschema.py），
   这里按模块清单逐个渲染。**本机不是特殊分支**，它只是 id 为 "local" 的一员，
   走的是同一条渲染路径，只在数据更丰富的地方（历史曲线、容量预测）多画几笔。

   缺的模块不留空白，也不各写一段散文解释——capability 说它 unsupported，
   就统一渲染占位卡，附后端给的"为什么、怎么补"。空白让人以为坏了，
   占位卡让人知道这是设计如此。 */

const CAP_BADGE = {
  basic:    ["粗粒度", "这台采到的粒度比本机低"],
  readonly: ["只读", "面板连这台用的是受限密钥，只能读不能改"],
};

function capBadge(level) {
  const b = CAP_BADGE[level];
  return b ? `<span class="capbadge" title="${esc(b[1])}">${b[0]}</span>` : "";
}

/* 模块缺失时的统一占位。以前这段话在连接页、容器页、总览页各写了一遍，
   措辞还不一致 */
function moduleMissing(snap, name) {
  const label = snap.module_names?.[name] || name;
  const [why, how] = snap.hints?.[name] || ["这台没有这个模块", ""];
  // 占位卡也要打模块标记：告警跳转靠它定位，缺了的话，如果告警指向的模块
  // 正好是未启用状态，跳过去会找不到卡片，只能滚到页签顶部
  return card(`${esc(label)} <span class="right dim">未启用</span>`, "", `
    <div class="empty center" style="padding:26px 16px; line-height:1.75">
      ${esc(why)}
      ${how ? `<br><span style="font-size:12px; color:var(--faint)">${esc(how)}</span>` : ""}
    </div>`, "flat").replace('<div class="card', `<div data-module="${name}" class="card`);
}

/* ---------- 各模块的渲染器。签名统一 (mod, snap) => html ---------- */

function nvHost(m, snap) {
  const mem = m.memory || {};
  const peak = Math.max(m.cpu_percent ?? m.load_percent ?? 0, mem.percent || 0);
  // 本机有历史曲线，节点没有（节点的历史存在它自己那台上）。同一张卡，
  // 有就多画一条 sparkline，没有就不画——不为此分出第二个渲染器
  const spark = snap.node.role === "local"
    ? sparkline(sparkCache?.cpu, {min: 0, emptyText: "CPU 历史采集中"}) : "";
  return card(`主机 <span class="right">${esc(snap.node.name)}</span>`,
    peak > 90 ? "crit" : peak > 75 ? "warn" : "ok", `
    <div class="big">${m.cpu_percent ?? m.load_percent ?? "—"}<span class="unit">% ${
      m.cpu_percent != null ? "CPU" : "负载"}</span></div>
    ${spark}
    <div class="sub">${m.cores ?? "—"} 核 · 负载 ${
      (m.load || []).map(x => x.toFixed(2)).join(" / ") || "—"}</div>
    <div style="margin-top:11px">
      <div class="row" style="border:none; padding:0 0 3px">
        <span class="k"><span>内存</span></span>
        <span class="v">${fmtBytes(mem.used)}<span class="unit">/ ${fmtBytes(mem.total)}</span></span>
      </div>
      <div class="bar"><i class="${pctClass(mem.percent)}" style="width:${mem.percent || 0}%"></i></div>
    </div>
    ${m.swap ? `<div style="margin-top:8px">
      <div class="row" style="border:none; padding:0 0 3px">
        <span class="k"><span>交换</span></span>
        <span class="v">${fmtBytes(m.swap.used)}<span class="unit">/ ${fmtBytes(m.swap.total)}</span></span>
      </div>
      <div class="bar"><i class="${pctClass(m.swap.percent)}" style="width:${m.swap.percent}%"></i></div>
    </div>` : ""}
    <div class="row"><span class="k"><span>运行时长</span></span>
      <span class="v">${fmtDur(m.uptime_seconds)}</span></div>
    ${m.temp_c != null ? `<div class="row"><span class="k"><span>温度</span></span>
      <span class="v">${m.temp_c} °C</span></div>` : ""}
    ${m.os ? `<div class="row"><span class="k"><span>系统</span></span>
      <span class="v dim" style="font-size:12px">${esc(m.os)}</span></div>` : ""}`);
}

function nvStorage(m, snap) {
  const growth = snap.node.role === "local" ? window._growthCache : null;
  const rows = (m.items || []).map(v => {
    const g = growth?.[v.label];
    const pred = (g && !g.insufficient && g.days_to_full != null)
      ? `<span class="tag ${g.days_to_full < 30 ? "warn" : ""}">约 ${g.days_to_full} 天写满</span>` : "";
    const snapTag = v.snapshot_count != null
      ? `<span class="tag">${v.snapshot_count} 快照</span>` : "";
    return `<div style="padding:8px 0">
      <div class="row" style="border:none; padding:0 0 3px">
        <span class="k"><span>${esc(v.label || v.mount)}</span>${snapTag}${pred}
          ${v.fs ? `<span class="tag">${esc(v.fs)}</span>` : ""}</span>
        <span class="v">${fmtBytes(v.available)} 可用<span class="unit">/ ${fmtBytes(v.total)}</span></span>
      </div>
      <div class="bar"><i class="${pctClass(v.percent)}" style="width:${Math.min(100, v.percent)}%"></i></div>
      <div class="sub" style="margin:0">已用 ${v.percent}%</div>
    </div>`;
  }).join("");
  const worst = (m.items || [])[0]?.percent || 0;
  return card("存储", worst > 90 ? "crit" : worst > 80 ? "warn" : "ok",
    rows + (m.failed || []).map(v => `<div class="row"><span class="k">${esc(v.label)}</span>
      <span class="v dim">${esc(v.error || "不可用")}</span></div>`).join("")
    || '<div class="empty">无数据</div>');
}

function nvNetwork(m, snap) {
  const spark = snap.node.role === "local"
    ? sparkline(sparkCache?.net_rx, {min: 0, emptyText: "流量历史采集中"}) : "";
  return card("网络", "info", `
    <div class="stats">
      <div class="stat"><div class="n" style="font-size:19px">${fmtRate(m.rx_bytes_per_sec)}</div>
        <div class="l">下行</div></div>
      <div class="stat"><div class="n" style="font-size:19px">${fmtRate(m.tx_bytes_per_sec)}</div>
        <div class="l">上行</div></div>
    </div>
    ${spark}
    <div class="row"><span class="k"><span>网卡</span></span><span class="v">${esc(m.interface)}</span></div>
    ${m.public_ip ? `<div class="row"><span class="k"><span>公网 IP</span></span>
      <span class="v mono">${esc(m.public_ip)}</span></div>` : ""}
    <div class="row"><span class="k"><span>累计收/发</span></span>
      <span class="v">${fmtBytes(m.rx_total)} / ${fmtBytes(m.tx_total)}</span></div>`);
}

function nvContainers(m, snap) {
  // 主数字只留一个，而且是异常那个。以前"运行中 30"和"已停止 2"两个等大数字
  // 并排，视觉权重一样，可这两个数的重要性差着量级
  const stopped = m.stopped ?? 0;
  const rows = (m.items || []).slice(0, 14).map(c => `
    <div class="row">
      <span class="k"><span class="dot ${c.running ? "ok" : ""}"></span><span>${esc(c.name)}</span></span>
      <span class="v ${c.running ? "" : "dim"}">${c.running
        ? (c.cpu_percent != null ? c.cpu_percent.toFixed(1) + "% · " : "") +
          (c.memory_bytes != null ? fmtBytes(c.memory_bytes) : esc(c.status || "运行中"))
        : "已停止"}</span></div>`).join("");
  return card(`容器 ${capBadge(snap.capabilities.containers)}`, stopped ? "warn" : "ok", `
    <div class="big sm">${m.total ?? "—"}<span class="unit">个容器</span></div>
    <div class="sub">${m.running ?? 0} 个在跑${stopped ? `，<b style="color:var(--warn)">${stopped} 个已停止</b>` : ""}</div>
    <div class="list" style="margin-top:10px">${rows || '<div class="empty">无容器</div>'}</div>
    ${m.actionable === false ? `<div class="note">这台的容器是只读的。面板连它用的是受限密钥，
      只能执行采集脚本——即使私钥泄漏，拿到的也只是读监控数据的能力</div>` : ""}`, "span2");
}

function nvPorts(m, snap) {
  const graded = m.graded;
  return card(`端口暴露 ${capBadge(snap.capabilities.ports)}`,
    (m.public || 0) > 0 ? "warn" : "ok", `
    ${graded ? `
      <div class="big">${m.public ?? 0}<span class="unit">个公网暴露</span></div>
      <div class="sub">另有 ${m.lan ?? 0} 个内网可达、${m.safe ?? 0} 个仅本机</div>`
    : `
      <div class="big">${m.exposed ?? "—"}<span class="unit">个对外监听</span></div>
      <div class="sub">另有 ${m.loopback ?? "—"} 个只绑回环</div>`}
    <div class="tagwrap" style="margin-top:10px">${(m.items || []).slice(0, 18).map(p =>
      `<span class="tag ${p.level === "public" ? "crit" : ""}" title="${
        esc(p.owner || p.proc || "")}">${p.port}</span>`).join("")}</div>
    ${graded ? "" : `<div class="note">这台只分"对外监听"和"回环"两档。
      要判断某个端口是真的公网可达还是只在内网，得读这台机器的防火墙规则，
      采集脚本没做</div>`}`);
}

function nvConnections(m) {
  return card("活跃连接", (m.odd || 0) > 0 ? "warn" : "info", `
    <div class="big">${m.external ?? 0}<span class="unit">个外部对端</span></div>
    <div class="sub">共 ${m.total ?? 0} 条连接，${m.peers ?? 0} 个对端</div>
    <div class="list">${(m.by_port || []).slice(0, 8).map(p => `
      <div class="row"><span class="k"><span class="mono">${p.port}</span>
        <span class="tag">${esc(p.service || "?")}</span></span>
        <span class="v">${p.conns} 条 · ${p.peers} 端</span></div>`).join("")
      || '<div class="empty">无入站连接</div>'}</div>`);
}

function nvGuard(m) {
  const bad = m.agent !== "active" || m.bouncer !== "active";
  return card("本机防护", bad ? "crit" : "ok", `
    <div class="big sm">${(m.ipset_entries ?? 0).toLocaleString()}<span class="unit">条已落地</span></div>
    <div class="sub">iptables/ipset 里实际生效的封禁数</div>
    <div style="margin-top:12px">
      <div class="row"><span class="k"><span>检测 agent</span></span>
        <span class="v"><span class="tag ${m.agent === "active" ? "ok" : "crit"}">${
          esc(m.agent || "未知")}</span></span></div>
      <div class="row"><span class="k"><span>拦截 bouncer</span></span>
        <span class="v"><span class="tag ${m.bouncer === "active" ? "ok" : "crit"}">${
          esc(m.bouncer || "未知")}</span></span></div>
      ${m.blocked_packets != null ? `<div class="row"><span class="k"><span>实际命中</span></span>
        <span class="v">${m.blocked_packets.toLocaleString()} 包 · ${fmtBytes(m.blocked_bytes)}</span></div>` : ""}
    </div>
    <div class="note">决策由中央 LAPI 统一下发，各节点的落地数应该一致——
      差得多说明某台的 bouncer 没跟上。agent 停了是不再检测（已有封禁仍拦），
      bouncer 停了是新决策落不了地，两种故障要修的地方不同</div>`);
}

function nvEngine(m) {
  const top = (m.sources || []).slice(0, 6).map(s => `
    <div class="row"><span class="k"><span>${esc(s.name)}</span>
      ${s.wasted ? '<span class="tag warn">白读</span>' : ""}</span>
      <span class="v">${s.lines.toLocaleString()} 行${
        s.parse_rate != null ? ` · ${s.parse_rate}%` : ""}</span></div>`).join("");
  const wasted = (m.wasted_sources || []).length;
  return card("防护引擎", wasted ? "warn" : "ok", `
    <div class="big">${m.effective_sources ?? "—"}<span class="unit">/${
      (m.sources || []).length} 个日志源在产出</span></div>
    <div class="sub">确认攻击 ${m.overflowed_total ?? 0}${
      wasted ? `，<b style="color:var(--warn)">${wasted} 个源白读</b>` : ""}</div>
    <div class="list">${top || '<div class="empty">无日志源</div>'}</div>`);
}

function nvDisks(m) {
  const rows = (m.items || []).slice(0, 8).map(d => `
    <div class="row">
      <span class="k"><span class="dot ${d.level === "crit" ? "crit" : d.level === "warn" ? "warn" : "ok"}"></span>
        <span class="mono">${esc(d.device)}</span></span>
      <span class="v dim">${d.years != null ? d.years + " 年" : "—"}${
        (d.issues || []).length ? ` · ${esc(d.issues[0])}` : ""}</span></div>`).join("");
  return card("硬盘健康", m.failing ? "crit" : m.aging ? "warn" : "ok", `
    <div class="stats">
      <div class="stat"><div class="n">${m.total ?? 0}</div><div class="l">在测</div></div>
      <div class="stat"><div class="n" style="color:${m.failing?"var(--crit)":"var(--faint)"}">${
        m.failing ?? 0}</div><div class="l">告警</div></div>
    </div>
    <div class="list">${rows || '<div class="empty">无数据</div>'}</div>
    ${(m.no_redundancy || []).length ? `<div class="note">
      ${m.no_redundancy.map(esc).join("、")} 是单成员 raid1，名义冗余而已</div>` : ""}`);
}

function nvCerts(m) {
  const rows = (m.items || []).slice(0, 10).map(c => `
    <div class="row">
      <span class="k"><span class="dot ${c.level === "crit" ? "crit" : c.level === "warn" ? "warn" : "ok"}"></span>
        <span>${esc(c.name || c.host)}</span></span>
      <span class="v ${c.days_left != null && c.days_left < 30 ? "" : "dim"}">${
        c.days_left != null ? c.days_left + " 天" : esc(c.error || "读取失败")}</span></div>`).join("");
  return card("证书", m.level === "crit" ? "crit" : m.level === "warn" ? "warn" : "ok",
    `<div class="list">${rows || '<div class="empty">未配置证书目标</div>'}</div>`);
}

function nvProbes(m) {
  const rows = (m.items || []).map(s => `
    <div class="row">
      <span class="k"><span class="dot ${s.ok ? "ok" : "crit"}"></span><span>${esc(s.name)}</span></span>
      <span class="v ${s.ok ? "" : "dim"}">${s.ok ? s.latency_ms + " ms"
        : esc(s.error || s.status_code || "异常")}</span></div>`).join("");
  return card("服务健康", m.down > 0 ? "crit" : "ok", `
    <div class="big sm">${m.down ?? 0}<span class="unit">个异常</span></div>
    <div class="sub">共探测 ${m.total ?? 0} 个服务</div>
    <div class="list" style="margin-top:10px">${rows}</div>
    <div class="note">面板发起的 HTTP 探针，测的是"服务答不答得出来"。
      和下面的系统服务不是一回事——进程在但接口 500 是很常见的故障</div>`);
}

function nvUnits(m) {
  const rows = (m.items || []).map(u => `
    <div class="row">
      <span class="k"><span class="dot ${u.state === "active" ? "ok" : "crit"}"></span>
        <span>${esc(u.name)}</span></span>
      <span class="v dim" style="font-size:11.5px">${esc(u.state)}</span></div>`).join("");
  return card("系统服务", m.down > 0 ? "warn" : "ok", `
    <div class="list">${rows || '<div class="empty">无数据</div>'}</div>
    <div class="note">systemd 单元状态，测的是"进程在不在"。名单写死在节点侧——
      让面板指定查什么，就等于把任意命令执行的能力还回去一部分</div>`);
}

function nvAppsec(m) {
  const caps = Object.entries(m.capabilities || {}).filter(([, v]) => v);
  return card("WAF 观测", "info", `
    <div class="big">${(m.blocked_rows ?? 0).toLocaleString()}<span class="unit">次已拦截</span></div>
    <div class="sub">${m.site_count ?? "—"} 个站点，累计攻击记录 ${
      (m.attack_rows ?? 0).toLocaleString()}</div>
    <div class="tagwrap" style="margin-top:10px">${caps.map(([k]) =>
      `<span class="tag ok">${esc(k)}</span>`).join("") || "—"}</div>
    <div class="note">只读观测，面板不修改 1Panel WAF 的任何配置</div>`);
}

const MODULE_RENDER = {
  host: nvHost, storage: nvStorage, network: nvNetwork, containers: nvContainers,
  ports: nvPorts, connections: nvConnections, guard: nvGuard, engine: nvEngine,
  disks: nvDisks, certs: nvCerts, probes: nvProbes, units: nvUnits, appsec: nvAppsec,
};

/* 统一入口：capability 决定画内容还是画占位。加一个模块只要往
   MODULE_RENDER 里加一项，缺失分支不用碰 */
function moduleCard(snap, name) {
  // 先查渲染器再查 capability。反过来的话，模块名拼错会走进"未启用"分支，
  // 静默变成一张看着很正常的占位卡——把代码 bug 伪装成了正常状态
  const fn = MODULE_RENDER[name];
  if (!fn) { console.warn("未知模块", name); return ""; }
  const level = snap.capabilities?.[name];
  const mod = snap.modules?.[name];
  // capability 说有、modules 里却没有，也当没有。这个中间态前端最难处理，
  // 与其让每个渲染器自己防空，不如在入口统一挡掉
  if (!level || level === "unsupported" || !mod) return moduleMissing(snap, name);
  try {
    // 打上模块标记，告警条点过来时靠它定位到具体哪张卡
    return fn(mod, snap).replace('<div class="card', `<div data-module="${name}" class="card`);
  } catch (e) {
    // 一个模块的渲染出错不该带走整页。以前 leaflet 没加载就让整块安全中心
    // 白屏，就是这个教训
    console.error("模块渲染失败", name, e);
    return card(esc(snap.module_names?.[name] || name), "crit",
      `<div class="empty">这张卡渲染出错了：${esc(String(e.message || e))}</div>`, "flat");
  }
}

/* 节点离线时也画满卡位，每张写同一句话。以前是整页一张"连不上"的大卡，
   切回本机才知道原来该有哪些内容 */
function renderOfflineNode(snap) {
  const n = snap.node;
  return card(`${esc(n.name)} <span class="right">离线</span>`, "crit", `
    <div class="empty center" style="padding:34px 20px; line-height:1.8">
      ${esc(n.error || "连不上这台机器")}<br>
      <span style="font-size:12px; color:var(--faint)">
        面板每 60 秒重试一次。检查节点的 sshd、网络，
        以及 authorized_keys 里那把受限密钥还在不在</span>
    </div>`, "full flat");
}

/* 卡片按状态上浮。以前 13 张卡是写死的固定序，那是开发顺序不是重要性顺序——
   证书排第 11，快到期了要滚过十张卡才看见。

   有个坑必须避开：每 5 秒轮询一次，如果每轮都重排，卡片会在页面上跳，
   鼠标悬停的那张会突然换成另一张。所以只在**某张卡的等级真的变了**时才重排，
   等级没变就沿用上一轮的顺序。 */
let cardOrderCache = {};       // {nodeId: {order: [...], levels: "..."}}

const CARD_WEIGHT = {crit: 0, warn: 1};

function cardLevel(html) {
  const m = html.match(/<span class="dot (\w*)"/);
  return m ? m[1] : "";
}

/* 节点脚本比面板旧时，新增的那几个模块会显示成"未启用"——可那是版本问题，
   不是这台机器没有这个能力。不说清楚的话，看的人会以为节点不支持，
   跑去研究怎么"开启"，实际只要更新一个脚本文件 */
function scriptVersionNotice(snap) {
  const have = snap.node?.script_version, want = snap.expected_script_version;
  if (snap.node?.role === "local" || !want || have == null || have >= want) return "";
  return card(`采集脚本需要更新 <span class="right">v${have} → v${want}</span>`, "warn", `
    <div class="note" style="margin:0; line-height:1.8">
      下面标成「未启用」的模块里，有一部分是这台的
      <code>node-collect.sh</code> 版本太旧采不到，不是它没有这个能力。<br>
      把仓库里的 <code>scripts/node-collect.sh</code> 复制到节点的
      <code>/opt/homelab/node-collect.sh</code> 覆盖即可，
      <code>authorized_keys</code> 里的强制命令不用改。
    </div>`, "full flat");
}

/* 只出模块卡。离线提示和脚本版本提示由调用方决定放哪——它们要横跨整行，
   而总览页的卡片流是 CSS columns，full 在里面拿不到整行；换个容器就得换法子。
   同一个函数在两种容器里表现不一样，那种坑排查起来最费劲 */
function renderSnapshotOverview(snap) {
  if (!snap.node.ok) return "";
  const names = snap.order || Object.keys(MODULE_RENDER);
  const rendered = names.map(name => ({name, html: moduleCard(snap, name)}))
                        .filter(x => x.html);
  const levels = rendered.map(x => cardLevel(x.html)).join(",");

  const id = snap.node.id;
  const cached = cardOrderCache[id];
  let order;
  if (cached && cached.levels === levels) {
    order = cached.order;                       // 等级没变，顺序原样保留
  } else {
    order = rendered
      .map((x, i) => ({...x, i, w: CARD_WEIGHT[cardLevel(x.html)] ?? 2}))
      .sort((a, b) => a.w - b.w || a.i - b.i)   // 同级保持原顺序，排序是稳定的
      .map(x => x.name);
    cardOrderCache[id] = {order, levels};
  }
  const byName = Object.fromEntries(rendered.map(x => [x.name, x.html]));
  return order.map(n => byName[n]).filter(Boolean).join("");
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

