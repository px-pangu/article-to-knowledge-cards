#!/usr/bin/env node

/**
 * JSON 容错修复的单元测试。
 *
 * 用例全部取自真实采样中 DeepSeek 实际产出的坏 JSON，
 * 用来确保 repairJson 能正确修补，且不破坏正常数据。
 *
 * 用法：node test-repair-json.mjs
 */

/*
 * 为了让测试可以独立运行，这里直接内联一份 extractJson / repairJson 的实现副本。
 * 若 server.js 中这两个函数有改动，本文件需同步。
 * （之所以不 import，是因为 server.js 启动时会立刻监听端口。）
 */

function repairJson(text) {
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
        let j = i + 1;
        while (j < text.length && /\s/.test(text[j])) j++;
        const next = text[j];
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

    if (inString && (ch === "\n" || ch === "\r" || ch === "\t")) {
      out += ch === "\t" ? "\\t" : ch === "\n" ? "\\n" : "\\r";
      continue;
    }

    out += ch;
  }

  out = out.replace(/,(\s*[}\]])/g, "$1");
  return out;
}

function extractJson(raw) {
  let text = String(raw || "").trim();
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("模型未返回可解析的 JSON 对象。");
  }
  const slice = text.slice(start, end + 1);
  try {
    return JSON.parse(slice);
  } catch (firstError) {
    try {
      return JSON.parse(repairJson(slice));
    } catch {
      throw new Error(`模型返回的 JSON 无法解析：${firstError.message}`);
    }
  }
}

let passed = 0;
let failed = 0;

function test(name, input, predicate) {
  let result;
  let error = null;
  try {
    result = extractJson(input);
  } catch (err) {
    error = err;
  }
  const ok = error ? false : predicate(result);
  if (ok) {
    passed++;
    console.log(`  \u2713  ${name}`);
  } else {
    failed++;
    console.log(`  \u2717  ${name}`);
    if (error) console.log(`     抛出：${error.message}`);
    else console.log(`     结果不符：${JSON.stringify(result).slice(0, 160)}`);
  }
}

console.log("JSON 容错修复 · 单元测试\n");

/* ---- 1. 正常 JSON 不能被破坏 ---- */

console.log("[1] 正常输入（修复逻辑不应改变结果）");

test(
  "标准 JSON 原样通过",
  '{"title":"测试","cards":[{"title":"A","core":"B","explain":"C","example":"D"}]}',
  (r) => r.title === "测试" && r.cards[0].title === "A"
);

test(
  "被 ```json 代码块包裹",
  '```json\n{"title":"测试","cards":[{"title":"A","core":"B","explain":"C","quiz":"Q"}]}\n```',
  (r) => r.cards[0].quiz === "Q"
);

test(
  "前后有解释性文字也能提取",
  '好的，以下是卡片：\n{"title":"T","cards":[{"title":"A","core":"B","explain":"C","example":"D"}]}\n以上就是全部。',
  (r) => r.title === "T"
);

test(
  "已正确转义的引号不受影响",
  '{"title":"T","cards":[{"title":"A","core":"他说\\"你好\\"","explain":"C","example":"D"}]}',
  (r) => r.cards[0].core === '他说"你好"'
);

test(
  "字符串内的 \\n 转义不被破坏",
  '{"title":"T","cards":[{"title":"A","core":"第一行\\n第二行","explain":"C","example":"D"}]}',
  (r) => r.cards[0].core === "第一行\n第二行"
);

/* ---- 2. 真实坏样本：中文文本里误用英文引号（本次遇到的主因） ---- */

console.log("\n[2] 真实坏样本 · 中文文本里误用英文直引号");

test(
  "explain 中含未转义引号（样本 1）",
  '{"title":"T","cards":[{"title":"REM 睡眠的功能","core":"与情绪记忆有关","explain":"这正是"睡一觉再想"常常带来新解决思路的原因。","example":"D"}]}',
  (r) => r.cards[0].explain.includes("睡一觉再想") && r.cards[0].explain.includes('"')
);

test(
  "quiz 中同样含未转义引号",
  '{"title":"T","cards":[{"title":"A","core":"B","explain":"C","quiz":"为什么"睡一觉再想"能带来新思路？"}]}',
  (r) => r.cards[0].quiz.includes("为什么") && r.cards[0].quiz.includes("睡一觉再想")
);

test(
  "同一字符串内出现多组引号",
  '{"title":"T","cards":[{"title":"A","core":"他说"甲"，她说"乙"","explain":"C","example":"D"}]}',
  (r) => r.cards[0].core === '他说"甲"，她说"乙"'
);

test(
  "多张卡片连续出现该问题",
  '{"title":"T","cards":[{"title":"A","core":"说"一"","explain":"C","example":"D"},{"title":"B","core":"说"二"","explain":"F","example":"G"}]}',
  (r) => r.cards.length === 2 && r.cards[1].core === '说"二"'
);

test(
  "引号出现在 coverage_note",
  '{"title":"T","cards":[{"title":"A","core":"B","explain":"C","example":"D"}],"coverage_note":"原文中的"实验范式"未成卡"}',
  (r) => r.coverage_note.includes("实验范式") && r.coverage_note.includes('"')
);

/* ---- 3. 其他常见坏格式 ---- */

console.log("\n[3] 其他常见坏格式");

test(
  "尾随逗号（对象）",
  '{"title":"T","cards":[{"title":"A","core":"B","explain":"C","example":"D",}],}',
  (r) => r.cards.length === 1
);

test(
  "尾随逗号（数组）",
  '{"title":"T","cards":[{"title":"A","core":"B","explain":"C","example":"D"},]}',
  (r) => r.cards.length === 1
);

test(
  "字符串内裸换行",
  '{"title":"T","cards":[{"title":"A","core":"第一段\n第二段","explain":"C","example":"D"}]}',
  (r) => r.cards[0].core.includes("第一段") && r.cards[0].core.includes("\n")
);

test(
  "同时存在引号问题 + 尾随逗号",
  '{"title":"T","cards":[{"title":"A","core":"说"甲"","explain":"C","example":"D",}],}',
  (r) => r.cards[0].core === '说"甲"'
);

/* ---- 4. 确实无法修复的输入应当报错，而不是给出错误数据 ---- */

console.log("\n[4] 无法修复的输入应明确报错");

function expectThrow(name, input) {
  let threw = false;
  try {
    extractJson(input);
  } catch {
    threw = true;
  }
  if (threw) {
    passed++;
    console.log(`  \u2713  ${name}`);
  } else {
    failed++;
    console.log(`  \u2717  ${name}（本应报错却解析成功）`);
  }
}

expectThrow("完全不是 JSON", "这是一段普通文字，没有花括号");
expectThrow("花括号未闭合", '{"title":"T","cards":[{"title":"A"');
expectThrow("空输入", "");

console.log(`\n结果：通过 ${passed} 项，失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
