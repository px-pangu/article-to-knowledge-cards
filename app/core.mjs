/**
 * 抽卡核心逻辑 —— 与运行环境无关的纯模块。
 *
 * 被两处复用，保证「同一份逻辑」：
 *   1) server.js            —— 自托管单端口服务（node server.js）
 *   2) netlify/functions/api.mjs —— Netlify Functions 无服务器部署
 *
 * 本模块不碰 HTTP、不读文件系统（提示词由调用方传入），只做：
 *   提示词拼装 → 调用模型 → 解析 JSON → 结构校验
 *
 * 注意：抽卡的「规则」不在这里，而在 prompt-skill.md（由 SKILL.md 同步而来）。
 * 本文件只负责「把规则送进去、把结果校验出来」，不含任何抽卡判断逻辑。
 */

/* ---------- 提示词 ---------- */

/**
 * 拼装 system prompt：SKILL.md 的正文 + JSON 输出契约。
 * @param {string} skillText    prompt-skill.md 的内容（已剥离 frontmatter）
 * @param {string} contractText prompt-output-contract.md 的内容
 */
export function buildSystemPrompt(skillText, contractText) {
  const skill = String(skillText || "").trim();
  const contract = String(contractText || "").trim();
  if (!skill) throw new Error("缺少抽卡规则（prompt-skill.md 为空）。");
  if (!contract) throw new Error("缺少输出契约（prompt-output-contract.md 为空）。");
  return `${skill}\n\n---\n\n${contract}\n`;
}

/* ---------- JSON 解析与修复 ---------- */

export function extractJson(raw) {
  let text = String(raw || "").trim();
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("模型未返回可解析的 JSON 对象。");
  }
  const slice = text.slice(start, end + 1);

  // 先按原样解析
  try {
    return JSON.parse(slice);
  } catch (firstError) {
    // 模型偶发输出不合法 JSON，常见两类可安全修复：
    //   1) 字符串里出现未转义的换行符
    //   2) 尾随逗号（{"a":1,} 或 [1,2,]）
    const repaired = repairJson(slice);
    try {
      return JSON.parse(repaired);
    } catch {
      throw new Error(
        `模型返回的 JSON 无法解析：${firstError.message}（已尝试自动修复仍失败，可重试一次）`
      );
    }
  }
}

/**
 * 修复模型常见的 JSON 语法错误。只做安全的局部修补，不改变数据内容。
 *
 * 处理三类问题：
 *   1) 字符串内部出现裸换行/制表符 → 转成 \n \t
 *   2) 尾随逗号（{"a":1,} 或 [1,2,]）
 *   3) 中文文本里误用英文直引号作引号（最常见）→ 让解析器把它当普通字符
 *
 * 第 3 类的判定依据：在 JSON 里，一个字符串要么以 `",` `"}` `"]` 结尾，
 * 要么后面跟的是结构性字符。若某个 `"` 后面紧跟中文字符或标点，
 * 它几乎不可能是字符串边界，而是正文里的引号——转义它即可。
 */
export function repairJson(text) {
  let out = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      out += ch;
      escaped = true;
      continue;
    }

    if (ch === '"') {
      if (inString) {
        // 判断这个引号是「字符串结尾」还是「正文里的引号」
        let j = i + 1;
        while (j < text.length && /\s/.test(text[j])) j++;
        const next = text[j];
        // 结尾后面应当跟 , : } ] 或字符串结束
        const isTerminator =
          next === undefined || next === "," || next === "}" || next === "]" || next === ":";
        if (isTerminator) {
          inString = false;
          out += ch;
        } else {
          out += '\\"';
        }
      } else {
        inString = true;
        out += ch;
      }
      continue;
    }

    // 字符串内部的裸换行 / 制表符必须转义，否则 JSON 非法
    if (inString && (ch === "\n" || ch === "\r" || ch === "\t")) {
      out += ch === "\t" ? "\\t" : "\\n";
      continue;
    }

    out += ch;
  }

  // 去掉尾随逗号：{"a":1,} → {"a":1}
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/* ---------- 结构校验 ---------- */

export function asText(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

export function normalizeResult(raw) {
  const data = extractJson(raw);
  const list = Array.isArray(data.cards) ? data.cards : null;
  if (!list || list.length === 0) {
    throw new Error("模型返回的数据中没有 cards 数组。");
  }

  const cards = [];
  list.forEach((item, index) => {
    const no = index + 1;
    const title = asText(item.title || item.标题);
    const core = asText(item.core || item.核心知识);
    const explain = asText(item.explain || item.简明解释);
    const example = asText(item.example || item.例子);
    const quiz = asText(item.quiz || item.自测问题);
    if (!title) throw new Error(`第 ${no} 张卡片缺少 title。`);
    if (!core) throw new Error(`第 ${no} 张卡片缺少 core。`);
    if (!explain) throw new Error(`第 ${no} 张卡片缺少 explain。`);
    if (!example && !quiz) {
      throw new Error(`第 ${no} 张卡片缺少 example 与 quiz，二者至少需要一个。`);
    }
    const card = { no, title, core, explain };
    if (example) card.example = example;
    if (quiz) card.quiz = quiz;
    cards.push(card);
  });

  return {
    title: asText(data.title || data.文章主题) || "知识卡片",
    genre: asText(data.genre || data.体裁),
    notice: asText(data.notice),
    coverageNote: asText(data.coverage_note || data.覆盖说明),
    insufficient: data.insufficient === true,
    cards,
  };
}

/* ---------- 模型调用 ---------- */

/**
 * 调用 OpenAI 兼容接口。
 * @param {object} cfg   { baseUrl, apiKey, model, timeoutMs, jsonMode }
 * @param {string} systemPrompt
 * @param {string} userText
 * @param {number} temperature
 */
export async function callModel(cfg, systemPrompt, userText, temperature) {
  const body = {
    model: cfg.model,
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: `请把下面这篇文章转成知识卡片。\n\n<<<文章开始>>>\n${userText}\n<<<文章结束>>>`,
      },
    ],
    temperature: temperature === undefined ? 0.2 : temperature,
    stream: false,
  };
  if (cfg.jsonMode) body.response_format = { type: "json_object" };

  const controller = new AbortController();
  const timeoutMs = cfg.timeoutMs || 180000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") {
      throw new Error(`调用模型超时（超过 ${Math.round(timeoutMs / 1000)} 秒）。`);
    }
    throw new Error(`无法连接模型接口：${err.message}`);
  }
  clearTimeout(timer);

  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text);
      detail = parsed.error?.message || parsed.message || detail;
    } catch {
      /* 保持原文 */
    }
    throw new Error(`模型接口返回 ${res.status}：${detail}`);
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error("模型接口返回的不是 JSON。");
  }
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new Error("模型接口未返回内容。");
  return content;
}

/**
 * 完整抽卡：调用模型 + 校验结果，失败时自动重试。
 *
 * 重试策略：温度 0.2 → 0.35 → 0.5 递增，用于跳出相同的错误模式。
 * 只在「可重试」错误上重试（JSON 解析失败、结构缺失），
 * 401/402 这类配置错误立即抛出。
 *
 * 时间预算（budgetMs）：Netlify Functions 免费版只有 10 秒执行上限，
 * 若首次调用已耗时较久，重试很可能撞上平台超时并返回难懂的 502。
 * 因此这里会检查剩余预算，不够就不再重试，改为抛出「原文可读」的错误，
 * 让用户看到「请再点一次」而不是莫名其妙的超时。
 *
 * @param {object} cfg       模型配置
 * @param {string} systemPrompt
 * @param {string} userText
 * @param {object} opts      { maxAttempts, budgetMs, onAttempt }
 * @returns {{ data: object, attempts: number }}
 */
export async function generateCards(cfg, systemPrompt, userText, opts = {}) {
  const maxAttempts = opts.maxAttempts || 3;
  const budgetMs = opts.budgetMs || 0; // 0 = 不限制（自托管场景）
  const onAttempt = opts.onAttempt || (() => {});
  const started = Date.now();

  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // 预算不足则放弃重试，直接抛出上一次的真实错误
    if (attempt > 1 && budgetMs > 0) {
      const spent = Date.now() - started;
      if (spent > budgetMs) {
        break;
      }
      // 把单次调用的超时限制在剩余预算内，避免这次必然失败还白等
      cfg = { ...cfg, timeoutMs: Math.min(cfg.timeoutMs || 120000, budgetMs - spent) };
    }

    const temperature = attempt === 1 ? 0.2 : attempt === 2 ? 0.35 : 0.5;
    try {
      onAttempt(attempt, temperature);
      const content = await callModel(cfg, systemPrompt, userText, temperature);
      return { data: normalizeResult(content), attempts: attempt };
    } catch (err) {
      lastError = err;
      // 配置类错误不重试，重试也不会变好
      const retriable = /JSON|无法解析|没有 cards|缺少/.test(err.message);
      if (!retriable || attempt === maxAttempts) break;
      await new Promise((r) => setTimeout(r, 400 * attempt));
    }
  }
  throw lastError;
}

/* ---------- 演示数据（DRY_RUN=1 时使用，不调用模型） ---------- */

export function demoResult(userText) {
  return {
    title: "演示模式输出",
    genre: "说明文",
    notice:
      "当前为演示模式（DRY_RUN=1），卡片为固定示例，未调用大模型。" +
      `本次收到的文章长度：${userText.length} 字。`,
    coverageNote: "演示模式下未做真实取舍判断。",
    insufficient: false,
    cards: [
      {
        no: 1,
        title: "服务已连通",
        core: "前端到服务端再到响应解析的整条链路是通的。",
        explain:
          "这条演示卡片证明：请求已正确送达服务端，服务端也成功返回了符合契约的结构化数据，前端能正常渲染。",
        example: "在 .env 中填入 LLM_API_KEY 后重启服务，即可看到真实抽卡结果。",
      },
      {
        no: 2,
        title: "卡片依赖模型",
        core: "真实卡片由大模型按 SKILL.md 的规则生成，服务本身不含抽卡逻辑。",
        explain:
          "服务只负责三件事：托管页面、把 SKILL.md 注入为 system prompt、校验模型返回的数据结构。规则改动只需改 SKILL.md。",
        quiz: "如果要把「卡片数量上限」从 8 张改成 5 张，应该改哪个文件？",
      },
      {
        no: 3,
        title: "数据不出内网",
        core: "文章内容只发送到你自己配置的模型接口地址。",
        explain:
          "服务不写数据库、不落盘、不做日志留存，请求结束即释放。模型接口地址由 LLM_BASE_URL 决定，可以是公网服务，也可以是本地 Ollama。",
        example: "LLM_BASE_URL=http://127.0.0.1:11434/v1 即可接本地模型。",
      },
    ],
  };
}
