#!/usr/bin/env node

/**
 * 纯静态托管（浏览器直连模式）校验。
 *
 * 场景：把 public/ 目录上传到 GitHub Pages / 任意静态托管平台后，
 * 没有任何服务端 —— 前端必须能自动切换为「浏览器直连模式」并正常抽卡。
 *
 * 本脚本在本地完整还原该环境（用 node 起一个纯静态服务器，只托管 public/），
 * 分段校验：
 *   [1] 静态服务器：纯文件托管，无 /api
 *   [2] 同级资源：index.html 及其引用的 6 个文件全部可达（200）
 *   [3] 前端引用全部为相对路径（子目录部署不 404）
 *   [4] core.mjs / extract.mjs 副本与源文件逐字一致
 *   [5] 无服务端探测：./api/health 得到 404 / SPA fallback 得到 HTML，
 *       两种情况都应触发「进入浏览器直连模式」（逻辑等价验证）
 *   [6] 浏览器直连真实抽卡：fetch 静态提示词 → buildSystemPrompt →
 *       generateCards 真实调用模型（消耗额度，约 3-8 秒）
 *   [7] 取消信号：外部 abort 后 core 抛出可读错误
 *
 * 用法：node test-static-check.mjs
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = __dirname;
const PUBLIC_DIR = path.join(APP_DIR, "public");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

let passed = 0;
let failed = 0;

function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  ✓  ${name}`);
  } else {
    failed++;
    console.log(`  ✗  ${name}${detail ? `（${detail}）` : ""}`);
  }
}

/* ---------- 解析 .env（真实抽卡段用，控制台不打印密钥） ---------- */

function readEnv() {
  const file = path.join(APP_DIR, ".env");
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !line.trim().startsWith("#")) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

/* ---------- 起纯静态服务器（模拟 GitHub Pages：只有文件，无任何接口） ---------- */

function startStaticServer(port, spaFallback) {
  const server = http.createServer((req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, "http://x").pathname);
    } catch {
      res.writeHead(400);
      return res.end("bad request");
    }
    let file = path.join(PUBLIC_DIR, pathname === "/" ? "index.html" : pathname);
    if (spaFallback && !fs.existsSync(file)) file = path.join(PUBLIC_DIR, "index.html");
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      return res.end("Not Found");
    }
    res.writeHead(200, {
      "content-type": MIME[path.extname(file)] || "application/octet-stream",
    });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

/* ---------- 前端探测逻辑的等价实现（与 app.js checkHealth 对齐） ---------- */

async function probeServer(baseUrl) {
  // 等价于 app.js：非 JSON 或非 200 都视为「无服务端」→ 进入浏览器直连
  try {
    const res = await fetch(`${baseUrl}/api/health`);
    const ctype = res.headers.get("content-type") || "";
    if (!res.ok || !ctype.includes("application/json")) return "local";
    const health = await res.json();
    if (!health.ok) return "local";
    return "server";
  } catch {
    return "local";
  }
}

/* ---------- 主流程 ---------- */

const STATIC_PORT = 8891;
const SPA_PORT = 8892;
let staticServer = null;
let spaServer = null;

async function main() {
  console.log("纯静态托管（浏览器直连模式）校验\n");

  /* [1] 静态服务器 */
  console.log("[1] 静态服务器（只托管 public/，无任何 /api）");
  staticServer = await startStaticServer(STATIC_PORT, false);
  spaServer = await startStaticServer(SPA_PORT, true);
  const base = `http://127.0.0.1:${STATIC_PORT}`;
  const spaBase = `http://127.0.0.1:${SPA_PORT}`;
  check("静态服务器已启动", true);

  /* [2] 同级资源全部可达 */
  console.log("\n[2] 同级资源（index.html 引用的文件全部 200）");
  const files = [
    "index.html",
    "style.css",
    "app.js",
    "core.mjs",
    "extract.mjs",
    "prompt-skill.md",
    "prompt-output-contract.md",
  ];
  for (const f of files) {
    const res = await fetch(`${base}/${f}`);
    check(`${f} 可访问`, res.status === 200, `实际 ${res.status}`);
  }

  /* [3] 前端引用必须全部相对路径 */
  console.log("\n[3] 前端引用为相对路径（子目录部署不 404）");
  const html = fs.readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf8");
  check(
    "index.html 无绝对路径引用（src=\"/\"、href=\"/\"）",
    !/(src|href)\s*=\s*"\//.test(html),
    "发现绝对路径引用"
  );
  const appjs = fs.readFileSync(path.join(PUBLIC_DIR, "app.js"), "utf8");
  check(
    'app.js 无 fetch("/api/…") 绝对路径',
    !/fetch\(\s*"\/api/.test(appjs),
    "发现绝对 API 路径"
  );
  check(
    'app.js 探测与请求用相对路径 "./api/…"',
    /fetch\("\.\/api\/health"/.test(appjs) && /fetch\("\.\/api\/cards"/.test(appjs)
  );
  check(
    "app.js 以 ES module 加载 core.mjs",
    /import\s*\{[^}]*\}\s*from\s*["']\.\/core\.mjs["']/.test(appjs)
  );
  const htmlScript = html.match(/<script[^>]*src="([^"]+)"[^>]*>/);
  check(
    'index.html 以 type="module" 加载 ./app.js',
    !!htmlScript && htmlScript[1] === "./app.js" && /type="module"/.test(htmlScript[0])
  );
  check(
    "app.js 以相对路径加载 extract.mjs（文件抽取也要能在浏览器里跑）",
    /import\s*\{[^}]*\}\s*from\s*["']\.\/extract\.mjs["']/.test(appjs)
  );

  /* [4] 副本一致性 */
  console.log("\n[4] 副本一致性");
  const coreSrc = fs.readFileSync(path.join(APP_DIR, "core.mjs"), "utf8");
  const coreCopy = fs.readFileSync(path.join(PUBLIC_DIR, "core.mjs"), "utf8");
  check("public/core.mjs 与 app/core.mjs 逐字一致", coreSrc === coreCopy);
  const extractSrc = fs.readFileSync(path.join(APP_DIR, "extract.mjs"), "utf8");
  const extractCopy = fs.readFileSync(path.join(PUBLIC_DIR, "extract.mjs"), "utf8");
  check("public/extract.mjs 与 app/extract.mjs 逐字一致", extractSrc === extractCopy);
  const skillSrc = fs.readFileSync(path.join(APP_DIR, "prompt-skill.md"), "utf8");
  const skillCopy = fs.readFileSync(path.join(PUBLIC_DIR, "prompt-skill.md"), "utf8");
  check("public/prompt-skill.md 与 app/prompt-skill.md 一致", skillSrc === skillCopy);
  const contractSrc = fs.readFileSync(path.join(APP_DIR, "prompt-output-contract.md"), "utf8");
  const contractCopy = fs.readFileSync(path.join(PUBLIC_DIR, "prompt-output-contract.md"), "utf8");
  check("public/prompt-output-contract.md 与源一致", contractSrc === contractCopy);

  /* [5] 探测逻辑：两种静态环境都应进 local 模式 */
  console.log("\n[5] 无服务端时自动切换浏览器直连");
  const mode404 = await probeServer(base);
  check("静态 404（GitHub Pages 无 /api）→ local 模式", mode404 === "local", `实际 ${mode404}`);
  const modeSpa = await probeServer(spaBase);
  check("SPA fallback（200 + HTML）→ local 模式", modeSpa === "local", `实际 ${modeSpa}`);

  /* [6] 浏览器直连真实抽卡（复刻 app.js generateLocal 全链路） */
  console.log("\n[6] 浏览器直连真实抽卡（复刻 generateLocal 链路）");
  const env = readEnv();
  if (!env.LLM_API_KEY) {
    console.log("  跳过  未在 .env 配置 LLM_API_KEY");
  } else {
    const started = Date.now();
    try {
      const { buildSystemPrompt, generateCards } = await import(
        pathToFileURL(path.join(PUBLIC_DIR, "core.mjs")).href
      );
      const [skillRes, contractRes] = await Promise.all([
        fetch(`${base}/prompt-skill.md`),
        fetch(`${base}/prompt-output-contract.md`),
      ]);
      check("静态提示词可加载（浏览器将 fetch 的两个文件）", skillRes.ok && contractRes.ok);
      const systemPrompt = buildSystemPrompt(await skillRes.text(), await contractRes.text());
      check(
        `system prompt 拼装成功（${systemPrompt.length} 字符，应与自托管一致）`,
        systemPrompt.length > 8000
      );

      const article = `深度工作是指在无干扰状态下专注进行职业活动，使个人认知能力达到极限。
与之相对的是浮浅工作，指对认知要求不高的事务性任务。
判断一项工作是否属于浮浅，可以看它能否被快速复制，以及是否容易被替代。
深度工作的价值来自两方面：一是能快速学习复杂技能，二是在高价值产出上形成稀缺性。
进入深度状态需要刻意练习，专注力像肌肉一样可以锻炼。
注意力残留是指任务切换后，前一项任务的思维痕迹残留，削弱后续专注度。`;

      const { data, attempts } = await generateCards(
        {
          baseUrl: env.LLM_BASE_URL || "https://api.deepseek.com/v1",
          apiKey: env.LLM_API_KEY,
          model: env.LLM_MODEL || "deepseek-chat",
          timeoutMs: 120000,
          jsonMode: env.LLM_JSON_MODE !== "0",
        },
        systemPrompt,
        article,
        { maxAttempts: 3 }
      );
      check(
        `真实抽卡成功：${data.cards.length} 张 / ${((Date.now() - started) / 1000).toFixed(1)}s / 尝试 ${attempts} 次`,
        data.cards.length >= 1 && data.cards.length <= 8
      );
      check(
        "卡片字段完整（四段结构）",
        data.cards.every((c) => c.title && c.core && c.explain && (c.example || c.quiz))
      );
    } catch (err) {
      check(`真实抽卡失败：${err.message}`, false);
    }
  }

  /* [7] 取消信号 */
  console.log("\n[7] 外部取消（浏览器「取消」按钮的链路）");
  try {
    const { buildSystemPrompt, generateCards } = await import(
      pathToFileURL(path.join(PUBLIC_DIR, "core.mjs")).href
    );
    const controller = new AbortController();
    const p = generateCards(
      {
        baseUrl: "https://api.deepseek.com/v1",
        apiKey: "sk-dummy",
        model: "deepseek-chat",
        timeoutMs: 30000,
        signal: controller.signal,
      },
      "system",
      "article text for abort test",
      { maxAttempts: 3 }
    );
    setTimeout(() => controller.abort(), 80);
    await p;
    check("外部取消应抛出错误", false, "未抛出");
  } catch (err) {
    check(
      `外部取消抛出可读错误（${err.message}）`,
      /已取消/.test(err.message) || err.name === "AbortError"
    );
  }

  console.log(`\n结果：通过 ${passed} 项，失败 ${failed} 项`);
  staticServer.close();
  spaServer.close();
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error("脚本异常：", err);
  if (staticServer) staticServer.close();
  if (spaServer) spaServer.close();
  process.exit(1);
});
