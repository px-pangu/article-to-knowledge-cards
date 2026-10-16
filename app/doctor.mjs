#!/usr/bin/env node

/**
 * 一键诊断：逐环检查服务能否正常工作。
 *
 * 用法：node doctor.mjs
 *
 * 它会按顺序检查「配置 → 规则同步 → 端口 → 服务响应 → 模型连通性」，
 * 并在第一处断裂点给出具体的修复命令。
 */

import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 本脚本平铺在 app/ 根目录下，__dirname 就是 app 目录本身
const APP_DIR = __dirname;

const ok = (m) => console.log(`  \u2713  ${m}`);
const bad = (m) => console.log(`  \u2717  ${m}`);
const warn = (m) => console.log(`  !  ${m}`);
const info = (m) => console.log(`     ${m}`);

let fatal = false;
function fail(message, fix) {
  bad(message);
  if (fix) fix.split("\n").forEach((line) => info(line));
  fatal = true;
}

function readEnv() {
  const file = path.join(APP_DIR, ".env");
  if (!fs.existsSync(file)) return null;
  const env = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    env[t.slice(0, eq).trim()] = v;
  }
  return env;
}

function checkPort(host, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(1500);
    socket.on("connect", () => done(true));
    socket.on("timeout", () => done(false));
    socket.on("error", () => done(false));
  });
}

async function main() {
  console.log("文章转知识卡片 · 环境诊断\n");

  /* 1. Node 版本 */
  console.log("[1] 运行环境");
  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 18) {
    ok(`Node ${process.versions.node}`);
  } else {
    fail(`Node 版本过低（${process.versions.node}），需要 18 或以上`);
  }

  /* 2. .env */
  console.log("\n[2] 配置文件");
  const env = readEnv();
  if (!env) {
    fail("没有 .env 配置文件", "修复：copy .env.example .env");
  } else {
    ok(".env 已存在");
    const baseUrl = env.LLM_BASE_URL || "https://api.deepseek.com/v1";
    const model = env.LLM_MODEL || "deepseek-chat";
    const dryRun = env.DRY_RUN === "1";
    info(`接口地址：${baseUrl}`);
    info(`模型名称：${model}`);
    info(`演示模式：${dryRun ? "开（不调用模型）" : "关"}`);

    if (dryRun) {
      warn("当前是演示模式，不会调用真实模型。改 DRY_RUN=0 才会真正抽卡");
    } else if (!env.LLM_API_KEY) {
      fail("LLM_API_KEY 为空，抽卡时服务会直接报错", "修复：在 .env 中填写 LLM_API_KEY");
    } else {
      const key = env.LLM_API_KEY;
      const masked = key.length > 10 ? `${key.slice(0, 6)}…${key.slice(-4)}` : "(过短)";
      ok(`LLM_API_KEY 已填写（${masked}，长度 ${key.length}）`);
      if (key.length < 20) {
        warn("密钥看起来偏短，请确认没有复制漏字符");
      }
    }
    if (env.APP_TOKEN) {
      ok("已启用访问口令，页面需要输入口令才能抽卡");
    }
    process.env.PORT = env.PORT || process.env.PORT;
    process.env.HOST = env.HOST || process.env.HOST;
  }

  const port = Number(process.env.PORT || 8787);
  const host = process.env.HOST || "127.0.0.1";
  const probeHost = host === "0.0.0.0" ? "127.0.0.1" : host;

  /* 3. 目录结构 */
  console.log("\n[3] 目录结构");
  {
    const publicDir = path.join(APP_DIR, "public");
    const required = [
      ["public/index.html", "首页"],
      ["public/style.css", "样式表"],
      ["public/app.js", "前端脚本"],
      ["server.js", "服务端主程序"],
      ["core.mjs", "抽卡核心逻辑"],
      ["extract.mjs", "文件抽取逻辑（PDF / Word / Excel → 文本）"],
      ["fetch-url.mjs", "网页抓取逻辑"],
      ["prompt-skill.md", "抽卡规则（由 SKILL.md 同步）"],
      ["prompt-output-contract.md", "JSON 输出契约"],
    ];

    const missing = required.filter(([rel]) => !fs.existsSync(path.join(APP_DIR, rel)));
    const frontendInRoot = ["index.html", "style.css", "app.js"].filter((f) =>
      fs.existsSync(path.join(APP_DIR, f))
    );
    const serverInPublic = ["server.js", ".env"].filter((f) =>
      fs.existsSync(path.join(publicDir, f))
    );

    if (frontendInRoot.length) {
      // 典型症状：前端文件被平铺到了 app/ 根，public/ 是空的 → 打开首页得 404
      fail(
        `前端文件位置不对：${frontendInRoot.join("、")} 在 app/ 根目录，应当在 public/ 里`,
        "这会直接导致打开首页得到 404。修复：\n" +
          `mv ${frontendInRoot.join(" ")} public/` +
          "\n（在 app 目录下执行，改完重启服务）"
      );
    } else if (missing.length) {
      fail(
        `缺少文件：${missing.map(([rel]) => rel).join("、")}`,
        "请确认 app 目录是从仓库完整拷贝的\n" +
          "（前端在 public/，其余文件平铺在 app/ 根）"
      );
    } else {
      ok("结构正确：public/ 含前端三件套，其余文件平铺在 app/ 根");
    }

    if (serverInPublic.length) {
      fail(
        `安全风险：${serverInPublic.join("、")} 位于静态托管目录 public/ 内，可被 URL 直接下载`,
        "修复：把它们移到 app/ 根目录（public/ 只放前端资源）"
      );
    }

    // 检出上一版的分层结构残留：若 prompts/ scripts/ tests/ 还在，提醒已改为平铺
    const legacyDirs = ["prompts", "scripts", "tests"].filter((d) =>
      fs.existsSync(path.join(APP_DIR, d))
    );
    if (legacyDirs.length) {
      warn(
        `发现旧版分层目录：${legacyDirs.join("/")}/ —— 当前版本已改为平铺结构，` +
          "这些目录里的文件不会被加载"
      );
    }

    // Netlify 部署相关文件（可选，缺失时只提示）
    const netlifyFn = path.join(APP_DIR, "netlify", "functions", "api.mjs");
    const netlifyToml = path.join(APP_DIR, "..", "netlify.toml");
    if (fs.existsSync(netlifyFn)) {
      if (!fs.existsSync(netlifyToml)) {
        warn(
          "缺少仓库根目录的 netlify.toml —— Netlify 只读根目录那一份，" +
            "缺了会导致 /api/* 全部 404"
        );
      }
      if (!fs.existsSync(path.join(APP_DIR, "prompt-bundle.mjs"))) {
        warn("缺少 prompt-bundle.mjs —— Netlify 版提示词，修复：node sync-prompt.mjs");
      }
    }

    // 纯静态托管（浏览器直连模式）的前端依赖（可选，缺失时只提示）
    // 前端探测不到 /api 时会自动切换为浏览器直连，此时需要这几个文件与 index.html 同级
    const staticDeps = ["core.mjs", "extract.mjs", "prompt-skill.md", "prompt-output-contract.md"].filter(
      (f) => !fs.existsSync(path.join(publicDir, f))
    );
    if (staticDeps.length) {
      warn(
        `public/ 缺少静态托管依赖：${staticDeps.join("、")} —— ` +
          "纯静态部署（GitHub Pages 等）的浏览器直连模式需要它们与 index.html 同级，" +
          "修复：node sync-prompt.mjs（自托管模式不受影响）"
      );
    } else {
      // 副本必须与源文件逐字一致：改了 extract.mjs / core.mjs 却忘了同步，
      // 静态托管模式下会出现「本地能用、线上报错」这种极难排查的问题
      const stale = ["core.mjs", "extract.mjs"].filter((f) => {
        const src = path.join(APP_DIR, f);
        const copy = path.join(publicDir, f);
        if (!fs.existsSync(src) || !fs.existsSync(copy)) return false;
        return !fs.readFileSync(src).equals(fs.readFileSync(copy));
      });
      if (stale.length) {
        warn(
          `public/ 里的 ${stale.join("、")} 与源文件不一致 —— 改过代码后忘了同步，` +
            "修复：node sync-prompt.mjs"
        );
      } else {
        ok("public/ 副本与源文件一致（core.mjs、extract.mjs）");
      }
    }
  }

  /* 4. 规则同步 */
  console.log("\n[4] 抽卡规则");
  const promptFile = path.join(APP_DIR, "prompt-skill.md");
  const contractFile = path.join(APP_DIR, "prompt-output-contract.md");
  if (!fs.existsSync(contractFile)) {
    fail("缺少 prompt-output-contract.md");
  } else if (fs.existsSync(promptFile)) {
    const size = fs.readFileSync(promptFile, "utf8").length;
    ok(`prompt-skill.md 已同步（${size} 字符）`);
  } else {
    fail("缺少 prompt-skill.md", "修复：node sync-prompt.mjs");
  }

  /* 5. 端口 */
  console.log("\n[5] 服务端口");
  const listening = await checkPort(probeHost, port);
  if (listening) {
    ok(`${probeHost}:${port} 正在监听`);
  } else {
    fail(
      `${probeHost}:${port} 没有服务在监听`,
      "修复：在 app 目录执行 node server.js\n（或 Windows 下双击 start.bat）"
    );
  }

  /* 6. 接口响应 */
  let health = null;
  if (listening) {
    console.log("\n[6] 接口响应");
    try {
      const res = await fetch(`http://${probeHost}:${port}/api/health`);
      const text = await res.text();
      health = JSON.parse(text);
      ok("健康接口返回正常 JSON");
      info(`运行模式：${health.mode}${health.model ? ` · ${health.model}` : ""}`);
      info(`提示词规模：${health.promptChars} 字符`);
    } catch (err) {
      fail(
        "健康接口返回的不是 JSON —— 请求可能被中间层的反向代理拦下了",
        `请确认反向代理指向的是 ${probeHost}:${port}\n` +
          "若从别的端口访问本应用，说明代理配错了后端端口"
      );
    }

    if (health) {
      const indexRes = await fetch(`http://${probeHost}:${port}/`).catch(() => null);
      if (indexRes && indexRes.ok) {
        ok("首页可以正常打开");
      } else if (indexRes && indexRes.status === 404) {
        fail(
          "首页返回 404 —— 应用在跑，但找不到 public/index.html",
          "最常见原因：前端文件被放在了 app/ 根目录而不是 public/ 里。\n" +
            "修复：在 app 目录执行 mv index.html style.css app.js public/\n" +
            "改完重启服务（本脚本的第 [3] 环已能自动检出这种错位）"
        );
      } else {
        fail("首页打不开");
      }
    }
  }

  /* 7. 模型连通性 */
  if (health && !fatal) {
    console.log("\n[7] 模型连通性");
    if (health.mode === "dry-run") {
      warn("演示模式下不检测模型");
    } else {
      // 注意：必须用自己解析出的 .env 值，不能读 process.env ——
      // 本脚本并未加载 .env 到 process.env，那样会拿到 undefined 并误报 401
      const baseUrl = (env.LLM_BASE_URL || "https://api.deepseek.com/v1").replace(/\/+$/, "");
      const apiKey = env.LLM_API_KEY || "";
      const model = env.LLM_MODEL || "deepseek-chat";

      if (!apiKey) {
        fail("LLM_API_KEY 为空，无法检测模型连通性");
      } else {
        const started = Date.now();
        try {
          const res = await fetch(`${baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              model,
              messages: [{ role: "user", content: "回复两个字：正常" }],
              max_tokens: 10,
            }),
          });
          const text = await res.text();
          if (res.ok) {
            ok(`模型可调用（${Date.now() - started} 毫秒）`);
          } else {
            let detail = text.slice(0, 200);
            try {
              detail = JSON.parse(text).error?.message || detail;
            } catch {
              /* 保持原文 */
            }
            if (res.status === 401) {
              fail(`模型拒绝了密钥（401）：${detail}`, "修复：检查 .env 中的 LLM_API_KEY 是否正确");
            } else if (res.status === 402) {
              fail(
                `账户余额不足（402）：${detail}`,
                "密钥本身有效，但账户余额为 0。\n修复：前往模型服务商控制台充值（如 DeepSeek 的 platform.deepseek.com/top_up）"
              );
            } else if (res.status === 404) {
              fail(
                `接口地址或模型名不对（404）：${detail}`,
                `请确认 LLM_BASE_URL=${baseUrl} 与 LLM_MODEL=${model} 是否匹配`
              );
            } else if (res.status === 429) {
              warn(`触发限流（429）：${detail}`);
            } else {
              fail(`模型接口返回 ${res.status}：${detail}`);
            }
          }
        } catch (err) {
          fail(
            `无法连接模型接口：${err.message}`,
            `${baseUrl} 在当前网络下不可达，请检查网络或代理设置`
          );
        }
      }
    }
  }

  console.log("");
  if (fatal) {
    console.log("诊断结果：发现问题，请按上面的提示修复后重试。");
    process.exit(1);
  }
  console.log("诊断结果：一切正常，现在可以打开页面使用了。");
  console.log(`           http://${probeHost}:${port}`);
}

main().catch((err) => {
  console.error(`诊断脚本异常：${err.stack || err.message}`);
  process.exit(1);
});
