/**
 * Netlify Functions 入口 —— /api/cards 与 /api/health
 *
 * 抽卡逻辑完全复用 core.mjs（与自托管版 server.js 同一份），
 * 提示词来自 prompt-bundle.mjs（由 sync-prompt.mjs 从 SKILL.md 生成）。
 *
 * 密钥安全：LLM_API_KEY 只存在于 Netlify 后台的环境变量里，
 * 浏览器拿不到，也不会出现在前端代码或构建产物中。
 *
 * 路由映射见 netlify.toml：
 *   /api/*  →  /.netlify/functions/api/*
 *
 * ⚠️ 平台限制：Netlify Functions 免费版执行上限 10 秒、Pro 版 26 秒。
 * 大模型抽卡通常 3-8 秒，但长文章可能更久。这里给重试逻辑设了时间预算，
 * 预算耗尽就停止重试并返回可读错误，而不是撞平台超时变成难懂的 502。
 * 若需要处理超长文章或大流量，更推荐自托管版本（server.js，无此限制）。
 */

import { buildSystemPrompt, generateCards, normalizeResult, demoResult } from "../../core.mjs";
import { SKILL, OUTPUT_CONTRACT } from "../../prompt-bundle.mjs";

/* ---------- 配置（全部来自环境变量） ---------- */

const config = {
  baseUrl: (process.env.LLM_BASE_URL || "https://api.deepseek.com/v1").replace(/\/+$/, ""),
  apiKey: process.env.LLM_API_KEY || "",
  model: process.env.LLM_MODEL || "deepseek-chat",
  appToken: process.env.APP_TOKEN || "",
  maxInputChars: Number(process.env.MAX_INPUT_CHARS || 60000),
  jsonMode: process.env.LLM_JSON_MODE === "1",
  dryRun: process.env.DRY_RUN === "1",
  timeoutMs: Number(process.env.LLM_TIMEOUT_MS || 8000),
};

// 给「全部尝试」留的总时间预算，必须小于平台超时，留出开销余量
const ATTEMPT_BUDGET_MS = Number(process.env.ATTEMPT_BUDGET_MS || 8000);

// 拼装一次并缓存（函数实例复用时不必重复拼）
const systemPrompt = buildSystemPrompt(SKILL, OUTPUT_CONTRACT);

/* ---------- 工具 ---------- */

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

function json(statusCode, payload) {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(payload) };
}

function authorized(event) {
  if (!config.appToken) return true;
  const header =
    event.headers?.authorization || event.headers?.Authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  return token === config.appToken;
}

/** Netlify 的 event.body 可能是 base64（isBase64Encoded） */
function readBody(event) {
  const raw = event.body || "";
  return event.isBase64Encoded ? Buffer.from(raw, "base64").toString("utf8") : raw;
}

/* ---------- 处理函数 ---------- */

async function handleHealth() {
  return json(200, {
    ok: true,
    mode: config.dryRun ? "dry-run" : config.apiKey ? "live" : "unconfigured",
    model: config.apiKey ? config.model : null,
    baseUrl: config.baseUrl,
    promptChars: systemPrompt.length,
    maxInputChars: config.maxInputChars,
    tokenRequired: Boolean(config.appToken),
    platform: "netlify-functions",
  });
}

async function handleCards(event) {
  if (!authorized(event)) {
    return json(401, { ok: false, error: "访问口令不正确。" });
  }

  let payload;
  try {
    payload = JSON.parse(readBody(event) || "{}");
  } catch (err) {
    return json(400, { ok: false, error: `请求体解析失败：${err.message}` });
  }

  const text =
    payload.text === null || payload.text === undefined ? "" : String(payload.text).trim();
  if (!text) {
    return json(400, { ok: false, error: "文章内容为空，请先粘贴或上传。" });
  }
  if (text.length > config.maxInputChars) {
    return json(413, {
      ok: false,
      error: `文章过长（${text.length} 字），上限为 ${config.maxInputChars} 字。请分段处理。`,
    });
  }

  const started = Date.now();

  if (config.dryRun) {
    return json(200, {
      ok: true,
      data: demoResult(text),
      meta: { mode: "dry-run", elapsedMs: Date.now() - started, model: null },
    });
  }

  if (!config.apiKey) {
    return json(500, {
      ok: false,
      error:
        "服务端未配置 LLM_API_KEY。请在 Netlify 后台 Site configuration → " +
        "Environment variables 中添加后重新部署。",
    });
  }

  try {
    const { data, attempts } = await generateCards(config, systemPrompt, text, {
      maxAttempts: 3,
      budgetMs: ATTEMPT_BUDGET_MS,
    });
    return json(200, {
      ok: true,
      data,
      meta: {
        mode: "live",
        model: config.model,
        elapsedMs: Date.now() - started,
        inputChars: text.length,
        attempts,
        platform: "netlify-functions",
      },
    });
  } catch (err) {
    console.error("抽卡失败:", err.message);

    // 超时类错误单独给出针对性提示：Netlify 免费版执行上限 10 秒
    const isTimeout = /超时|timeout|abort/i.test(err.message);
    const hint = isTimeout
      ? "\n\n原因：文章较长导致模型响应超过了部署平台的单次执行时限。\n" +
        "建议：把文章分成几段分别生成，或改用自托管部署（无此限制）。"
      : "";

    return json(isTimeout ? 504 : 502, {
      ok: false,
      error: `${err.message}${hint}\n可直接再点一次「生成知识卡片」重试。`,
    });
  }
}

/* ---------- 入口 ---------- */

export async function handler(event) {
  // /api/health 与 /api/cards 都映射到本函数，用 path 分流
  const pathname = event.path || "/";

  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "content-type, authorization",
        "access-control-allow-methods": "GET, POST, OPTIONS",
      },
      body: "",
    };
  }

  if (pathname.endsWith("/health")) {
    if (event.httpMethod !== "GET" && event.httpMethod !== "HEAD") {
      return json(405, { ok: false, error: "该接口只接受 GET。" });
    }
    return handleHealth();
  }

  if (pathname.endsWith("/cards")) {
    if (event.httpMethod !== "POST") {
      return json(405, { ok: false, error: "该接口只接受 POST。" });
    }
    return handleCards(event);
  }

  return json(404, { ok: false, error: "接口不存在。" });
}
