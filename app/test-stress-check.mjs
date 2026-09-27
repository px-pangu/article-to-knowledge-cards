#!/usr/bin/env node

/**
 * 真机压测：连续多次调用抽卡接口，覆盖 Four 类文体，统计成功率与重试情况。
 *
 * 会真实消耗模型额度（每次约 2000-4000 token）。
 *
 * 用法：node test-stress-check.mjs [base] [次数]
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, "..");
const FIXTURES = path.resolve(APP_DIR, "..", "tests", "fixtures");

const base = (process.argv[2] || "http://127.0.0.1:8787").replace(/\/+$/, "");
const roundInput = Number(process.argv[3] || 8);
const rounds = Number.isFinite(roundInput) && roundInput > 0 ? Math.floor(roundInput) : 8;

const files = [
  "01-sleep-and-memory.md",
  "02-rsync-tutorial.txt",
  "03-remote-work-opinion.md",
  "04-too-short.txt",
];

const GENRE_LABEL = {
  说明文: "说明文",
  操作教程: "操作教程",
  观点评论: "观点评论",
};

function pad(text, width) {
  const s = String(text);
  const visual = [...s].reduce((n, ch) => n + (ch.charCodeAt(0) > 255 ? 2 : 1), 0);
  return s + " ".repeat(Math.max(0, width - visual));
}

async function main() {
  console.log(`连续 ${rounds} 次真实抽卡（覆盖 4 类文体）\n`);
  console.log(`目标：${base}\n`);

  let ok = 0;
  let retried = 0;
  const failures = [];
  const startedAll = Date.now();

  for (let i = 0; i < rounds; i++) {
    const file = files[i % files.length];
    const text = fs.readFileSync(path.join(FIXTURES, file), "utf8");
    const started = Date.now();

    try {
      const res = await fetch(`${base}/api/cards`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const payload = await res.json();
      const sec = ((Date.now() - started) / 1000).toFixed(1);

      if (payload.ok) {
        ok++;
        const attempts = payload.meta?.attempts || 1;
        if (attempts > 1) retried++;
        const genre = GENRE_LABEL[payload.data.genre] || payload.data.genre || "?";
        const note = attempts > 1 ? `  (自动重试 ${attempts - 1} 次)` : "";
        console.log(
          `  ${String(i + 1).padStart(2)} \u2713 ${pad(file, 30)} ${pad(genre, 10)} ${String(
            payload.data.cards.length
          ).padStart(2)} 张  ${sec.padStart(5)}s${note}`
        );
      } else {
        const first = String(payload.error || "").split("\n")[0];
        failures.push({ file, error: first });
        console.log(`  ${String(i + 1).padStart(2)} \u2717 ${pad(file, 30)} ${sec.padStart(5)}s  ${first}`);
      }
    } catch (err) {
      failures.push({ file, error: err.message });
      console.log(`  ${String(i + 1).padStart(2)} \u2717 ${pad(file, 30)}  请求异常：${err.message}`);
    }
  }

  const total = ((Date.now() - startedAll) / 1000).toFixed(1);
  const rate = ((ok / rounds) * 100).toFixed(0);

  console.log("");
  console.log(`成功 ${ok}/${rounds}（${rate}%）` + (retried ? `，其中 ${retried} 次经自动重试救回` : "，全部一次通过"));
  console.log(`总耗时 ${total} 秒`);

  if (failures.length) {
    console.log("\n失败明细：");
    failures.forEach((f) => console.log(`  ${f.file}：${f.error}`));
  }

  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`压测脚本异常：${err.stack || err.message}`);
  process.exit(1);
});
