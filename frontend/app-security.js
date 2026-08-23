/* Homelab 面板前端 · 防护线

   告警条、防火墙、白名单、安全中心。这几块共用同一套数据层级：
     L0 集群级   封禁决策、白名单：中央 LAPI 统一下发，不随节点切换
     L1 节点归属 alert 及其衍生的 TOP / 国家 / ASN：按机器过滤
     L2 节点级   引擎 metrics：每台自己的 6060
   放在一起是为了让这条界线只有一处需要维护——分散开的话，迟早又会出现
   同一屏上一半过滤一半不过滤还没有提示的情况。

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

/* ================= 告警条 ================= */

let alertsExpanded = false;

/* 告警 key 是 "<类型>:<对象>" 格式（storage:数据盘、cert:example.com、
   disk:sda…），前缀就够定位到页签和模块，不用后端多给字段 */
const ALERT_ANCHOR = {
  storage:   ["overview", "storage"],
  host:      ["overview", "host"],
  cert:      ["overview", "certs"],
  disk:      ["overview", "disks"],
  service:   ["overview", "probes"],
  node:      ["overview", null],        // 节点掉线：fleet 条上能看到是哪台
  collector: ["overview", null],        // 采集器失败：没有对应模块卡
  ban:       ["firewall", null],
};

function alertAnchor(key) {
  return ALERT_ANCHOR[String(key || "").split(":")[0]] || [null, null];
}

function jumpToAlert(tab, mod) {
  // 告警都是本机的（节点的告警走 CrowdSec 中央），跳转前先切回本机，
  // 否则点了半天跳过去发现看的是另一台
  if (!isLocal()) switchNode("local");
  const btn = document.querySelector(`nav button[data-tab="${tab}"]`);
  if (btn && tab !== activeTab) { btn.click(); }
  // 等这一轮渲染落地再找卡片。refresh 是异步的，立刻找会扑空
  setTimeout(() => {
    const el = mod ? document.querySelector(`[data-module="${mod}"]`) : null;
    const target = el || $(tab);
    target?.scrollIntoView?.({behavior: "smooth", block: "center"});
    if (el) {
      el.classList.add("flash");
      setTimeout(() => el.classList.remove("flash"), 1600);
    }
  }, 120);
}

function renderAlertBar(alerts) {
  // 被忽略的不占地方，pending 的还没坐实也不显示
  const items = (alerts?.active || []).filter(a => !a.pending && !a.muted);
  if (!items.length) { $("alertbar").innerHTML = ""; return; }

  /* 告警条以前只能看和忽略，点不动——说了"证书 7 天到期"，然后要自己猜该点
     哪个页签、滚到哪张卡。现在整行可点，直接跳到对应卡片并高亮。
     README 里"在发现问题的地方就能处理"那句主张，这里才算接上 */
  const line = a => {
    const [tab, mod] = alertAnchor(a.key);
    return `
    <div class="alertline ${a.level === "crit" ? "crit" : ""}${tab ? " jump alertJump" : ""}"
         ${tab ? `data-tab="${tab}" data-mod="${mod || ""}"` : ""}
         ${tab ? `title="点击跳到对应卡片"` : ""}>
      <span class="dot ${a.level}"></span>
      <span class="t">${esc(a.title)}</span>
      <span class="d">${esc(a.detail || "")}</span>
      <span class="when">持续 ${fmtShort(a.duration)}${a.notified ? " · 已推送" : ""}</span>
      <button class="btn sm ghost" data-mute="${esc(a.key)}"
        title="不再显示也不再推送，可在设置页恢复">忽略</button>
    </div>`;
  };

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

/* 这张卡和总览的 fleet 条不是一回事，容易看混，所以标题和说明都要点明。

     fleet 条   数据来自 SSH 采集，答"这台忙不忙、盘满没满"
     这张卡     数据来自 CrowdSec 的 machines / bouncers 表，
                答"这台的 agent 还在上报吗、bouncer 还在拉决策吗"

   两台机器可能负载都正常（fleet 条全绿），但其中一台的 bouncer 已经停了三天，
   新封禁根本没落地——那种情况只有这张卡看得出来。 */
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
    nodes.some(n => (n.heartbeat_seconds ?? 1e9) > 900) ? "warn" : "ok"}"></span>CrowdSec 接入${
    fleetItems.length > 1 ? `<span class="scope all">全集群</span>` : ""}
    <span class="right">${nodes.length} 台共用同一套决策</span></h2>
    <div class="list">${body}</div>
    <div class="note">检测=agent 上报心跳，拦截=bouncer 拉取决策，两者分开看：
      agent 停了是不再检出新攻击（已封的仍然拦），bouncer 停了是新决策落不了地。
      在任意一台上的封禁对全部节点生效。<br>
      这里读的是 CrowdSec 自己的机器表，和总览页那张「全部机器」不是一个来源——
      那张答的是负载和磁盘，这张答的是防护链路通不通${
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
  const nodeHint = activeNode
    ? `当前在 ${esc(activeNode)} 视图下，但<b>封禁列表不按机器过滤</b>——
       决策由中央 LAPI 统一下发，每一条对所有节点都生效。
       上面的攻击来源和国家分布才是这台机器检出的。<br>`
    : "";
  const hint = nodeHint + (fwSearchResult !== null
    ? `搜索命中 ${rows.length} 条（直接查库，覆盖全部 ${d.active_bans} 条封禁）`
    : d.truncated
      ? `手动与自动检出的已全部列出；社区黑名单共 ${d.ban_counts?.community ?? 0} 条，
         此处只载入最近 ${(d.listed ?? 0) - (d.ban_counts?.manual ?? 0) - (d.ban_counts?.detected ?? 0)} 条。
         要找具体 IP 请用上方搜索框，它直接查库`
      : "");
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

/* 节点视图下的防火墙数据。只过滤告警派生的那几块——封禁列表不过滤，
   因为封禁本来就是全局决策、对所有节点生效，按机器筛掉反而让人以为
   别的机器没被保护。 */
function nodeFwView(d, name) {
  const alerts = (d.alerts || []).filter(a => a.machine === name);
  const tally = {}, country = {}, asn = {};
  for (const a of alerts) {
    if (a.ip) {
      const t = tally[a.ip] || (tally[a.ip] = {ip: a.ip, count: 0, country: a.country,
                                               as_name: a.as_name, scenarios: new Set(),
                                               machines: [name]});
      t.count++;
      if (a.scenario_cn || a.scenario) t.scenarios.add(a.scenario_cn || a.scenario);
    }
    const cc = (a.country || "").toUpperCase() || "??";
    const c = country[cc] || (country[cc] = {code: cc, count: 0, ips: new Set()});
    c.count++; if (a.ip) c.ips.add(a.ip);
    if (a.as_name) {
      const s = asn[a.as_name] || (asn[a.as_name] = {as_name: a.as_name, count: 0,
                                                     country: a.country, ips: new Set()});
      s.count++; if (a.ip) s.ips.add(a.ip);
    }
  }
  const pack = o => Object.values(o).map(x => ({...x, ips: x.ips.size}));
  return {
    ...d, alerts,
    alerts_24h: alerts.filter(a => a.age_hours != null && a.age_hours <= 24).length,
    top_sources: Object.values(tally).sort((a, b) => b.count - a.count).slice(0, 8)
      .map(x => ({...x, scenarios: [...x.scenarios].sort()})),
    by_country: pack(country).sort((a, b) => b.count - a.count).slice(0, 12),
    by_asn: pack(asn).sort((a, b) => b.count - a.count).slice(0, 8)
      .map(x => ({...x, as_label: x.as_name})),
  };
}

function renderFirewall(sec, engineSec) {
  const d = sec?.data;
  if (!d) {
    $("fwList").innerHTML = `<div class="empty">${esc(sec?.error || "CrowdSec 数据不可用")}</div>`;
    return;
  }
  /* 这一页混着三种层级的数据，切换节点时行为不一样。以前没把界线画出来，
     结果同一屏上"攻击来源 TOP"按机器过滤了、下面的"封禁列表"却是全集群的，
     中间还没有任何提示——看的人根本分不出哪块跟着切了哪块没跟着切。

       L0 集群级   封禁决策、白名单：中央 LAPI 统一下发，跟看哪台无关，不过滤
       L1 节点归属 alert 及其衍生的 TOP / 国家 / ASN：每条带 machine，按机器过滤
       L2 节点级   引擎 metrics：每台自己的 6060，节点上没拉过来

     现在每块都标出自己属于哪一层，行为和标注一起给。 */
  const node = isLocal() ? null : currentFleet();
  const scope = node
    ? `<span class="scope only">仅 ${esc(node.name)}</span>`
    : "";
  const clusterTag = `<span class="scope all">全集群</span>`;

  // L2：引擎 metrics 只在本机采（6060 端口），节点没有
  if (node) {
    const [why, how] = nodeSnap?.hints?.engine || ["这台没拉引擎 metrics", ""];
    $("fwSources").innerHTML = `<h2><span class="dot"></span>防护引擎 · 日志源
      <span class="right dim">未启用</span></h2>
      <div class="empty center" style="padding:24px 12px; line-height:1.7">
        ${esc(why)}<br>
        <span style="font-size:12px; color:var(--faint)">${esc(how)}</span>
      </div>`;
    $("fwScenarios").innerHTML = "";
  } else {
    renderFwSources(engineSec); renderFwScenarios(engineSec);
  }

  // L1：按机器过滤
  const view = node ? nodeFwView(d, node.id) : d;
  renderFwStat(view); renderFwTop(view); renderFwGeo(view); renderFwAsn(view);
  // L0：不过滤。封禁决策是中央统一下发的，"这台的封禁列表"不是个有意义的概念
  renderFwList(d);
  renderFwNodes(d);          // 节点清单始终显示全部，这是跨节点的健康总览

  // 标注贴在标题右侧，让"这块跟着切了没有"一眼可见
  if (node) {
    for (const id of ["fwStat", "fwTop", "fwGeo", "fwAsn"]) {
      const h = $(id)?.querySelector("h2");
      if (h && !h.querySelector(".scope")) h.insertAdjacentHTML("beforeend", scope);
    }
  }
  for (const h of document.querySelectorAll("#firewall .card > h2")) {
    if (/封禁列表|白名单/.test(h.textContent) && !h.querySelector(".scope"))
      h.insertAdjacentHTML("beforeend", clusterTag);
  }
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

/* ================= 安全中心 ================= */

let secRange = 168, secData = null, secRaw = null, secLoadedAt = 0, secLoading = false;
let secBanConfirm = null, secRollbackConfirm = null;
let secMapMode = "world", secLeaflet = null, secMarkerLayer = null;
let secMapRenderedMode = null, secBasemapLayers = null, secTileLayer = null;
let secMapSourceEl = null, overviewMiniLeaflet = null, overviewMiniMarkers = null;
let overviewMiniBase = null, localMapDataPromise = null;
// 记住最近一次的底图配置：没有地图时要靠它说清楚是配置关的还是组件没加载
let secLastMapCfg = null;

/* 地图这一整块取自开源版 main 的 offline-first 实现（254bf31）。
   它比 private 原来那套好在默认不出网：本地 Natural Earth 矢量底图始终启用，
   外部瓦片要显式打开，而且瓦片连续失败会自动退回本地简图。private 原来默认
   拉 OSM 瓦片，国内网络访问不到时整张图就是空白——正是这个功能最该管的场景。

   保留了 private 侧 main 没有的两处：
     mapDisabledReason + nomap 降级  配置里彻底关掉地图时，让排行榜占满整行
     按节点过滤                      在下面的 secFilterByNode 里，不在这一块 */

const CHINA_CITY_LABELS = [
  ["北京市",39.9042,116.4074,1],["上海市",31.2304,121.4737,1],
  ["广东省广州市",23.1291,113.2644,1],["广东省深圳市",22.5431,114.0579,1],
  ["香港特别行政区",22.3193,114.1694,1],["澳门特别行政区",22.1987,113.5439,1],
  ["四川省成都市",30.5728,104.0668,2],["湖北省武汉市",30.5928,114.3055,2],
  ["陕西省西安市",34.3416,108.9398,2],["重庆市",29.5630,106.5516,2],
  ["天津市",39.0842,117.2010,2],["江苏省南京市",32.0603,118.7969,2],
  ["浙江省杭州市",30.2741,120.1551,2],["台湾省台北市",25.0330,121.5654,2],
  ["辽宁省沈阳市",41.8057,123.4315,3],["吉林省长春市",43.8171,125.3235,3],
  ["黑龙江省哈尔滨市",45.8038,126.5349,3],["河北省石家庄市",38.0428,114.5149,3],
  ["山西省太原市",37.8706,112.5489,3],["山东省济南市",36.6512,117.1201,3],
  ["河南省郑州市",34.7466,113.6254,3],["安徽省合肥市",31.8206,117.2272,3],
  ["福建省福州市",26.0745,119.2965,3],["江西省南昌市",28.6820,115.8579,3],
  ["湖南省长沙市",28.2282,112.9388,3],["海南省海口市",20.0440,110.1999,3],
  ["贵州省贵阳市",26.6470,106.6302,3],["云南省昆明市",25.0389,102.7183,3],
  ["甘肃省兰州市",36.0611,103.8343,3],["青海省西宁市",36.6171,101.7782,3],
  ["内蒙古自治区呼和浩特市",40.8426,111.7492,3],
  ["广西壮族自治区南宁市",22.8170,108.3665,3],
  ["西藏自治区拉萨市",29.6520,91.1721,3],
  ["宁夏回族自治区银川市",38.4872,106.2309,3],
  ["新疆维吾尔自治区乌鲁木齐市",43.8256,87.6168,3],
];

const secStatusName = s => ({open:"待处理", investigating:"调查中",
  resolved:"已处理", ignored:"已忽略"}[s] || s || "待处理");
const secChangeName = s => ({pending:"执行中", applied:"已生效", failed:"失败",
  rolled_back:"已回滚", auto_rolled_back:"自动回滚", rollback_failed:"回滚失败"}[s] || s);

function loadLocalMapData() {
  if (!localMapDataPromise) localMapDataPromise = Promise.all([
    fetch("/static/maps/world.geojson", {cache:"force-cache"}).then(r => {
      if (!r.ok) throw new Error(`世界底图 HTTP ${r.status}`); return r.json();
    }),
    fetch("/static/maps/china-provinces.geojson", {cache:"force-cache"}).then(r => {
      if (!r.ok) throw new Error(`中国底图 HTTP ${r.status}`); return r.json();
    }),
  ]).then(([world, china]) => ({world, china}));
  return localMapDataPromise;
}

function createWorldLayer(data, pane, compact=false) {
  return L.geoJSON(data, {pane, interactive:false, style: {
    className:"local-basemap-shape", color:compact ? "#C9C4B8" : "#C2BDB1",
    weight:compact ? .65 : .85, fillColor:compact ? "#F7F5EF" : "#FAF9F5",
    fillOpacity:compact ? .92 : .9,
  }});
}

function createChinaLayer(data, pane) {
  return L.geoJSON(data, {pane, interactive:false, style: {
    className:"local-basemap-shape local-china-shape", color:"#B7B1A4",
    weight:.8, fillColor:"#EFECE3", fillOpacity:.32,
  }});
}

function mapLabel(text, lat, lon, kind="country") {
  return L.marker([lat,lon], {pane:"secLabelsPane", interactive:false,
    icon:L.divIcon({className:`local-map-label ${kind}`, html:`<span>${esc(text)}</span>`,
      iconSize:null, iconAnchor:[0,0]})});
}

function setSecurityMapSource(text, state="local") {
  if (!secMapSourceEl) return;
  secMapSourceEl.textContent = text;
  secMapSourceEl.className = `map-source-state ${state}`;
}

function renderSecurityBaseLabels() {
  if (!secLeaflet || !secBasemapLayers) return;
  const {worldData, chinaData, labels} = secBasemapLayers;
  labels.clearLayers();
  const zoom = secLeaflet.getZoom();
  if (secMapMode === "china") {
    if (zoom >= 4) for (const f of chinaData.features || []) {
      const p = f.properties || {};
      if (Number(p.min_zoom || 4.5) > zoom + .8) continue;
      if (Number.isFinite(Number(p.label_lat)) && Number.isFinite(Number(p.label_lon)))
        mapLabel(p.name_zh || p.name_en, Number(p.label_lat), Number(p.label_lon), "province").addTo(labels);
    }
    const cityRank = zoom >= 5 ? 3 : zoom >= 4 ? 2 : 1;
    for (const [name,lat,lon,rank] of CHINA_CITY_LABELS)
      if (rank <= cityRank) mapLabel(name,lat,lon,"city").addTo(labels);
  } else {
    const labelCount = zoom >= 4 ? 110 : zoom >= 3 ? 60 : zoom >= 2 ? 28 : 14;
    const countries = [...(worldData.features || [])].filter(f => {
      const p = f.properties || {}, lat = Number(p.label_y), lon = Number(p.label_x);
      return Number.isFinite(lat) && Number.isFinite(lon);
    }).sort((a,b) => Number(b.properties?.pop_est || 0) - Number(a.properties?.pop_est || 0));
    for (const f of countries.slice(0,labelCount)) {
      const p = f.properties || {};
      mapLabel(COUNTRY[p.iso_a2] || p.name_zh || p.name_en,
        Number(p.label_y),Number(p.label_x),"country").addTo(labels);
    }
  }
}

function applySecurityBasemapMode() {
  if (!secLeaflet || !secBasemapLayers) return;
  const china = secBasemapLayers.china;
  if (secMapMode === "china" && !secLeaflet.hasLayer(china)) china.addTo(secLeaflet);
  if (secMapMode !== "china" && secLeaflet.hasLayer(china)) secLeaflet.removeLayer(china);
  renderSecurityBaseLabels();
}

function initSecurityBasemap(map) {
  setSecurityMapSource("本地简图");
  loadLocalMapData().then(({world,china}) => {
    if (map !== secLeaflet) return;
    const worldLayer = createWorldLayer(world,"secBasemapPane").addTo(map);
    const chinaLayer = createChinaLayer(china,"secBasemapPane");
    const labels = L.layerGroup().addTo(map);
    secBasemapLayers = {world:worldLayer, china:chinaLayer, labels,
      worldData:world, chinaData:china};
    map.attributionControl.addAttribution(
      '<a href="https://www.naturalearthdata.com/" target="_blank" rel="noopener">Natural Earth</a>');
    applySecurityBasemapMode();
  }).catch(() => setSecurityMapSource("本地底图加载失败", "error"));
}

/* 地图不可用有两种，都不是错误，提示也不该长得像报错：
   配置里显式关掉（不想要地图，只看排行榜），或者 leaflet.js 没加载起来。
   注意本地底图不需要联网，所以"没网"已经不在这个列表里了 */
function mapDisabledReason(mapCfg) {
  if (mapCfg?.enabled === false) return "地图已在配置中关闭";
  if (!window.L) return "地图组件未加载";
  return null;
}

function ensureSecurityMap(mapCfg) {
  if (mapDisabledReason(mapCfg)) return null;
  if (secLeaflet) return secLeaflet;
  secLeaflet = L.map("secMap", {
    zoomControl:true, scrollWheelZoom:true, doubleClickZoom:true,
    touchZoom:true, keyboard:true, minZoom:1,
    maxZoom:Number(mapCfg?.max_zoom || 12), worldCopyJump:true,
  });
  secLeaflet.createPane("secBasemapPane");
  secLeaflet.getPane("secBasemapPane").style.zIndex = 210;
  secLeaflet.getPane("secBasemapPane").style.pointerEvents = "none";
  secLeaflet.createPane("secLabelsPane");
  secLeaflet.getPane("secLabelsPane").style.zIndex = 350;
  secLeaflet.getPane("secLabelsPane").style.pointerEvents = "none";
  const SourceControl = L.Control.extend({onAdd() {
    secMapSourceEl = L.DomUtil.create("div", "map-source-state local");
    secMapSourceEl.textContent = "本地简图"; return secMapSourceEl;
  }});
  new SourceControl({position:"bottomright"}).addTo(secLeaflet);
  initSecurityBasemap(secLeaflet);

  const tileUrl = mapCfg?.external_tiles ? String(mapCfg?.tile_url || "") : "";
  if (tileUrl) {
    let loaded = 0, failed = 0;
    secTileLayer = L.tileLayer(tileUrl, {
      maxZoom:Number(mapCfg?.max_zoom || 12),
      attribution:mapCfg?.attribution || "",
    }).addTo(secLeaflet);
    secTileLayer.on("tileload", () => { loaded++; setSecurityMapSource("详细底图", "detail"); });
    secTileLayer.on("tileerror", () => {
      failed++;
      if (!loaded && failed >= 4 && secLeaflet?.hasLayer(secTileLayer)) {
        secLeaflet.removeLayer(secTileLayer);
        setSecurityMapSource("详细底图不可用 · 已切换本地简图", "fallback");
      }
    });
  }
  secMarkerLayer = L.layerGroup().addTo(secLeaflet);
  L.control.scale({imperial:false, position:"bottomleft"}).addTo(secLeaflet);
  secLeaflet.on("zoomend", renderSecurityBaseLabels);
  return secLeaflet;
}

function destroyOverviewMiniMap() {
  if (overviewMiniLeaflet) overviewMiniLeaflet.remove();
  overviewMiniLeaflet = null; overviewMiniMarkers = null; overviewMiniBase = null;
}

function renderOverviewMiniMap(incidents) {
  const container = $("overviewMiniMap");
  if (!container || !window.L) return;
  if (overviewMiniLeaflet && overviewMiniLeaflet.getContainer() !== container)
    destroyOverviewMiniMap();
  if (!overviewMiniLeaflet) {
    overviewMiniLeaflet = L.map(container, {zoomControl:false, attributionControl:false,
      dragging:false, scrollWheelZoom:false, doubleClickZoom:false, touchZoom:false,
      keyboard:false, boxZoom:false, minZoom:1, maxZoom:3, worldCopyJump:true});
    overviewMiniLeaflet.createPane("overviewBasemapPane");
    overviewMiniLeaflet.getPane("overviewBasemapPane").style.zIndex = 210;
    overviewMiniLeaflet.getPane("overviewBasemapPane").style.pointerEvents = "none";
    overviewMiniMarkers = L.layerGroup().addTo(overviewMiniLeaflet);
    overviewMiniLeaflet.fitBounds([[-55,-175],[75,175]], {padding:[4,4], animate:false});
  }
  if (!overviewMiniBase) {
    overviewMiniBase = {loading:true, layer:null};
    const map = overviewMiniLeaflet;
    loadLocalMapData().then(({world}) => {
      if (map !== overviewMiniLeaflet) return;
      overviewMiniBase.layer = createWorldLayer(world,"overviewBasemapPane",true).addTo(map);
    }).catch(() => { if (map === overviewMiniLeaflet) container.classList.add("map-failed"); });
  }
  overviewMiniMarkers.clearLayers();
  for (const item of incidents || []) {
    const geo = mapGeo(item);
    if (!geo) continue;
    const events = Math.max(1, Number(item.event_count || item.count || 1));
    L.circleMarker(geo, {radius:Math.min(9,3 + Math.log2(events + 1)),
      color:item.blocked ? "#BC4C3C" : "#FFFFFF", weight:item.blocked ? 2 : 1.2,
      fillColor:"#D97757", fillOpacity:.78})
      .bindTooltip(`${esc(item.location_name || cname(item.country || ""))} · ${events} 事件`,
        {direction:"top", className:"overview-map-tip"}).addTo(overviewMiniMarkers);
  }
  setTimeout(() => overviewMiniLeaflet?.invalidateSize({pan:false}), 0);
}

function mapEmpty(message) {
  let el = document.getElementById("secMapEmpty");
  if (!message) { if (el) el.remove(); return; }
  if (!el) {
    el = document.createElement("div");
    el.id = "secMapEmpty"; el.className = "secmap-empty";
    $("secMap").appendChild(el);
  }
  el.textContent = message;
}

function mapGeo(item) {
  if (item.latitude === null || item.latitude === undefined || item.latitude === "" ||
      item.longitude === null || item.longitude === undefined || item.longitude === "") return null;
  const lat = Number(item.latitude), lon = Number(item.longitude);
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180
    ? [lat, lon] : null;
}

function addAttackMarker(row, label, detail="") {
  const r = Math.min(18, 5 + Math.log2(row.events + 1) * 2.1);
  const blockedText = row.blocked ? `${row.blocked} 个当前封禁` : "当前无封禁";
  L.circleMarker([row.lat, row.lon], {
    radius:r, color:row.blocked ? "#BC4C3C" : "#FFFFFF",
    weight:row.blocked ? 3 : 2, fillColor:"#D97757", fillOpacity:.76,
  }).bindTooltip(`<div class="map-tip-head">${esc(label)}</div>` +
    (row.coordinate ? `<div class="map-tip-coord">${esc(row.coordinate)}</div>` : "") +
    `<div class="map-tip-counts"><span>${row.sources} 个攻击源</span><span>${row.events} 个事件</span></div>` +
    (detail ? `<div class="map-provider">${esc(detail)}</div>` : "") +
    `<div class="map-tip-status ${row.blocked ? "blocked" : "clear"}"><i></i>${blockedText}</div>`,
    {direction:"auto", offset:[10,0], opacity:1, className:"attack-tooltip"}).addTo(secMarkerLayer);
}

function renderMapRank(rows, emptyText) {
  const maxEvents = Math.max(1, ...rows.map(x => x.events));
  $("secMapRank").innerHTML = `<div class="secmap-legend">
      <span class="map-key"><i class="map-dot"></i>检测到攻击</span>
      <span class="map-key"><i class="map-dot blocked"></i>存在当前封禁</span>
    </div>${rows.slice(0,8).map((x,i) => `<div class="row" title="${esc(x.title || x.label)}">
      <span class="k"><b style="font-weight:500">${i+1}. ${esc(x.label)}</b>
        <span class="tag">${x.sources} 源</span>${x.blocked ? `<span class="tag crit">${x.blocked} 封</span>` : ""}</span>
      <span class="bar"><i class="${x.blocked ? "crit" : ""}" style="width:${Math.max(4,x.events/maxEvents*100).toFixed(1)}%"></i></span>
      <span class="v">${x.events} 事件</span>
    </div>`).join("") || `<div class="empty center">${esc(emptyText)}</div>`}`;
}

/* 没有地图时只出排行榜。聚合口径必须和有地图时完全一致——同一份数据在两种
   模式下算出不同的数字，比没有这个功能更糟：看的人无从判断哪个是对的。
   所以这里复用 renderMapRank，只是不画点。 */
function renderSecurityMapRankOnly(incidents) {
  const reason = mapDisabledReason(secLastMapCfg) || "地图不可用";
  const domestic = new Set(["CN", "HK", "MO", "TW"]);
  const tally = {};
  for (const item of incidents || []) {
    const code = String(item.country || "").trim().toUpperCase();
    if (!code || code === "??") continue;
    if (secMapMode === "china" && !domestic.has(code)) continue;
    const slot = tally[code] || (tally[code] = {
      code, label: cname(code), title: cname(code),
      sources: 0, events: 0, blocked: 0,
    });
    slot.sources++;
    slot.events += Math.max(1, Number(item.event_count || item.count || 1));
    if (item.blocked) slot.blocked++;
  }
  const rows = Object.values(tally).sort((a, b) => b.events - a.events);
  const totalSources = rows.reduce((n, x) => n + x.sources, 0);
  const blocked = rows.reduce((n, x) => n + x.blocked, 0);

  $("secMapMeta").textContent =
    `${rows.length} 个${secMapMode === "china" ? "中国来源地区" : "国家"} · ` +
    `${totalSources} 个攻击源 · ${blocked} 个当前封禁`;
  $("secMapHint").textContent = `${reason}，下面按${
    secMapMode === "china" ? "中国来源" : "国家"}排行显示`;
  $("secMapNote").textContent = secLastMapCfg?.enabled === false
    ? "地图已在 config.yaml 的 security_center.map.enabled 关闭。排行榜用的是同一份数据。"
    : "地图组件没加载起来（检查 /static/vendor/leaflet/leaflet.js）。排行榜用的是同一份数据。";
  renderMapRank(rows, secMapMode === "china"
    ? "所选时间内没有中国来源攻击" : "暂无国家级攻击数据");
  secMapRenderedMode = secMapMode;
}

function renderSecurityMap(incidents, mapCfg={}) {
  secLastMapCfg = mapCfg;
  document.querySelectorAll("[data-sec-map]").forEach(x =>
    x.classList.toggle("on", x.dataset.secMap === secMapMode));
  const map = ensureSecurityMap(mapCfg);
  // 没有地图时把窗格收起来，排行榜占满整行。数据一条不少，只是换个画法——
  // 直接 return 会把现成的排行榜一起吞掉
  const layout = document.querySelector(".secmap-layout");
  $("secMap").classList.toggle("hide", !map);
  if (layout) layout.classList.toggle("nomap", !map);
  if (!map) { renderSecurityMapRankOnly(incidents); return; }
  secMarkerLayer.clearLayers();
  mapEmpty("");
  applySecurityBasemapMode();

  if (secMapMode === "china") {
    const domesticCodes = new Set(["CN","HK","MO","TW"]), regions = {};
    let domesticSources = 0, blockedSources = 0, unlocated = 0;
    for (const item of incidents || []) {
      const code = String(item.country || "").trim().toUpperCase();
      if (!domesticCodes.has(code)) continue;
      domesticSources++;
      if (item.blocked) blockedSources++;
      const geo = mapGeo(item);
      if (!geo) { unlocated++; continue; }
      const lat = Math.round(geo[0] * 2) / 2, lon = Math.round(geo[1] * 2) / 2;
      const key = `${lat}:${lon}`;
      const slot = regions[key] || (regions[key] = {
        lat, lon, sources:0, events:0, blocked:0, providers:new Set(), places:new Set(),
      });
      slot.sources++;
      slot.events += Math.max(1, Number(item.event_count || item.count || 1));
      if (item.blocked) slot.blocked++;
      if (item.as_label || item.as_name) slot.providers.add(item.as_label || item.as_name);
      if (item.location_name) slot.places.add(item.location_name);
    }
    const rows = Object.values(regions).sort((a,b) => b.events - a.events).map(x => {
      const providers = [...x.providers];
      const places = [...x.places];
      const providerSummary = providers.length
        ? `网络归属：${providers.slice(0,2).join("、")}` +
          (providers.length > 2 ? ` 等 ${providers.length} 家网络` : "")
        : "网络归属未知";
      const coordinate = `${x.lat.toFixed(1)}°N · ${x.lon.toFixed(1)}°E`;
      const placeLabel = places.join("、") || "中国来源区域";
      return {...x, label:placeLabel, coordinate,
        title:providerSummary, providerSummary};
    });
    rows.forEach(x => addAttackMarker(x, x.label, x.providerSummary));
    $("secMapMeta").textContent = `${rows.length} 个区域 · ${domesticSources} 个攻击源 · ${blockedSources} 个当前封禁`;
    $("secMapHint").textContent = "中国来源按 0.5° 经纬网格聚合；滚轮、双指缩放，拖动查看";
    $("secMapNote").textContent = "中国地图使用 CrowdSec 离线 GeoLite2-City 经纬度，只展示中国大陆及港澳台来源；没有省市字段时不猜省份。圆点大小表示事件量，红色外圈表示存在当前封禁。";
    renderMapRank(rows, domesticSources ? `有 ${unlocated} 个中国来源缺少坐标` : "所选时间内没有中国来源攻击");
    if (!rows.length)
      mapEmpty(domesticSources ? "中国来源存在，但缺少可定位坐标" : "所选时间内没有中国来源攻击");
    if (secMapRenderedMode !== "china") {
      const chinaZoom = $("secMap").clientWidth >= 700 ? 4 : 3;
      map.setView([35,104], chinaZoom, {animate:false});
    }
  } else {
    const byCountry = {};
    for (const item of incidents || []) {
      const code = String(item.country || "").trim().toUpperCase();
      if (!code || code === "??") continue;
      const slot = byCountry[code] || (byCountry[code] = {
        code, sources:0, events:0, blocked:0, latSum:0, lonSum:0, located:0,
      });
      slot.sources++;
      slot.events += Math.max(1, Number(item.event_count || item.count || 1));
      if (item.blocked) slot.blocked++;
      const geo = mapGeo(item);
      if (geo) { slot.latSum += geo[0]; slot.lonSum += geo[1]; slot.located++; }
    }
    const rows = Object.values(byCountry).map(x => {
      const fallback = COUNTRY_POINT[x.code];
      return {...x, label:cname(x.code), title:cname(x.code),
        lat:x.located ? x.latSum/x.located : fallback?.[1],
        lon:x.located ? x.lonSum/x.located : fallback?.[0]};
    }).sort((a,b) => b.events - a.events);
    rows.filter(x => Number.isFinite(x.lat) && Number.isFinite(x.lon))
      .forEach(x => addAttackMarker(x, x.label));
    const totalSources = rows.reduce((n,x) => n + x.sources, 0);
    const blockedSources = rows.reduce((n,x) => n + x.blocked, 0);
    $("secMapMeta").textContent = `${rows.length} 个国家 · ${totalSources} 个攻击源 · ${blockedSources} 个当前封禁`;
    $("secMapHint").textContent = "世界地图按国家聚合；滚轮、双指缩放，拖动查看";
    $("secMapNote").textContent = "世界地图按国家聚合攻击来源。本地 Natural Earth 简图不依赖 VPN、Key 或第三方请求；攻击 IP 与事件数据始终只在本页面本地叠加。";
    renderMapRank(rows, "暂无国家级攻击数据");
    if (!rows.length) mapEmpty("所选时间内没有可定位的攻击事件");
    if (secMapRenderedMode !== "world")
      map.fitBounds([[-55,-175],[75,175]], {padding:[8,8], animate:false});
  }
  secMapRenderedMode = secMapMode;
  setTimeout(() => map.invalidateSize({pan:false}), 0);
}


function secMachineName() {
  return isLocal() ? "本机" : activeNode;
}

/* 安全中心以前完全没接节点切换：选了某台，这一页从头到尾还是全集群的数字，
   切了等于没切，而且没有任何提示说它没切。

   但也不能一刀切成"整页跟着节点走"——这一页里真正分层级：
     L0  防护闭环、安全变更：全局的，跟看哪台无关
     L1  覆盖缺口、受管资产、攻击事件：每条带 machine，可以按机器过滤
     L2  应用防护（WAF）：某台上的东西

   所以按层分别处理，并且把每块属于哪一层标出来。 */
function secFilterByNode(d) {
  if (isLocal() && fleetItems.length < 2) return d;   // 单机部署不必分层
  const me = secMachineName();
  if (isLocal()) return d;                            // 本机视图看全集群，是合理的默认
  const c = {...(d.coverage || {})};
  c.issues = (c.issues || []).filter(x => x.machine === me);
  c.assets = (c.assets || []).filter(x => x.machine === me);
  const cc = {...(c.counts || {})};
  cc.assets = c.assets.length;
  cc.crit = c.issues.filter(x => x.level === "crit").length;
  cc.warn = c.issues.filter(x => x.level === "warn").length;
  c.counts = cc;
  const inc = {...(d.incidents || {})};
  inc.items = (inc.items || []).filter(
    x => !x.machines || x.machines.includes(me) || x.machine === me);
  return {...d, coverage: c, incidents: inc};
}

function renderSecurityCenter(raw) {
  // 原始响应单独留一份。secData 存的是过滤后的（其他地方靠它查 incident 详情），
  // 切换节点时若拿它再过滤一遍，过滤就叠加了——第二次切换会越滤越少
  if (raw) secRaw = raw;
  if (!secRaw) return;
  const d = secFilterByNode(secRaw);
  secData = d;
  const scoped = !isLocal();
  const scopeTag = scoped ? `<span class="scope only">仅 ${esc(activeNode)}</span>`
                          : (fleetItems.length > 1 ? `<span class="scope all">全集群</span>` : "");
  const clusterTag = fleetItems.length > 1 ? `<span class="scope all">全集群</span>` : "";
  const c = d.coverage || {}, cc = c.counts || {};
  const cDot = cc.crit ? "crit" : cc.warn ? "warn" : "ok";
  $("secCoverage").innerHTML = `<h2><span class="dot ${cDot}"></span>保护覆盖${scopeTag}
      <span class="right">${c.status === "healthy" ? "链路正常" : "存在缺口"}</span></h2>
    <div class="stats">
      <div class="stat"><div class="n">${cc.assets ?? 0}</div><div class="l">受管资产</div></div>
      <div class="stat"><div class="n" style="color:${cc.crit?"var(--crit)":"inherit"}">${cc.crit ?? 0}</div><div class="l">严重缺口</div></div>
      <div class="stat"><div class="n" style="color:${cc.warn?"var(--warn)":"inherit"}">${cc.warn ?? 0}</div><div class="l">待确认</div></div>
    </div>
    <div class="note">${scoped
      ? `只统计 ${esc(activeNode)} 上的资产与缺口。切到本机可以看全集群汇总`
      : `节点在线 ${cc.nodes_online ?? 0}/${cc.nodes_total ?? 0}，资产来自当前采集快照`}</div>`;

  // L0：闭环是"中央检出到各节点生效"的整条链路，按单台过滤没有意义
  $("secPipeline").innerHTML = `<h2><span class="dot ${cDot}"></span>防护闭环${clusterTag}
      <span class="right">检出 → 决策 → 下发 → 生效 → 命中</span></h2>
    <div class="secpipe">${(c.pipeline || []).map((x, i) => `
      <div class="secstage"><span>${i + 1}</span><b>${esc(x.label)}</b><em>${esc(x.value)}</em></div>`
    ).join("")}</div>`;

  const ap = d.appsec || {}, op = ap.onepanel || {}, ca = ap.crowdsec_appsec || {};
  const appDot = op.available ? "ok" : ca.configured ? "warn" : "warn";
  const caps = Object.entries(op.capabilities || {}).filter(([,v]) => v).map(([k]) => ({
    waf:"规则防护", rate_limit:"限流", bot:"机器人", geo:"地域", allow_deny:"黑白名单"}[k] || k));
  $("secAppsec").innerHTML = `<h2><span class="dot ${appDot}"></span>应用防护${scopeTag}</h2>
    <div class="big sm">${op.available ? "1Panel WAF" : ca.configured ? "CrowdSec AppSec" : "待接入"}
      ${op.machine ? machineTag(op.machine) : ""}</div>
    <div class="sub">${esc(op.message || ca.message || "")}</div>
    ${caps.length ? `<div class="tagwrap" style="margin-top:12px">${caps.map(x => `<span class="tag ok">${esc(x)}</span>`).join("")}</div>` : ""}
    ${op.available ? `<div class="note">请求记录 ${op.request_rows ?? "—"} · 攻击 ${op.attack_rows ?? "—"} · 拦截 ${op.blocked_rows ?? "—"}${(op.remote_nodes || []).length > 1 ? ` · 另 ${op.remote_nodes.length - 1} 个 WAF 节点` : ""}</div>` : ""}`;

  const issues = c.issues || [];
  $("secIssues").innerHTML = issues.length ? `<table class="tbl"><thead><tr>
      <th>级别</th><th>机器/目标</th><th>缺口</th><th>建议</th></tr></thead><tbody>
    ${issues.map(x => `<tr><td><span class="tag ${esc(x.level)}">${x.level === "crit" ? "严重" : "确认"}</span></td>
      <td>${machineTag(x.machine)} ${x.target != null ? `<span class="mono">${esc(x.target)}</span>` : ""}</td>
      <td>${esc(x.title)}</td><td class="why">${esc(x.detail)}</td></tr>`).join("")}</tbody></table>`
    : `<div class="empty">当前采集范围内没有发现保护缺口</div>`;

  const inc = d.incidents || {}, incidents = inc.items || [];
  renderSecurityMap(incidents, d.map || {});
  $("secIncidents").innerHTML = incidents.length ? `<table class="tbl"><thead><tr>
      <th>攻击源</th><th>涉及机器</th><th>场景</th><th>次数</th><th>状态</th><th></th></tr></thead><tbody>
    ${incidents.map(x => `<tr class="${x.false_positive ? "stale" : ""}">
      <td><span class="ipcell">${esc(x.ip)}</span>${x.country ? ` <span class="tag">${esc(cname(x.country))}</span>` : ""}<br>
        <span class="note">最近 ${esc(agoHours(x.last_age_hours))}${x.blocked ? " · 已封禁" : ""}</span></td>
      <td><div class="tagwrap">${(x.machines || []).map(m => machineTag(m)).join("") || "—"}</div></td>
      <td class="why" title="${esc((x.scenarios || []).join("、"))}">${esc((x.scenarios || []).join("、") || "—")}</td>
      <td>${x.count} 组<br><span class="note">${x.event_count || 0} 事件</span></td>
      <td><span class="tag ${x.status === "resolved" ? "ok" : x.status === "investigating" ? "warn" : ""}">${esc(secStatusName(x.status))}</span>
        ${x.false_positive ? '<span class="tag">误报</span>' : ""}${x.note ? `<div class="note" title="${esc(x.note)}">${esc(x.note)}</div>` : ""}</td>
      <td class="act"><button class="btn sm ghost" data-sec-cti="${esc(x.ip)}">情报</button>
        <button class="btn sm ghost" data-sec-note="${esc(x.key)}">备注</button>
        <button class="btn sm ghost" data-sec-status="${esc(x.key)}" data-status="${x.status === "resolved" ? "open" : "resolved"}">${x.status === "resolved" ? "重开" : "处理"}</button>
        <button class="btn sm ghost" data-sec-fp="${esc(x.key)}">${x.false_positive ? "取消误报" : "误报"}</button>
        ${x.blocked ? "" : `<button class="btn sm ${secBanConfirm === x.ip ? "confirm" : "danger"}" data-sec-ban="${esc(x.ip)}">${secBanConfirm === x.ip ? "再点确认" : "临时封禁"}</button>`}</td>
    </tr>`).join("")}</tbody></table>` : `<div class="empty">所选时间内没有 CrowdSec 攻击事件</div>`;

  const changes = d.changes || [];
  $("secChanges").innerHTML = changes.length ? `<table class="tbl"><thead><tr>
      <th>时间</th><th>目标</th><th>动作</th><th>状态</th><th>说明</th><th></th></tr></thead><tbody>
    ${changes.map(x => `<tr><td>${clock(x.ts)}</td><td class="ipcell">${esc(x.target)}</td>
      <td>${x.action === "ban" ? "临时封禁" : "解除封禁"}</td>
      <td><span class="tag ${x.status === "applied" ? "warn" : x.status.includes("failed") ? "crit" : "ok"}">${esc(secChangeName(x.status))}</span></td>
      <td class="why">${esc(x.detail || "")}</td><td class="act">${x.status === "applied" && x.action === "ban"
        ? `<button class="btn sm ${secRollbackConfirm === x.id ? "confirm" : "ghost"}" data-sec-rollback="${esc(x.id)}">${secRollbackConfirm === x.id ? "再点确认" : "回滚"}</button>` : ""}</td></tr>`).join("")}
    </tbody></table>` : `<div class="empty">还没有安全变更记录</div>`;
  $("secUpdated").textContent = "核查于 " + new Date().toLocaleTimeString();
}

async function loadSecurity(force=false) {
  if (secLoading || (!force && Date.now() - secLoadedAt < 20000)) return;
  secLoading = true;
  try {
    const res = await fetch(`/api/security/overview?hours=${secRange}&limit=200`, {cache:"no-store"});
    const d = await res.json();
    if (!res.ok) throw new Error(d.detail || `HTTP ${res.status}`);
    secLoadedAt = Date.now();
    renderSecurityCenter(d);
  } catch (e) {
    $("secIssues").innerHTML = `<div class="empty">安全中心加载失败：${esc(e.message)}</div>`;
  } finally { secLoading = false; }
}

async function updateSecurityIncident(key, patch) {
  const current = (secData?.incidents?.items || []).find(x => x.key === key) || {};
  try {
    await api(`/api/security/incidents/${encodeURIComponent(key)}`, "PATCH", {
      status: patch.status ?? current.status ?? "open",
      note: patch.note ?? current.note ?? "",
      false_positive: patch.false_positive ?? current.false_positive ?? false,
    });
    toast("事件状态已保存", "刷新采集后仍会保留");
    secLoadedAt = 0; await loadSecurity(true);
  } catch (e) { toast("保存失败", e.message, true); }
}

async function doSecurityBan(ip) {
  try {
    const r = await api("/api/security/changes/ban", "POST", {
      ip, duration:"4h", reason:"事件中心确认后临时封禁"});
    toast(`已临时封禁 ${ip}`, `变更 ${r.change_id.slice(0,8)}，健康核查通过`);
  } catch (e) { toast("安全变更失败", e.message, true); }
  secBanConfirm = null; secLoadedAt = 0; await loadSecurity(true); await refresh();
}

async function doSecurityRollback(id) {
  try {
    await api(`/api/security/changes/${encodeURIComponent(id)}/rollback`, "POST");
    toast("已回滚安全变更", "对应封禁已解除");
  } catch (e) { toast("回滚失败", e.message, true); }
  secRollbackConfirm = null; secLoadedAt = 0; await loadSecurity(true); await refresh();
}

async function showSecurityCti(ip) {
  try {
    const res = await fetch(`/api/security/cti/${encodeURIComponent(ip)}`), d = await res.json();
    if (!res.ok) throw new Error(d.detail || `HTTP ${res.status}`);
    if (!d.enabled) { toast("威胁情报未启用", d.message || "未配置 CTI key"); return; }
    const x = d.data || {};
    $("modal").innerHTML = `<div class="modal"><div class="modal-box">
      <div class="modal-head"><h3>${esc(ip)} 威胁情报</h3><span class="sp"></span>
        <button class="btn sm ghost" id="ctiClose">关闭</button></div>
      <div class="grid cols2"><div class="card flat"><h2>结论</h2>
        <div class="row"><span class="k">恶意度</span><span class="v">${esc(x.maliciousness || x.reputation || "—")}</span></div>
        <div class="row"><span class="k">置信度</span><span class="v">${esc(x.confidence || "—")}</span></div>
        <div class="row"><span class="k">分类</span><span class="v">${esc((x.behaviors || x.classifications || []).join?.("、") || "—")}</span></div>
      </div><div class="card flat"><h2>原始情报</h2><pre class="logbox">${esc(JSON.stringify(x, null, 2))}</pre></div></div>
    </div></div>`;
    $("ctiClose").onclick = () => $("modal").innerHTML = "";
  } catch (e) { toast("情报查询失败", e.message, true); }
}

