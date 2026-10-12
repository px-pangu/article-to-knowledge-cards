#!/usr/bin/env node
"use strict";

/**
 * 文章转知识卡片 —— 单端口服务（自托管版）
 *
 * 零依赖：只用 Node 内置模块。前端静态文件与 API 由同一个端口提供。
 * 大模型按 OpenAI 兼容协议调用（/chat/completions），因此 DeepSeek、
 * 通义千问 compatible-mode、Kimi、智谱、OpenAI、Ollama 等均可直接接入。
 *
 * 抽卡核心逻辑在 core.mjs（与 Netlify Functions 版本共用，确保规则只有一份）。
 * 本文件只负责：读配置、托管静态文件、处理 HTTP 路由。
 */

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");

/* ---------- 极简 .env 加载（不覆盖已存在的环境变量） ---------- */

function loadDotEnv() {
  const file = path.join(ROOT, ".env");
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv();

/* ---------- 配置 ---------- */

const config = {
  port: Number(process.env.PORT || 8787),
  host: process.env.HOST || "0.0.0.0",
  baseUrl: (process.env.LLM_BASE_URL || "https://api.deepseek.com/v1").replace(/\/+$/, ""),
  apiKey: process.env.LLM_API_KEY || "",
  model: process.env.LLM_MODEL || "deepseek-chat",
  appToken: process.env.APP_TOKEN || "",
  maxInputChars: Number(process.env.MAX_INPUT_CHARS || 60000),
  maxBodyBytes: Number(process.env.MAX_BODY_BYTES || 1048576),
  timeoutMs: Number(process.env.LLM_TIMEOUT_MS || 180000),
  jsonMode: process.env.LLM_JSON_MODE === "1",
  dryRun: process.env.DRY_RUN === "1",
};

/* ---------- 抽卡核心逻辑 ----------
 * 真正的实现在 core.mjs —— 与 Netlify Functions 版、浏览器直连版共用同一份，
 * 确保「抽卡规则只有一份真源」这一约定在三种部署方式下都成立。
 * 本文件只负责把文件读进来、把配置传进去。
 */

let corePromise = null;
function loadCore() {
  if (!corePromise) {
    corePromise = import(pathToFileURL(path.join(ROOT, "core.mjs")).href);
  }
  return corePromise;
}

const promptFiles = {
  skill: path.join(ROOT, "prompt-skill.md"),
  contract: path.join(ROOT, "prompt-output-contract.md"),
};

function buildSystemPrompt() {
  for (const [name, file] of Object.entries(promptFiles)) {
    if (!fs.existsSync(file)) {
      throw new Error(
        `缺少提示词文件 ${path.basename(file)}（${name}）。` +
          `请先运行：node sync-prompt.mjs`
      );
    }
  }
  const skill = fs.readFileSync(promptFiles.skill, "utf8");
  const contract = fs.readFileSync(promptFiles.contract, "utf8");
  return { skill, contract };
}

// 提示词在启动时同步读入（读文件是同步的，无需 await）；
// core.mjs 是 ESM，在收到第一个抽卡请求时异步加载一次并缓存。
let systemPrompt = "";
try {
  const { skill, contract } = buildSystemPrompt();
  // 这里只做「文件存在性 + 非空」的快速校验，真正的拼装在首次请求时进行
  if (!String(skill).trim()) throw new Error("prompt-skill.md 内容为空。");
  if (!String(contract).trim()) throw new Error("prompt-output-contract.md 内容为空。");
  systemPrompt = `${String(skill).trim()}\n\n---\n\n${String(contract).trim()}\n`;
} catch (err) {
  console.error(`[启动失败] ${err.message}`);
  process.exit(1);
}


/* ---------- HTTP 工具 ---------- */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > config.maxBodyBytes) {
        reject(new Error("请求体过大。"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function serveStatic(req, res, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    sendJson(res, 400, { ok: false, error: "非法路径。" });
    return;
  }

  // 必须先解码、再看是否有 NUL 与路径穿越，最后才拼路径。
  // 反斜杠也当分隔符处理：Windows 上 "\..\..\x" 同样是穿越。
  if (decoded.includes("\0") || /(^|[\\/])\.\.([\\/]|$)/.test(decoded)) {
    sendJson(res, 403, { ok: false, error: "非法路径。" });
    return;
  }

  const relative = decoded === "/" ? "index.html" : decoded.replace(/^[/\\]+/, "");
  const target = path.resolve(PUBLIC_DIR, relative);

  // resolve 之后再确认一次仍在 public 目录内（双保险：
  // 覆盖 "public-backup" 这类同前缀目录、以及符号链接之外的漏网情况）
  const root = PUBLIC_DIR + path.sep;
  if (target !== PUBLIC_DIR && !target.startsWith(root)) {
    sendJson(res, 403, { ok: false, error: "非法路径。" });
    return;
  }
  const relToRoot = path.relative(PUBLIC_DIR, target);
  if (relToRoot.startsWith("..") || path.isAbsolute(relToRoot)) {
    sendJson(res, 403, { ok: false, error: "非法路径。" });
    return;
  }

  fs.stat(target, (err, stat) => {
    if (err || !stat.isFile()) {
      sendJson(res, 404, { ok: false, error: "页面不存在。" });
      return;
    }
    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, {
      "content-type": MIME[ext] || "application/octet-stream",
      "content-length": stat.size,
      "cache-control": ext === ".html" ? "no-cache" : "public, max-age=300",
    });
    fs.createReadStream(target).pipe(res);
  });
}

function authorized(req) {
  if (!config.appToken) return true;
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  return token === config.appToken;
}

/* ---------- 路由 ---------- */

async function handleCards(req, res) {
  if (!authorized(req)) {
    sendJson(res, 401, { ok: false, error: "访问口令不正确。" });
    return;
  }

  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch (err) {
    sendJson(res, 400, { ok: false, error: `请求体解析失败：${err.message}` });
    return;
  }

  const text = payload.text === null || payload.text === undefined ? "" : String(payload.text).trim();
  if (!text) {
    sendJson(res, 400, { ok: false, error: "文章内容为空，请先粘贴或上传。" });
    return;
  }
  if (text.length > config.maxInputChars) {
    sendJson(res, 413, {
      ok: false,
      error: `文章过长（${text.length} 字），上限为 ${config.maxInputChars} 字。请分段处理。`,
    });
    return;
  }

  const started = Date.now();
  try {
    const mod = await loadCore();

    if (config.dryRun) {
      sendJson(res, 200, {
        ok: true,
        data: mod.demoResult(text),
        meta: { mode: "dry-run", elapsedMs: Date.now() - started, model: null },
      });
      return;
    }
    if (!config.apiKey) {
      sendJson(res, 500, {
        ok: false,
        error: "服务端未配置 LLM_API_KEY，无法调用模型。请在 .env 中填写后重启。",
      });
      return;
    }

    const { data, attempts } = await mod.generateCards(config, systemPrompt, text, {
      maxAttempts: 3,
      onAttempt: (attempt) => {
        if (attempt > 1) console.warn(`[抽卡重试] 第 ${attempt} 次尝试…`);
      },
    });

    sendJson(res, 200, {
      ok: true,
      data,
      meta: {
        mode: "live",
        model: config.model,
        elapsedMs: Date.now() - started,
        inputChars: text.length,
        attempts,
      },
    });
  } catch (err) {
    console.error(`[抽卡失败] ${err.stack || err.message}`);
    sendJson(res, 502, {
      ok: false,
      error:
        `${err.message}` +
        "\n可直接再点一次「生成知识卡片」重试。",
    });
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  if (pathname === "/api/health" && req.method === "GET") {
    sendJson(res, 200, {
      ok: true,
      mode: config.dryRun ? "dry-run" : "live",
      model: config.dryRun ? null : config.model,
      baseUrl: config.dryRun ? null : config.baseUrl,
      promptChars: systemPrompt.length,
      maxInputChars: config.maxInputChars,
      tokenRequired: Boolean(config.appToken),
      uptimeSec: Math.round(process.uptime()),
    });
    return;
  }

  if (pathname === "/api/cards" && req.method === "POST") {
    handleCards(req, res).catch((err) => {
      console.error(`[未捕获错误] ${err.stack || err.message}`);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: "服务内部错误。" });
    });
    return;
  }

  if (req.method === "GET" || req.method === "HEAD") {
    if (pathname.startsWith("/api/")) {
      sendJson(res, 404, { ok: false, error: "接口不存在。" });
      return;
    }
    serveStatic(req, res, pathname);
    return;
  }

  sendJson(res, 405, { ok: false, error: "不支持的方法。" });
});

/* ---------- 自动打开浏览器 ----------
 * 只有 start.bat 会设置 OPEN_BROWSER=1（双击启动的体验），
 * 直接跑 `node server.js` 或跑测试时不会带这个变量，因此不会弹浏览器。
 * 打开失败只提示、不影响服务本身。
 */
function openBrowser(url) {
  const { spawn } = require("node:child_process");
  const [cmd, args] =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => {});
    child.unref();
    console.log(`  浏览器   : 已打开 ${url}`);
  } catch {
    console.log(`  浏览器   : 未能自动打开，请手动访问 ${url}`);
  }
}

// 监听地址可能是 0.0.0.0（对外），但浏览器要用回环地址
const localUrl = `http://127.0.0.1:${config.port}`;

server.on("error", (err) => {
  if (err && err.code === "EADDRINUSE") {
    // 常见于重复双击快捷方式：服务其实已经在跑了，直接把页面打开即可。
    console.log(`端口 ${config.port} 已被占用 —— 服务已经在运行了，无需重复启动。`);
    if (process.env.OPEN_BROWSER === "1") openBrowser(localUrl);
    process.exit(0);
  }
  console.error(`启动失败：${err && err.message ? err.message : err}`);
  process.exit(1);
});

server.listen(config.port, config.host, () => {
  const mode = config.dryRun ? "演示模式（DRY_RUN=1，不调用模型）" : `实时模式 · ${config.model}`;
  console.log(`文章转知识卡片服务已启动`);
  console.log(`  监听地址 : http://${config.host}:${config.port}`);
  console.log(`  运行模式 : ${mode}`);
  console.log(`  提示词   : ${systemPrompt.length} 字符（SKILL.md + 输出契约）`);
  if (config.appToken) console.log(`  访问口令 : 已启用`);
  if (!config.dryRun && !config.apiKey) {
    console.log(`  [警告] 未配置 LLM_API_KEY，抽卡接口会返回错误。`);
  }
  if (process.env.OPEN_BROWSER === "1") openBrowser(localUrl);
});
