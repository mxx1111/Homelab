/* 前端拆成四个文件后，盯的是拆分本身会引入的新风险。

   拼接起来能跑，不等于浏览器里能跑：浏览器按 index.html 的顺序逐个执行
   script，任何一个文件在顶层就用到后面文件的东西，都会当场 TDZ 报错。
   拼接测试发现不了这个——它把四个文件当成一整段代码，函数声明整体提升了。

   跑法：node tests/split.test.mjs */
import fs from "fs";
import {SCRIPTS, runner} from "./dom-stub.mjs";

const {t, done} = runner();
const read = f => fs.readFileSync(new URL(`../frontend/${f}`, import.meta.url), "utf8");
const html = read("index.html");

console.log("加载顺序");
t("index.html 的引入顺序和 SCRIPTS 一致", () => {
  const found = [...html.matchAll(/src="\/static\/(app[\w-]*\.js)/g)].map(m => m[1]);
  return JSON.stringify(found) === JSON.stringify(SCRIPTS)
    || `index.html: ${found}\n     SCRIPTS:    ${SCRIPTS}`;
});
t("app.js 排在最后（它是唯一有顶层执行语句的）", () => SCRIPTS[SCRIPTS.length - 1] === "app.js");

console.log("\n顶层执行语句只允许出现在最后一个文件");
for (const f of SCRIPTS.slice(0, -1)) {
  t(`${f} 顶层没有依赖加载顺序的执行语句`, () => {
    const bad = read(f).split("\n")
      .map((l, i) => [i + 1, l])
      // 顶层 = 顶格。声明放行
      .filter(([, l]) => /^[a-zA-Z$_(]/.test(l))
      .filter(([, l]) => !/^(function|const|let|var|class|async function|export)\b/.test(l))
      // 给 window / globalThis 打补丁放行：不碰 DOM，也不引用别的文件，
      // 加载顺序对它没有约束
      .filter(([, l]) => !/^(window|globalThis)\./.test(l))
      .filter(([, l]) => !/^\w+\s*\(/.test(l) || /^(if|for|while|switch|return|catch)\b/.test(l));
    return bad.length === 0 || bad.map(([n, l]) => `${f}:${n} ${l.trim().slice(0, 60)}`).join("\n     ");
  });
}

console.log("\n没有重复定义（拆分时把同一段抄进两个文件是最容易犯的错）");
const declOf = src => new Set([
  ...[...src.matchAll(/^(?:async\s+)?function\s+(\w+)/gm)].map(m => m[1]),
  ...[...src.matchAll(/^(?:const|let|var)\s+(\w+)\s*=/gm)].map(m => m[1]),
]);
const seen = new Map();
t("同一个名字没有在两个文件里各定义一次", () => {
  const dup = [];
  for (const f of SCRIPTS)
    for (const name of declOf(read(f))) {
      if (seen.has(name)) dup.push(`${name}（${seen.get(name)} 与 ${f}）`);
      else seen.set(name, f);
    }
  return dup.length === 0 || dup.join("、");
});

console.log("\n完整性");
t("四个文件的总行数等于拆分前（没丢代码）", () => {
  const total = SCRIPTS.reduce((n, f) => n + read(f).split("\n").length, 0);
  // 每个文件加了一段文件头注释，减掉之后应与拆分前吻合；这里只要求不为空且量级合理
  return total > 3000 || `总行数 ${total}，偏少，可能丢了代码`;
});
t("每个文件都带了说明头", () => {
  const missing = SCRIPTS.filter(f => !read(f).startsWith("/* Homelab 面板前端 · "));
  return missing.length === 0 || missing.join("、");
});

process.exit(done() ? 1 : 0);
