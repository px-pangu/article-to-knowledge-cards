#!/usr/bin/env node

import http from "node:http";

/**
 * 端到端校验：把服务当作黑盒，逐项检查接口行为。
 *
 * 用法：
 *   1) 启动服务（建议配合 mock-model.mjs）
 *   2) node test-e2e-check.mjs http://127.0.0.1:8788
 *
 * 退出码 0 表示全部通过。
 */

const base = (process.argv[2] || "http://127.0.0.1:8787").replace(/\/+$/, "");
const token = process.argv[3] || process.env.E2E_TOKEN || "";

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  通过  ${name}`);
  } else {
    failed++;
    console.log(`  失败  ${name}${detail ? `  → ${detail}` : ""}`);
  }
}

async function get(pathname) {
  const res = await fetch(base + pathname);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON 时为 null */
  }
  return { status: res.status, text, json, type: res.headers.get("content-type") || "" };
}

/**
 * 原样发送路径，不做客户端归一化。
 *
 * fetch / curl 都会在发出前把请求路径里的 `..` 消解掉（属于客户端合规行为），
 * 拿它测「服务端路径穿越防护」测不到真正想测的东西。这里直接用原始 socket 发包。
 */
function rawGet(rawPath) {
  return new Promise((resolve, reject) => {
    const u = new URL(base);
    const req = http.request(
      { host: u.hostname, port: u.port || 80, method: "GET", path: rawPath },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            type: res.headers["content-type"] || "",
            body: Buffer.concat(chunks).toString("utf8"),
          })
        );
      }
    );
    req.on("error", reject);
    req.end();
  });
}

/** opts.auth 为 false 时故意不带口令，用于验证拦截行为 */
async function post(pathname, body, opts) {
  const headers = { "content-type": "application/json" };
  if (!opts || opts.auth !== false) {
    if (token) headers.authorization = `Bearer ${token}`;
  }
  const res = await fetch(base + pathname, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON 时为 null */
  }
  return { status: res.status, text, json };
}

const SAMPLE =
  "深度工作指的是在无干扰状态下专注进行职业活动，这种努力能创造新价值、提升技能且难以复制。" +
  "与之相对的浮浅工作，则是指那些在受干扰状态下进行的、不需要太多认知努力的事务性任务。" +
  "浮浅工作往往让人显得很忙，但价值有限。判断一项任务是否属于深度工作，可以看新人能否在短期内学会。";

async function main() {
  console.log(`端到端校验目标：${base}\n`);

  /* 1. 健康检查 */
  console.log("[1] 健康检查");
  const health = await get("/api/health");
  check("返回 200", health.status === 200, `实际 ${health.status}`);
  check("ok 为 true", health.json?.ok === true);
  const isDry = health.json?.mode === "dry-run";
  check("mode 合法", health.json?.mode === "live" || isDry, `实际 ${health.json?.mode}`);
  check("含提示词规模", Number(health.json?.promptChars) > 3000, `实际 ${health.json?.promptChars}`);
  console.log(`       运行模式：${health.json?.mode}${health.json?.model ? ` · ${health.json.model}` : ""}`);

  /* 2. 静态资源 */
  console.log("\n[2] 静态资源");
  const index = await get("/");
  check("首页 200 且为 HTML", index.status === 200 && index.type.includes("text/html"));
  check("首页含页面标题", index.text.includes("文章转知识卡片"));
  const css = await get("/style.css");
  check("样式表可访问", css.status === 200 && css.type.includes("text/css"));
  const js = await get("/app.js");
  check("前端脚本可访问", js.status === 200 && js.type.includes("javascript"));

  /* 3. 抽卡主流程 */
  console.log("\n[3] 抽卡主流程");
  const cards = await post("/api/cards", { text: SAMPLE });
  check("返回 200", cards.status === 200, `实际 ${cards.status}`);
  check("ok 为 true", cards.json?.ok === true, cards.json?.error);
  if (cards.status !== 200 && /LLM_API_KEY/.test(String(cards.json?.error))) {
    console.log("       原因：服务端未配置 LLM_API_KEY，这是配置问题而非代码缺陷。");
    console.log("       处理：在 .env 中填写密钥并重启服务；或先跑 node doctor.mjs 定位。");
    console.log("       若只想验证链路，可用 DRY_RUN=1 或 mock-model.mjs 起服务。");
  }
  const data = cards.json?.data;
  check("含 title", typeof data?.title === "string" && data.title.length > 0);
  check("cards 为非空数组", Array.isArray(data?.cards) && data.cards.length > 0, `实际 ${data?.cards?.length}`);
  check("卡片数量不超过 8", (data?.cards?.length || 0) <= 8);
  const allValid = (data?.cards || []).every(
    (c) =>
      typeof c.no === "number" &&
      typeof c.title === "string" &&
      c.title.length > 0 &&
      typeof c.core === "string" &&
      c.core.length > 0 &&
      typeof c.explain === "string" &&
      c.explain.length > 0 &&
      Boolean(c.example || c.quiz)
  );
  check("每张卡片字段完整（含 example 或 quiz）", allValid);
  check("编号连续", (data?.cards || []).every((c, i) => c.no === i + 1));
  check("含覆盖说明字段", typeof data?.coverageNote === "string");
  check("meta 含耗时", Number(cards.json?.meta?.elapsedMs) >= 0);

  const kinds = (data?.cards || []).map((c) => (c.example ? "例" : "测")).join("");
  console.log(`       卡片数：${data?.cards?.length}  例/测分布：${kinds}`);
  (data?.cards || []).forEach((c) => console.log(`        ${c.no}. ${c.title}`));

  /* 4. 导出 Markdown */
  console.log("\n[4] Markdown 导出格式");
  if (!data?.cards?.length) {
    check("抽卡未成功，跳过导出校验", false, "上一步未拿到卡片数据");
  } else {
    const md = toMarkdown(data);
    check("含一级标题", md.startsWith("# 知识卡片："));
    check("含卡片标题行", md.includes("## 卡片 1｜"));
    check("含四段结构标记", md.includes("**核心知识**") && md.includes("**简明解释**"));
    check("含覆盖说明", !data?.coverageNote || md.includes("**覆盖说明**"));
  }

  /* 5. 错误处理 */
  console.log("\n[5] 错误处理");
  const empty = await post("/api/cards", { text: "" });
  check("空文本返回 400", empty.status === 400, `实际 ${empty.status}`);
  check("错误信息为中文提示", typeof empty.json?.error === "string" && empty.json.error.length > 0);

  const badJson = await post("/api/cards", "{ 这不是 JSON");
  check("非法 JSON 返回 400", badJson.status === 400, `实际 ${badJson.status}`);

  const long = await post("/api/cards", { text: "字".repeat(70000) });
  const longOk = long.status === 413 || (health.json?.maxInputChars || 0) > 70000;
  check("超长文本被拒绝（413）", longOk, `实际 ${long.status}`);

  const nf = await get("/api/not-exist");
  check("未知接口返回 404", nf.status === 404, `实际 ${nf.status}`);

  // 注意：必须用 rawGet（原样发包），fetch 会先把 `..` 消解掉，测不到服务端防护
  const trav = await rawGet("/../server.js");
  check(
    "路径穿越被拦截",
    trav.status === 403 || trav.status === 404,
    `实际 ${trav.status}`
  );

  const travEnc = await rawGet("/%2e%2e/server.js");
  check(
    "编码路径穿越被拦截",
    travEnc.status === 403 || travEnc.status === 404,
    `实际 ${travEnc.status}`
  );

  const wrongMethod = await fetch(base + "/api/cards", { method: "GET" });
  check("错误方法返回 404/405", [404, 405].includes(wrongMethod.status), `实际 ${wrongMethod.status}`);

  /* 6. 访问口令 */
  console.log("\n[6] 访问口令");
  if (health.json?.tokenRequired) {
    const denied = await post("/api/cards", { text: SAMPLE }, { auth: false });
    check("未带口令返回 401", denied.status === 401, `实际 ${denied.status}`);
    const wrong = await fetch(base + "/api/cards", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer wrong-token" },
      body: JSON.stringify({ text: SAMPLE }),
    });
    check("口令错误返回 401", wrong.status === 401, `实际 ${wrong.status}`);
    check("带正确口令可正常抽卡", cards.status === 200, `实际 ${cards.status}`);
    if (!token) console.log("       提示：未传入口令，主流程校验会失败。用法：node test-e2e-check.mjs <base> <token>");
  } else {
    console.log("  跳过  服务未启用 APP_TOKEN");
  }

  console.log(`\n结果：通过 ${passed} 项，失败 ${failed} 项`);
  process.exit(failed === 0 ? 0 : 1);
}

/* 与前端 app.js 中的导出逻辑保持一致，用于校验格式契约 */
function toMarkdown(data) {
  const out = [];
  out.push(`# 知识卡片：${data.title}`);
  out.push("");
  const bits = [`共 ${data.cards.length} 张卡片`];
  if (data.genre) bits.push(`体裁：${data.genre}`);
  bits.push("来源：网页应用");
  out.push(`> ${bits.join("　|　")}`);
  if (data.notice) {
    out.push(">");
    out.push(`> 说明：${data.notice}`);
  }
  out.push("");
  data.cards.forEach((card) => {
    out.push("---");
    out.push("");
    out.push(`## 卡片 ${card.no}｜${card.title}`);
    out.push("");
    out.push("**核心知识**");
    out.push(card.core);
    out.push("");
    out.push("**简明解释**");
    out.push(card.explain);
    out.push("");
    if (card.example) {
      out.push("**例子**");
      out.push(card.example);
      out.push("");
    }
    if (card.quiz) {
      out.push("**自测问题**");
      out.push(card.quiz);
      out.push("");
    }
  });
  if (data.coverageNote) {
    out.push("---");
    out.push("");
    out.push("**覆盖说明**");
    out.push(data.coverageNote);
    out.push("");
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

main().catch((err) => {
  console.error(`校验脚本异常：${err.stack || err.message}`);
  process.exit(1);
});
