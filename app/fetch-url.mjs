/**
 * 网页抓取 —— 服务端专用（自托管 server.js 与 Netlify Functions 共用）
 *
 * 为什么不放浏览器端：浏览器直连抓网页会被跨域策略（CORS）拦下，
 * 除非目标站点显式放行。所以「粘贴链接 → 取正文」这件事只能由服务端代做；
 * 纯静态托管（无服务端）模式下这个功能不可用，前端会明确提示。
 *
 * 零依赖：只用 Node 内置的 fetch / DNS / TextDecoder。
 *
 * 安全：抓取任意 URL 天然有 SSRF 风险（攻击者让服务器去访问内网或云服务元数据），
 * 因此做了三层防护：只允许 http/https、逐跳解析 DNS 并拦截内网地址、
 * 手动跟随重定向（每跳都重新校验），避免「公网地址重定向到 169.254.169.254」。
 */

import dns from "node:dns/promises";

export const FETCH_DEFAULTS = {
  timeoutMs: 15000,
  maxBytes: 2 * 1024 * 1024,
  maxChars: 60000,
  maxRedirects: 3,
  allowPrivate: false,
  userAgent:
    "Mozilla/5.0 (compatible; article-to-knowledge-cards/0.2; +https://github.com/px-pangu/article-to-knowledge-cards)",
};

/* ---------- URL 校验 ---------- */

/** 把用户输入补成合法 URL；不合法就抛中文错误 */
export function normalizeUrl(input) {
  const raw = String(input || "").trim();
  if (!raw) throw new Error("请先填写网页链接。");
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch (err) {
    throw new Error("这不是一个有效的链接。请填写形如 https://example.com/post 的地址。");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`只支持 http / https 链接，当前是 ${url.protocol}`);
  }
  return url;
}

/* ---------- 内网地址拦截 ---------- */

function ipv4Blocked(ip) {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  if (a === 0 || a === 127 || a === 255) return true;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 192 && b === 0) return true; // 192.0.0.0/24、192.0.2.0/24 等保留段
  if (a === 198 && (b === 18 || b === 19 || b === 51)) return true;
  if (a === 203 && b === 0) return true;
  if (a >= 224) return true; // 组播与保留
  return false;
}

function ipv6Blocked(ip) {
  const v = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (v === "::" || v === "::1") return true;
  if (v.startsWith("fc") || v.startsWith("fd")) return true; // 唯一本地地址 fc00::/7
  if (/^fe[89ab]/.test(v)) return true; // 链路本地 fe80::/10
  const mapped = /:((?:\d{1,3}\.){3}\d{1,3})$/.exec(v); // ::ffff:127.0.0.1
  if (mapped) return ipv4Blocked(mapped[1]);
  return false;
}

export function isBlockedAddress(ip) {
  return String(ip).includes(":") ? ipv6Blocked(ip) : ipv4Blocked(ip);
}

/** 解析域名并检查所有解析结果；命中内网地址就拒绝 */
export async function assertPublicHost(hostname) {
  const literal = hostname.replace(/^\[|\]$/g, "");
  const isLiteralIp = /^(\d{1,3}\.){3}\d{1,3}$/.test(literal) || literal.includes(":");
  if (isLiteralIp) {
    if (isBlockedAddress(literal)) {
      throw new Error("拒绝抓取内网或保留地址。");
    }
    return;
  }
  let records;
  try {
    records = await dns.lookup(hostname, { all: true });
  } catch (err) {
    throw new Error(`域名无法解析：${hostname}`);
  }
  for (const record of records) {
    if (isBlockedAddress(record.address)) {
      throw new Error("拒绝抓取解析到内网地址的域名。");
    }
  }
}

/* ---------- HTML → 正文 ---------- */

function decodeEntities(input) {
  return String(input || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeChar(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeChar(parseInt(dec, 10)));
}

function safeChar(code) {
  return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
}

function tidy(input) {
  return String(input || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 取 <title>，取不到返回空串 */
export function htmlTitle(html) {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html || ""));
  return match ? tidy(decodeEntities(match[1].replace(/<[^>]+>/g, ""))) : "";
}

/**
 * 把 HTML 变成可读正文。
 * 策略：优先取最长的 <article> / <main> 区块（多数站点的正文容器），
 * 取不到再用整个 body；然后整段剥掉脚本、样式、导航、页脚等噪声与全部标签。
 */
export function htmlToText(html) {
  let s = String(html || "");

  // 1) 优先锁定正文容器
  let region = "";
  for (const tag of ["article", "main"]) {
    const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}\\s*>`, "gi");
    let m;
    while ((m = re.exec(s))) {
      if (m[1].length > region.length) region = m[1];
    }
  }
  // 太短说明只是个摘要卡片，不如用整页
  if (region.replace(/<[^>]+>/g, "").length >= 400) s = region;

  // 2) 整块移除噪声元素
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(
    /<(script|style|noscript|svg|iframe|template|nav|header|footer|aside|form|button|select)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
    " "
  );

  // 3) 块级元素换成换行，列表项加个短横
  s = s.replace(/<(br|hr)\b[^>]*\/?>/gi, "\n");
  s = s.replace(/<li\b[^>]*>/gi, "\n- ");
  s = s.replace(
    /<\/(p|div|section|article|h[1-6]|li|tr|blockquote|pre|figcaption|table)\s*>/gi,
    "\n"
  );
  s = s.replace(/<\/(td|th)\s*>/gi, " | ");

  // 4) 剥掉剩余标签并还原实体
  s = s.replace(/<[^>]+>/g, "");
  s = decodeEntities(s);

  return tidy(s);
}

/* ---------- 抓取主流程 ---------- */

function charsetOf(contentType) {
  const match = /charset=["']?([a-z0-9_-]+)/i.exec(String(contentType || ""));
  if (!match) return "utf-8";
  try {
    new TextDecoder(match[1]);
    return match[1];
  } catch (err) {
    return "utf-8";
  }
}

function decodeBody(bytes, charset) {
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch (err) {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/**
 * 抓取网页正文。
 * @param {string} input 用户填的链接
 * @param {Partial<typeof FETCH_DEFAULTS>} [opts]
 * @returns {Promise<{url:string, title:string, text:string, chars:number, truncated:boolean}>}
 */
export async function fetchUrlText(input, opts = {}) {
  const cfg = { ...FETCH_DEFAULTS, ...opts };
  const deadline = Date.now() + cfg.timeoutMs;

  let url = normalizeUrl(input);
  let res = null;

  for (let hop = 0; hop <= cfg.maxRedirects; hop++) {
    if (!cfg.allowPrivate) await assertPublicHost(url.hostname);

    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("抓取超时。");

    res = await fetch(url.href, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(remaining),
      headers: {
        "user-agent": cfg.userAgent,
        accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
    });

    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      url = new URL(location, url.href);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("重定向到了非 http(s) 地址，已中止。");
      }
      continue;
    }
    break;
  }

  if (!res) throw new Error("抓取超时。");
  if (!res.ok) throw new Error(`网页返回 ${res.status}${res.statusText ? ` ${res.statusText}` : ""}。`);

  const contentType = res.headers.get("content-type") || "";
  if (contentType && !/^(text\/|application\/(xhtml|xml|json))/i.test(contentType)) {
    throw new Error(
      `这个链接指向的是 ${contentType.split(";")[0]}，不是网页或纯文本。请直接把内容粘贴进来。`
    );
  }

  // 边读边限流，避免一个巨大页面把内存吃掉
  const reader = res.body ? res.body.getReader() : null;
  if (!reader) throw new Error("网页没有返回可读内容。");

  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cfg.maxBytes) {
      chunks.push(value.subarray(0, Math.max(0, value.byteLength - (total - cfg.maxBytes))));
      break;
    }
    chunks.push(value);
  }

  const merged = new Uint8Array(Math.min(total, cfg.maxBytes));
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk.subarray(0, Math.min(chunk.byteLength, merged.byteLength - offset)), offset);
    offset += chunk.byteLength;
    if (offset >= merged.byteLength) break;
  }

  const raw = decodeBody(merged, charsetOf(contentType));
  const isHtml = /<[a-z!/]/i.test(raw.slice(0, 2000)) || /html/i.test(contentType);
  const title = isHtml ? htmlTitle(raw) : "";
  const text = tidy(isHtml ? htmlToText(raw) : raw);

  if (!text || text.length < 50) {
    throw new Error(
      "这个页面没有抓到可用的正文。常见原因：内容由脚本动态渲染、" +
        "需要登录，或页面本身是空壳。请手动复制正文粘贴。"
    );
  }

  const truncated = text.length > cfg.maxChars;
  return {
    url: url.href,
    title,
    text: truncated ? text.slice(0, cfg.maxChars) : text,
    chars: Math.min(text.length, cfg.maxChars),
    truncated,
  };
}
