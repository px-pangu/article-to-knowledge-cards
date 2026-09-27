#!/usr/bin/env node

/**
 * 冒烟检查：模拟浏览器打开页面后的完整链路。
 *
 * 与 e2e-check.mjs 的分工：
 *   - e2e-check 关注「接口行为是否正确」，用假文章，很多用例走 mock
 *   - 本脚本关注「用户真实操作能不能走通」，用一篇真文章真实抽卡
 *
 * 用法：node test-smoke-check.mjs [base]
 */

const base = (process.argv[2] || "http://127.0.0.1:8787").replace(/\/+$/, "");

let pass = 0;
let fail = 0;

function ck(name, condition, detail) {
  if (condition) {
    pass++;
    console.log(`  \u2713  ${name}`);
  } else {
    fail++;
    console.log(`  \u2717  ${name}${detail ? `  \u2192 ${detail}` : ""}`);
  }
}

console.log("冒烟检查：浏览器打开页面后的完整链路\n");
console.log(`目标：${base}\n`);

/* 1. 首页与静态资源 —— 这一步失败通常意味着文件放错了目录 */
console.log("[1] 页面加载");
let html = "";
try {
  const res = await fetch(base + "/");
  html = await res.text();
  ck("首页返回 200", res.status === 200, `实际 ${res.status}`);
  ck("页面标题正确", html.includes("<title>文章转知识卡片</title>"));
  ck("引用了 /app.js", html.includes("/app.js"));
  ck("引用了 /style.css", html.includes("/style.css"));
} catch (err) {
  ck("首页可访问", false, err.message);
  console.log("\n  页面都打不开，后续检查已跳过。");
  console.log("  提示：在 app 目录执行 node doctor.mjs 定位问题。");
  process.exit(1);
}

const css = await fetch(base + "/style.css");
ck("样式表可加载", css.status === 200, `实际 ${css.status}`);
const js = await fetch(base + "/app.js");
ck("前端脚本可加载", js.status === 200, `实际 ${js.status}`);

/* 2. 健康接口 */
console.log("\n[2] 健康接口");
const health = await (await fetch(base + "/api/health")).json();
ck("返回 ok:true", health.ok === true);
ck("运行在 live 模式（真实调用模型）", health.mode === "live", `实际 ${health.mode}`);
ck("已配置抽卡规则", health.promptChars > 1000, `提示词 ${health.promptChars} 字符`);

/* 3. 真实抽卡 —— 用一篇信息量充足的文章，走完整链路 */
console.log("\n[3] 真实抽卡（信息量充足的文章）");
const article =
  "深度工作是指在无干扰状态下专注进行职业活动，这些努力能创造新价值、" +
  "提升技能且难以复制。与之相对的是浮浅工作，指对认知要求不高的事务性任务，" +
  "往往在受到干扰的情况下开展，容易复制。要判断一项任务是否属于浮浅工作，" +
  "可以用一个标准：这件事能否被一个刚毕业的大学生很快学会？如果能，" +
  "它很可能是浮浅的。深度工作的价值在于它能在单位时间内产出更多成果，" +
  "而且这些成果具有稀缺性。刻意练习是达到深度工作状态的重要方法，" +
  "它要求把注意力集中在当前技能的最薄弱环节，并持续获得即时反馈。" +
  "此外，注意力残留现象值得警惕：当人从一项任务切换到另一项时，" +
  "前一项任务的思维惯性会持续占用认知资源，降低后一项任务的完成质量。" +
  "因此，减少任务切换频率本身就是保护深度工作能力的手段之一。";

const started = Date.now();
const res = await fetch(base + "/api/cards", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ text: article }),
});
const elapsed = ((Date.now() - started) / 1000).toFixed(1);

ck("抽卡接口返回 200", res.status === 200, `实际 ${res.status}`);

let json = null;
const raw = await res.text();
try {
  json = JSON.parse(raw);
} catch {
  ck("响应是合法 JSON", false, `收到非 JSON：${raw.slice(0, 120)}`);
}

if (json) {
  ck("响应为合法 JSON", true);
  const cards = json.data && json.data.cards;
  ck("返回 ok:true", json.ok === true);
  ck("含非空 cards 数组", Array.isArray(cards) && cards.length > 0);

  if (Array.isArray(cards) && cards.length) {
    // 注意：5-8 张是「信息量充足时」的常规区间，不是硬性配额。
    // 用信息充足的文章测这个区间才有意义；信息不足时少于 5 张才是正确的。
    ck(
      "信息充足时卡片数落在 5-8 区间",
      cards.length >= 5 && cards.length <= 8,
      `实际 ${cards.length} 张`
    );
    ck(
      "每张卡片字段完整（标题/核心/解释 + 例子或自测）",
      cards.every((c) => c.title && c.core && c.explain && (c.example || c.quiz))
    );
    ck("每张卡片都有标题", cards.every((c) => String(c.title || "").trim().length > 0));

    console.log(`\n  耗时 ${elapsed}s，共 ${cards.length} 张卡片：`);
    cards.forEach((c, i) => console.log(`    ${i + 1}. ${c.title}`));

    if (json.meta) {
      console.log(
        `  元信息：${json.meta.model || "-"} · ${json.meta.elapsedMs || "-"}ms` +
          (json.meta.attempts > 1 ? ` · 重试 ${json.meta.attempts - 1} 次` : " · 一次通过")
      );
    }
  }
}

/* 4. 信息不足时不得凑数 —— SKILL.md 的硬性要求 */
console.log("\n[4] 信息不足时不得凑数");
const shortText =
  "浮浅工作是指那些不需要太多认知努力、容易被替代的事务性任务。" +
  "判断标准很简单：一个刚毕业的大学生能否很快学会。";
const shortRes = await fetch(base + "/api/cards", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ text: shortText }),
});
const shortJson = await shortRes.json();
const shortCards = shortJson.data && shortJson.data.cards;

ck("接口正常返回", shortRes.status === 200, `实际 ${shortRes.status}`);
ck(
  "卡片数少于 5（没有为凑数而注水或拆碎知识点）",
  Array.isArray(shortCards) && shortCards.length > 0 && shortCards.length < 5,
  `实际 ${Array.isArray(shortCards) ? shortCards.length : "-"} 张`
);
if (Array.isArray(shortCards)) {
  console.log(`  只给了 ${shortCards.length} 张卡片（原文信息量只够这么多）`);
  shortCards.forEach((c, i) => console.log(`    ${i + 1}. ${c.title}`));
}

console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
