/* 跑前端渲染函数用的最小 DOM。

   不引 jsdom：整个前端零 npm 依赖是这个项目的一条底线，为了跑测试装一个
   几十 MB 的依赖不划算。渲染函数返回的都是 HTML 字符串，真正需要的只是让
   app.js 顶层那些 $("x").onclick = ... 不炸，stub 到这个程度就够。 */
import fs from "fs";

// 和 frontend/index.html 里的引入顺序保持一致
export const SCRIPTS = ["app-core.js", "app-nodes.js", "app-security.js", "app.js"];

const mkEl = () => ({
  innerHTML: "", textContent: "", value: "", disabled: false,
  dataset: {}, style: {}, clientWidth: 800,
  classList: {add(){}, remove(){}, toggle(){}, contains(){return false}},
  onclick: null, onchange: null,
  addEventListener(){}, insertAdjacentHTML(){}, appendChild(){}, remove(){},
  querySelector(){return null}, querySelectorAll(){return []}, closest(){return null},
  getBoundingClientRect(){return {width: 800, height: 400}},
});

export function loadApp(extraExports = "") {
  const real = {fetch: globalThis.fetch, setTimeout: globalThis.setTimeout,
                setInterval: globalThis.setInterval};
  const store = new Map();
  globalThis.document = {
    getElementById: id => store.get(id) || (store.set(id, mkEl()), store.get(id)),
    querySelector: () => null, querySelectorAll: () => [],
    createElement: mkEl, body: mkEl(), addEventListener(){},
  };
  globalThis.window = {
    addEventListener(){}, matchMedia: () => ({matches: false, addEventListener(){}}),
    fetch: async () => ({ok: false, status: 0, json: async () => ({})}),
    location: {protocol: "http:"},
  };
  globalThis.localStorage = {getItem: () => null, setItem(){}, removeItem(){}};
  globalThis.fetch = async () => ({ok: false, status: 0, json: async () => ({})});
  globalThis.setInterval = () => 0;
  globalThis.setTimeout = () => 0;
  globalThis.addEventListener = () => {};
  globalThis.removeEventListener = () => {};
  globalThis.requestAnimationFrame = () => 0;
  globalThis.alert = () => {};
  globalThis.confirm = () => false;
  globalThis.location = {protocol: "http:", host: "x", href: "http://x/"};
  // Leaflet 故意留空：地图不可用是要覆盖的正常分支，不是异常
  globalThis.L = undefined;

  /* 按 index.html 里的顺序拼起来跑。拼接而不是逐个 eval：这几个文件共享同一份
     全局词法作用域（浏览器里多个 script 标签就是这个语义），分开 eval 的话
     app.js 看不见前面文件的 const，测试会挂在浏览器里根本不会出现的地方。
     顺序和 index.html 不一致时测试会先炸——那正是想要的，它替我们盯着顺序 */
  const src = SCRIPTS
    .map(f => fs.readFileSync(new URL(`../frontend/${f}`, import.meta.url), "utf8"))
    .join("\n;\n");
  const api = new Function(src + `\n;return {${extraExports}};`)();
  /* 把 fetch 和计时器还回去。app.js 顶层那几次调用在上面这行就跑完了（且都被
     stub 挡掉），之后的渲染函数既不碰网络也不用计时器。
     不还 setTimeout 的话，node 的 fetch 实现（undici）用它做连接超时，
     会炸在 "fastNowTimeout?.unref is not a function" 这种看不出所以然的地方 */
  Object.assign(globalThis, real);
  return api;
}

export function runner() {
  let fails = 0;
  const t = (name, fn) => {
    try {
      const r = fn();
      console.log(`  ${r === true ? "ok  " : "??  "} ${name}${r === true ? "" : "  -> " + r}`);
      if (r !== true) fails++;
    } catch (e) {
      console.log(`  FAIL ${name}  -> ${e.message}`);
      fails++;
    }
  };
  return {t, done: () => { console.log(fails ? `\n${fails} 项未通过` : "\n全部通过"); return fails; }};
}
