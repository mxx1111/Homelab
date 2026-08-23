/* 节点视图渲染的回归测试。

   跑法：先起面板（demo 模式就行），然后
     node tests/nodeview.test.mjs http://127.0.0.1:8770

   覆盖的是重构最容易回退的地方：本机和节点必须渲染出同样多的卡位、
   缺模块要出占位而不是空白或报错、卡片排序不能每轮乱跳。 */
import {loadApp, runner} from "./dom-stub.mjs";

const base = (process.argv[2] || "http://127.0.0.1:8770").replace(/\/$/, "");
const api = loadApp("renderSnapshotOverview, moduleCard, renderFleetStrip, " +
                    "renderOfflineNode, alertAnchor, setFleet:(v)=>{fleetItems=v}, " +
                    "setActive:(v)=>{activeNode=v}");
const {t, done} = runner();

const get = async path => {
  const r = await fetch(base + path);
  if (!r.ok) throw new Error(`${path} -> HTTP ${r.status}`);
  return r.json();
};
const order = html => [...html.matchAll(/data-module="(\w+)"/g)].map(m => m[1]);
const levels = html =>
  [...html.matchAll(/data-module="(\w+)" class="card[^"]*">\s*<h2><span class="dot (\w*)"/g)]
    .map(m => [m[1], m[2]]);
const weight = l => l === "crit" ? 0 : l === "warn" ? 1 : 2;

const fleet = await get("/api/nodes");
const snaps = {};
for (const n of fleet.items) snaps[n.id] = await get(`/api/nodes/${encodeURIComponent(n.id)}/snapshot`);
const local = snaps.local;
const clone = s => JSON.parse(JSON.stringify(s));

console.log(`机器 ${fleet.items.length} 台: ${fleet.items.map(n => n.name).join("、")}\n`);

console.log("契约：本机和节点同构");
const counts = {};
for (const [id, snap] of Object.entries(snaps)) {
  const n = order(api.renderSnapshotOverview(snap)).length;
  counts[id] = n;
}
t("每台都渲染出全部模块卡位（缺的出占位，不是少一张）", () => {
  const want = local.order.length;
  const bad = Object.entries(counts).filter(([, n]) => n !== want);
  return bad.length === 0 || `期望 ${want} 张，实得 ${JSON.stringify(counts)}`;
});
t("没有任何一张卡渲染报错", () => {
  for (const [id, snap] of Object.entries(snaps))
    if (api.renderSnapshotOverview(snap).includes("这张卡渲染出错了")) return `${id} 有报错卡`;
  return true;
});
t("占位卡不出现 undefined / null", () => {
  for (const [id, snap] of Object.entries(snaps)) {
    const h = api.renderSnapshotOverview(snap);
    if (/undefined|>null</.test(h)) return `${id} 渲染出 undefined/null`;
  }
  return true;
});

console.log("\n容错");
t("modules 全空 → 全部出占位，不抛异常", () => {
  const s = clone(local);
  s.modules = {};
  s.capabilities = Object.fromEntries(s.order.map(m => [m, "unsupported"]));
  return (api.renderSnapshotOverview(s).match(/未启用/g) || []).length === s.order.length;
});
t("capability 说 full 但 modules 里没有 → 退回占位", () => {
  const s = clone(local);
  s.capabilities.host = "full";
  delete s.modules.host;
  return api.moduleCard(s, "host").includes("未启用");
});
t("模块名拼错 → 返回空串，不伪装成占位卡", () => api.moduleCard(local, "typo_module") === "");
t("节点离线 → 模块流不出内容，离线提示由 renderOfflineNode 单独出", () => {
  const s = clone(local);
  s.node.ok = false;
  s.node.error = "SSH 超时";
  /* 职责是分开的：离线提示要横跨整行，而模块卡走 CSS columns 瀑布流，
     .card.full 在那里面拿不到整行。所以模块流返回空，提示由调用方
     渲染到瀑布流外的全宽容器 */
  return api.renderSnapshotOverview(s) === ""
      && api.renderOfflineNode(s).includes("SSH 超时")
      || `模块流=${JSON.stringify(api.renderSnapshotOverview(s).slice(0,40))}`;
});

console.log("\n卡片排序");
t("crit 排在 warn 前，warn 排在其余前", () => {
  const pairs = levels(api.renderSnapshotOverview(clone(local)));
  if (!pairs.length) return "没解析出等级";
  for (let i = 1; i < pairs.length; i++)
    if (weight(pairs[i][1]) < weight(pairs[i - 1][1]))
      return `${pairs[i - 1]} 排在了 ${pairs[i]} 前面`;
  return true;
});
t("等级没变时顺序稳定（5 秒轮询不能让卡片跳）", () => {
  const s = clone(local);
  const a = order(api.renderSnapshotOverview(s));
  if (s.modules.host) s.modules.host.load_percent = (s.modules.host.load_percent || 10) + 1;
  const b = order(api.renderSnapshotOverview(s));
  return JSON.stringify(a) === JSON.stringify(b) || `${a}\n     vs ${b}`;
});

console.log("\nfleet 条");
t("只有一台时不渲染（单机部署不需要）", () => {
  api.setFleet([{id: "local", name: "本机", role: "local", ok: true, level: "ok", issues: []}]);
  return api.renderFleetStrip() === "";
});
t("离线机器标出原因，指标缺失不显示 null%", () => {
  api.setFleet([
    {id: "local", name: "本机", role: "local", ok: true, level: "ok", issues: []},
    {id: "a", name: "A", role: "remote", ok: false, error: "SSH 超时", level: "crit", issues: []},
  ]);
  api.setActive("local");
  const h = api.renderFleetStrip();
  return h.includes("SSH 超时") && !h.includes("null%") && !h.includes("undefined");
});

console.log("\n告警锚点");
for (const [key, want] of [["storage:数据盘", "overview/storage"], ["cert:a.com", "overview/certs"],
                            ["disk:sda", "overview/disks"], ["ban:1.2.3.4", "firewall/"],
                            ["service:Nginx", "overview/probes"], ["未知类型:x", "/"]])
  t(`${key} → ${want}`, () => {
    const [tab, mod] = api.alertAnchor(key);
    return `${tab || ""}/${mod || ""}` === want || `${tab}/${mod}`;
  });

process.exit(done() ? 1 : 0);
