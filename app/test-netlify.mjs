#!/usr/bin/env node

/**
 * Netlify Functions 本地校验。
 *
 * 部署前先跑这个，可以提前发现：
 *   - 函数 import 的模块是否都能解析（打包后最容易出问题的一环）
 *   - 提示词是否正确同步（prompt-bundle.mjs 是否为最新）
 *   - 健康接口 / 抽卡 / 错误处理是否都正常
 *
 * 不需要 netlify-cli，直接用本地 Node 调用 handler。
 * 用法：node test-netlify.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let pass = 0;
let fail = 0;

function ck(name, ok, detail) {
  if (ok) {
    pass++;
    console.log(`  \u2713  ${name}`);
  } else {
    fail++;
    console.log(`  \u2717  ${name}${detail ? `  \u2192 ${detail}` : ""}`);
  }
}

console.log("Netlify Functions 本地校验\n");

/* ---------- 1. 依赖可解析性（部署失败最常见的原因） ---------- */

console.log("[1] 依赖与打包完整性");
const fnPath = path.join(__dirname, "netlify", "functions", "api.mjs");

if (!fs.existsSync(fnPath)) {
  ck("函数文件存在", false, "netlify/functions/api.mjs 不存在");
  process.exit(1);
}
ck("函数文件存在", true);

const src = fs.readFileSync(fnPath, "utf8");
const imports = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
let allResolved = true;
for (const spec of imports) {
  const resolved = path.resolve(path.dirname(fnPath), spec);
  if (!fs.existsSync(resolved)) {
    allResolved = false;
    console.log(`     缺失：${spec}（解析为 ${resolved}）`);
  }
}
ck(
  `函数 import 的 ${imports.length} 个模块都能解析`,
  allResolved,
  "打包后会出现 Cannot find module"
);

// prompt-bundle.mjs 必须比 SKILL.md 新，否则说明忘了跑 sync-prompt
const skillMd = path.resolve(__dirname, "..", "skills", "make-knowledge-cards", "SKILL.md");
const bundle = path.join(__dirname, "prompt-bundle.mjs");
if (fs.existsSync(skillMd) && fs.existsSync(bundle)) {
  const newer = fs.statSync(bundle).mtimeMs >= fs.statSync(skillMd).mtimeMs;
  ck(
    "提示词已同步（prompt-bundle.mjs 不旧于 SKILL.md）",
    newer,
    "请运行：node sync-prompt.mjs"
  );
} else {
  ck("提示词文件齐全", false, "缺少 prompt-bundle.mjs 或 SKILL.md");
}

/* ---------- 2. 加载函数并调用 ---------- */

console.log("\n[2] 函数加载");
let mod = null;
try {
  mod = await import(pathToFileURL(fnPath).href);
  ck("函数可加载（含顶部 import 求值）", typeof mod.handler === "function");
} catch (err) {
  ck("函数可加载", false, err.message);
  console.log("\n  函数都加载不了，后续检查已跳过。");
  process.exit(1);
}

/* ---------- 3. 路由与健康接口 ---------- */

console.log("\n[3] 路由分发");
const health = await mod.handler({ path: "/api/health", httpMethod: "GET", headers: {} });
ck("GET /api/health 返回 200", health.statusCode === 200, `实际 ${health.statusCode}`);

let healthBody = null;
try {
  healthBody = JSON.parse(health.body);
  ck("健康接口返回合法 JSON", true);
} catch {
  ck("健康接口返回合法 JSON", false, health.body?.slice(0, 100));
}

if (healthBody) {
  ck("返回 platform 标识", healthBody.platform === "netlify-functions");
  ck(
    "提示词已注入（promptChars > 1000）",
    healthBody.promptChars > 1000,
    `实际 ${healthBody.promptChars}`
  );
  console.log(`     模式：${healthBody.mode} · 提示词 ${healthBody.promptChars} 字符`);
}

const notFound = await mod.handler({ path: "/api/whatever", httpMethod: "GET", headers: {} });
ck("未知接口返回 404", notFound.statusCode === 404, `实际 ${notFound.statusCode}`);

const wrongMethod = await mod.handler({ path: "/api/cards", httpMethod: "GET", headers: {} });
ck("GET /api/cards 返回 405", wrongMethod.statusCode === 405, `实际 ${wrongMethod.statusCode}`);

const opts = await mod.handler({ path: "/api/cards", httpMethod: "OPTIONS", headers: {} });
ck("OPTIONS 预检返回 204", opts.statusCode === 204, `实际 ${opts.statusCode}`);

/* ---------- 4. 请求体解析（Netlify 可能传 base64） ---------- */

console.log("\n[4] 请求体解析");
const emptyRes = await mod.handler({
  path: "/api/cards",
  httpMethod: "POST",
  headers: {},
  body: JSON.stringify({ text: "" }),
});
ck("空文本返回 400", emptyRes.statusCode === 400, `实际 ${emptyRes.statusCode}`);

const b64Res = await mod.handler({
  path: "/api/cards",
  httpMethod: "POST",
  headers: {},
  isBase64Encoded: true,
  body: Buffer.from(JSON.stringify({ text: "" }), "utf8").toString("base64"),
});
ck(
  "base64 请求体能正确解码（不是解析失败）",
  b64Res.statusCode === 400 && /为空/.test(b64Res.body),
  `实际 ${b64Res.statusCode}：${b64Res.body?.slice(0, 80)}`
);

const badJson = await mod.handler({
  path: "/api/cards",
  httpMethod: "POST",
  headers: {},
  body: "{不是合法 JSON",
});
ck("非法 JSON 返回 400", badJson.statusCode === 400, `实际 ${badJson.statusCode}`);

const tooLong = await mod.handler({
  path: "/api/cards",
  httpMethod: "POST",
  headers: {},
  body: JSON.stringify({ text: "字".repeat(70000) }),
});
ck("超长文本返回 413", tooLong.statusCode === 413, `实际 ${tooLong.statusCode}`);

/* ---------- 5. 口令拦截 ---------- */

console.log("\n[5] 访问口令");
if (process.env.APP_TOKEN) {
  const noToken = await mod.handler({
    path: "/api/cards",
    httpMethod: "POST",
    headers: {},
    body: JSON.stringify({ text: "测试" }),
  });
  ck("未带口令被拒（401）", noToken.statusCode === 401, `实际 ${noToken.statusCode}`);

  const withToken = await mod.handler({
    path: "/api/cards",
    httpMethod: "POST",
    headers: { authorization: `Bearer ${process.env.APP_TOKEN}` },
    body: JSON.stringify({ text: "测试" }),
  });
  ck("带口令可放行（非 401）", withToken.statusCode !== 401, `实际 ${withToken.statusCode}`);
} else {
  console.log("  跳过  未设置 APP_TOKEN（公网部署建议设置）");
}

/* ---------- 6. 真实抽卡（可选，会消耗额度） ---------- */

console.log("\n[6] 真实抽卡");
if (process.env.LLM_API_KEY) {
  const started = Date.now();
  const res = await mod.handler({
    path: "/api/cards",
    httpMethod: "POST",
    headers: process.env.APP_TOKEN
      ? { authorization: `Bearer ${process.env.APP_TOKEN}` }
      : {},
    body: JSON.stringify({
      text:
        "深度工作是指在无干扰状态下专注进行职业活动，这些努力能创造新价值、" +
        "提升技能且难以复制。与之相对的是浮浅工作，指对认知要求不高的事务性任务，" +
        "容易复制。判断浮浅工作的标准是：这件事能否被一个刚毕业的大学生很快学会。" +
        "深度工作的价值在于单位时间内产出更多成果，且具有稀缺性。" +
        "刻意练习是进入深度工作的重要方法，要求把注意力集中在最薄弱环节并持续获得即时反馈。",
    }),
  });
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  ck("抽卡返回 200", res.statusCode === 200, `实际 ${res.statusCode}`);

  let body = null;
  try {
    body = JSON.parse(res.body);
  } catch {
    /* 下面会报 */
  }
  if (body && body.ok) {
    const cards = body.data?.cards || [];
    ck("返回卡片数组", cards.length > 0, `实际 ${cards.length} 张`);
    ck(
      "卡片字段完整",
      cards.every((c) => c.title && c.core && c.explain && (c.example || c.quiz))
    );
    console.log(`     耗时 ${elapsed}s，${cards.length} 张卡片（尝试 ${body.meta?.attempts} 次）`);
    cards.forEach((c, i) => console.log(`       ${i + 1}. ${c.title}`));

    // 关键：Netlify 免费版 10 秒上限，本地实测耗时超 8 秒就要警惕
    ck(
      "耗时在平台时限内（< 8 秒有安全余量）",
      Number(elapsed) < 8,
      `实际 ${elapsed}s —— 接近 Netlify 免费版 10s 上限，长文章可能线上超时`
    );
  } else {
    console.log(`     返回：${res.body?.slice(0, 200)}`);
  }
} else {
  console.log("  跳过  未设置 LLM_API_KEY（可用 .env 或环境变量提供）");
}

console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
