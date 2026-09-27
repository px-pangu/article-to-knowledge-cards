#!/usr/bin/env node

/**
 * 把 Skill 的 SKILL.md 同步到 App。
 *
 * 目的：让「抽卡规则」只有一份真源。改规则时只需改 SKILL.md，
 * 跑一次本脚本即可让 App 用上新规则，不必修改任何代码。
 *
 * 用法：node sync-prompt.mjs
 *
 * 产出两份内容相同的文件，服务于两种部署方式：
 *   prompt-skill.md         self-hosted（server.js 用 fs 读）
 *   prompt-bundle.mjs       Netlify Functions（打包时必须能 import，读不到 .md）
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = __dirname;
const SKILL_DIR = path.resolve(APP_DIR, "..", "skills", "make-knowledge-cards");

const SOURCES = {
  skill: path.join(SKILL_DIR, "SKILL.md"),
  contract: path.join(APP_DIR, "prompt-output-contract.md"),
};

const TARGET_MD = path.join(APP_DIR, "prompt-skill.md");
const TARGET_BUNDLE = path.join(APP_DIR, "prompt-bundle.mjs");

for (const [name, file] of Object.entries(SOURCES)) {
  if (!fs.existsSync(file)) {
    console.error(`找不到源文件（${name}）：${file}`);
    process.exit(1);
  }
}

// SKILL.md 的 YAML frontmatter 是给 Skill 加载器看的，注入模型时去掉更干净
const skillRaw = fs.readFileSync(SOURCES.skill, "utf8");
const skill = skillRaw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trimStart();
const contract = fs.readFileSync(SOURCES.contract, "utf8");

fs.mkdirSync(path.dirname(TARGET_MD), { recursive: true });
fs.writeFileSync(TARGET_MD, skill, "utf8");

/**
 * 生成可被 import 的模块。
 *
 * 为什么不直接把 .md 读进来？因为 Netlify Functions 打包时只包含
 * 函数文件及其 import 的模块 —— 运行时的 fs.readFileSync 读不到 .md。
 * 用 JSON.stringify 序列化可以保证内容逐字一致（含换行与引号）。
 */
const bundle = `/**
 * 自动生成，请勿手改。
 * 由 sync-prompt.mjs 从 skills/make-knowledge-cards/SKILL.md 同步而来。
 *
 * 为什么存在这个文件：Netlify Functions 打包时只带上被 import 的模块，
 * 运行时的 fs.readFileSync 读不到 .md 文件。把提示词变成 ES 模块即可解决。
 *
 * 改规则的唯一入口仍是 SKILL.md。改完在 app/ 下执行：
 *   node sync-prompt.mjs
 */

export const SKILL = ${JSON.stringify(skill)};

export const OUTPUT_CONTRACT = ${JSON.stringify(contract)};

/** 拼装最终注入模型的 system prompt */
export function combined() {
  return \`\${SKILL.trim()}\\n\\n---\\n\\n\${OUTPUT_CONTRACT.trim()}\\n\`;
}
`;

fs.writeFileSync(TARGET_BUNDLE, bundle, "utf8");

const lines = skill.split(/\r?\n/).length;
console.log("已同步抽卡规则：");
console.log(`  源  : ${path.relative(process.cwd(), SOURCES.skill)}`);
console.log(`  目标: ${path.relative(process.cwd(), TARGET_MD)}`);
console.log(`        ${path.relative(process.cwd(), TARGET_BUNDLE)}`);
console.log(`  规模: ${lines} 行 / ${skill.length} 字符`);
console.log("  说明: 已去除 frontmatter，其余内容逐字保留");
