#!/usr/bin/env node

/**
 * 文件抽取与网页抓取的单元测试（零消耗，不调用模型）
 *
 * 用法：node test-extract.mjs
 *
 * 覆盖：
 *   1) ZIP 容器读取（docx / xlsx 的本质）—— 用脚本现场构造 zip，不依赖二进制夹具
 *   2) docx / xlsx → 文本（含共享字符串、内联字符串、工作表命名、空行跳过）
 *   3) 纯文本 / CSV、截断、不支持的格式、抽不出文字时的报错
 *   4) HTML → 正文（去脚本/导航/页脚、实体还原、优先取 <article>）
 *   5) URL 校验与内网地址拦截（防 SSRF）
 *   6) 对本地假站点真实抓取（含重定向、非网页类型被拒）
 *
 * PDF 分支不在这里做端到端验证：pdf.js 是浏览器运行时从 CDN 加载的，
 * Node 无法 import http 模块。这里只验证它失败时给出的是可读的中文提示。
 */

import http from "node:http";
import zlib from "node:zlib";

import {
  readZip,
  docxToText,
  xlsxToText,
  extractBuffer,
  extractFile,
  extOf,
  tidyText,
} from "./extract.mjs";
import {
  fetchUrlText,
  normalizeUrl,
  htmlToText,
  htmlTitle,
  isBlockedAddress,
} from "./fetch-url.mjs";

/* ---------- 迷你测试框架 ---------- */

let passed = 0;
let failed = 0;

function ok(name) {
  passed += 1;
  console.log(`  \u2713  ${name}`);
}

function bad(name, detail) {
  failed += 1;
  console.log(`  \u2717  ${name}`);
  if (detail) console.log(`     ${detail}`);
}

async function check(name, fn) {
  try {
    await fn();
    ok(name);
  } catch (err) {
    bad(name, err && err.message ? err.message : String(err));
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message || "断言失败");
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label || "值"} 不符合预期\n     期望: ${JSON.stringify(expected)}\n     实际: ${JSON.stringify(actual)}`);
  }
}

/* ---------- 现场构造 zip（docx / xlsx 的容器） ---------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

/**
 * 造一个最小可用的 zip。store=true 时不压缩（顺便验证 method 0 分支）。
 * @param {{name: string, data: Buffer, store?: boolean}[]} entries
 */
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const data = Buffer.from(entry.data);
    const method = entry.store ? 0 : 8;
    const payload = entry.store ? data : zlib.deflateRawSync(data);
    const crc = crc32(data);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(0x21, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(payload.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);

    const local = Buffer.concat([lh, nameBuf, payload]);
    locals.push(local);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0x21, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(payload.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);

    centrals.push(Buffer.concat([ch, nameBuf]));
    offset += local.length;
  }

  const cdSize = centrals.reduce((n, b) => n + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(centrals.length, 8);
  eocd.writeUInt16LE(centrals.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, ...centrals, eocd]);
}

const encoder = new TextEncoder();
const asBytes = (text) => encoder.encode(text);

/* ---------- 夹具 ---------- */

const DOCX_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:r><w:t>深度工作指在无干扰状态下专注进行的职业活动。</w:t></w:r></w:p>
<w:p><w:r><w:t>浮浅工作则不需要太多认知努力。</w:t></w:r><w:r><w:t>它往往让人显得很忙。</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>甲</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>乙</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
<w:p><w:r><w:t>符号 &amp; 尖括号 &lt;tag&gt; 要还原。</w:t></w:r></w:p>
</w:body></w:document>`;

const XLSX_SHARED = `<?xml version="1.0" encoding="UTF-8"?>
<sst count="3" uniqueCount="3"><si><t>项目</t></si><si><t>收入</t></si><si><r><t>A</t></r><r><t>产品</t></r></si></sst>`;

const XLSX_SHEET1 = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>1200</v></c><c r="C2" t="b"><v>1</v></c></row>
<row r="3"><c r="A3"/><c r="B3"/></row>
</sheetData></worksheet>`;

const XLSX_SHEET2 = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet><sheetData>
<row r="1"><c r="A1" t="inlineStr"><is><t>本表为说明文字</t></is></c></row>
</sheetData></worksheet>`;

const XLSX_WORKBOOK = `<?xml version="1.0" encoding="UTF-8"?>
<workbook><sheets><sheet name="月度数据" sheetId="1" r:id="rId1"/><sheet name="说明" sheetId="2" r:id="rId2"/></sheets></workbook>`;

const XLSX_RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/sheet2.xml"/></Relationships>`;

const SAMPLE_HTML = `<!DOCTYPE html>
<html><head><title>测试标题</title>
<style>body { color: red }</style>
<script>console.log("不该出现")</script>
</head><body>
<nav><a href="/">首页</a><a href="/about">关于</a></nav>
<header>站点头部横幅</header>
<article>
  <h1>睡眠与记忆巩固</h1>
  <p>睡眠并非大脑的关机状态，一夜会经历约 4 到 6 个周期。</p>
  <p>记忆巩固主要发生在慢波睡眠阶段。</p>
  <ul><li>海马体负责临时缓存</li><li>新皮层负责长期存储</li></ul>
  <p>引用 &amp; 实体 &lt;tag&gt; 也应还原。</p>
</article>
<footer>版权所有 &copy; 2026</footer>
</body></html>`;

/* ---------- 本地假站点 ---------- */

function startFakeSite() {
  const server = http.createServer((req, res) => {
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "/post" });
      res.end("");
      return;
    }
    if (req.url === "/pdf") {
      res.writeHead(200, { "content-type": "application/pdf" });
      res.end("%PDF-1.4 fake");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(SAMPLE_HTML);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

/* ---------- 用例 ---------- */

async function main() {
  console.log("文件抽取与网页抓取 · 单元测试\n");

  console.log("[1] ZIP 容器与 docx");
  const docxZip = makeZip([{ name: "word/document.xml", data: Buffer.from(DOCX_XML, "utf8") }]);

  await check("能读出 zip 里的条目", async () => {
    const zip = await readZip(docxZip);
    assert(zip["word/document.xml"], "没找到 word/document.xml");
  });

  await check("method 0（不压缩）的条目同样能读出", async () => {
    const zip = await readZip(
      makeZip([{ name: "word/document.xml", data: Buffer.from(DOCX_XML, "utf8"), store: true }])
    );
    assert(docxToText(zip).includes("深度工作"), "不压缩条目内容不对");
  });

  await check("docx 段落 / 表格 / 实体都正确", async () => {
    const text = docxToText(await readZip(docxZip));
    assert(text.includes("深度工作指在无干扰状态下专注进行的职业活动。"), "缺第一段");
    assert(text.includes("浮浅工作则不需要太多认知努力。它往往让人显得很忙。"), "同一段落的多段文本应拼接");
    assert(text.includes("甲\t乙"), "表格单元格应转成制表符分隔");
    assert(text.includes("符号 & 尖括号 <tag> 要还原。"), "XML 实体未还原");
    assert(!text.includes("<w:"), "XML 标签没剥干净");
  });

  console.log("\n[2] xlsx");
  const xlsxZip = makeZip([
    { name: "xl/workbook.xml", data: Buffer.from(XLSX_WORKBOOK, "utf8") },
    { name: "xl/_rels/workbook.xml.rels", data: Buffer.from(XLSX_RELS, "utf8") },
    { name: "xl/sharedStrings.xml", data: Buffer.from(XLSX_SHARED, "utf8") },
    { name: "xl/worksheets/sheet1.xml", data: Buffer.from(XLSX_SHEET1, "utf8") },
    { name: "xl/worksheets/sheet2.xml", data: Buffer.from(XLSX_SHEET2, "utf8") },
  ]);

  await check("共享字符串与数值单元格正确", async () => {
    const { text, sheets, rows } = xlsxToText(await readZip(xlsxZip));
    assert(text.includes("项目 | 收入"), `缺表头：${text}`);
    assert(text.includes("A产品 | 1200"), `缺数据行（多段 <r><t> 应拼接为 A产品）：${text}`);
    assert(text.includes("TRUE"), "布尔单元格未转换");
    assertEqual(sheets, 2, "工作表数量");
    assertEqual(rows, 3, "有效行数（空行应跳过）");
  });

  await check("工作表按 workbook.xml 的名字命名（含绝对路径的 rels）", async () => {
    const { text } = xlsxToText(await readZip(xlsxZip));
    assert(text.includes("【月度数据】"), `缺工作表名：${text}`);
    assert(text.includes("【说明】"), "第二个工作表（rels 里是绝对路径）没被识别");
    assert(text.includes("本表为说明文字"), "内联字符串未读出");
  });

  await check("没有 rels 时退回按文件名顺序扫描", async () => {
    const zip = await readZip(
      makeZip([
        { name: "xl/sharedStrings.xml", data: Buffer.from(XLSX_SHARED, "utf8") },
        { name: "xl/worksheets/sheet1.xml", data: Buffer.from(XLSX_SHEET1, "utf8") },
      ])
    );
    const { text } = xlsxToText(zip);
    assert(text.includes("【工作表 1】"), `未退回默认命名：${text}`);
  });

  console.log("\n[3] 抽取入口的行为");
  await check("纯文本原样保留并做换行规整", async () => {
    const result = await extractBuffer(asBytes("第一行\r\n\r\n\r\n第二行  \n"), "txt");
    assertEqual(result.text, "第一行\n\n第二行", "换行规整结果");
    assertEqual(result.kind, "文本", "kind");
  });

  await check("超长文本按 maxChars 截断并标记", async () => {
    const long = "知识卡片".repeat(100);
    const result = await extractBuffer(asBytes(long), "txt", { maxChars: 50 });
    assertEqual(result.chars, 50, "截断后长度");
    assertEqual(result.truncated, true, "truncated 标记");
  });

  await check("不支持的格式给出明确报错（点名旧版 .doc）", async () => {
    let message = "";
    try {
      await extractBuffer(asBytes("x"), "doc");
    } catch (err) {
      message = err.message;
    }
    assert(message.includes("不支持的文件类型"), `报错不当：${message}`);
    assert(message.includes(".doc"), "应点名旧版 .doc 的处理方式");
  });

  await check("PDF 分支在无法加载 pdf.js 时给出可读提示（不抛原始错误）", async () => {
    let message = "";
    try {
      await extractBuffer(asBytes("%PDF-1.4"), "pdf");
    } catch (err) {
      message = err.message;
    }
    assert(message.includes("PDF 解析库加载失败"), `报错不当：${message}`);
    assert(message.includes("离线"), "应说明离线时的替代做法");
  });

  await check("extractFile 拒绝超过体积上限的文件", async () => {
    let message = "";
    try {
      await extractFile({ name: "大文件.pdf", size: 40 * 1024 * 1024 });
    } catch (err) {
      message = err.message;
    }
    assert(message.includes("文件过大"), `报错不当：${message}`);
  });

  await check("抽不出文字时不静默返回空串（扫描版 PDF 的常见情形）", async () => {
    let message = "";
    try {
      await extractFile({ name: "扫描件.pdf", size: 100, arrayBuffer: async () => asBytes("%PDF") });
    } catch (err) {
      message = err.message;
    }
    // Node 下 pdf.js 加载失败，但报错必须是中文可读的，而不是 ESM 底层错误
    assert(/PDF/.test(message), `报错不当：${message}`);
  });

  await check("扩展名解析对大小写与多点文件名都成立", () => {
    assertEqual(extOf("报告.PDF"), "pdf", "大写扩展名");
    assertEqual(extOf("v1.2.final.docx"), "docx", "多点文件名");
    assertEqual(extOf("没有扩展名"), "", "无扩展名");
  });

  await check("tidyText 压缩空行并把分页符转成换行", () => {
    assertEqual(tidyText("a\f\nb\r\n\r\n\r\nc"), "a\n\nb\n\nc", "清洗结果");
    assertEqual(tidyText("行尾空格  \n下一行"), "行尾空格\n下一行", "行尾空格应去掉");
  });

  console.log("\n[4] HTML → 正文");
  await check("剥掉脚本 / 样式 / 导航 / 页脚，保留列表与实体", () => {
    const text = htmlToText(SAMPLE_HTML);
    assert(!text.includes("console.log"), "脚本内容没去掉");
    assert(!text.includes("首页"), "导航没去掉");
    assert(!text.includes("版权所有"), "页脚没去掉");
    assert(!text.includes("站点头部横幅"), "页头没去掉");
    assert(text.includes("- 海马体负责临时缓存"), "列表项应保留短横");
    assert(text.includes("引用 & 实体 <tag> 也应还原。"), "实体未还原");
    assert(text.includes("记忆巩固主要发生在慢波睡眠阶段。"), "正文缺失");
  });

  await check("标题单独可取", () => {
    assertEqual(htmlTitle(SAMPLE_HTML), "测试标题", "title");
  });

  await check("没有 article 时退回到整页", () => {
    const text = htmlToText("<html><body><p>只有一段正文，没有 article 容器。</p></body></html>");
    assert(text.includes("只有一段正文"), `未退回整页：${text}`);
  });

  console.log("\n[5] URL 校验与内网拦截");
  await check("补齐 https 前缀、识别非法地址", () => {
    assertEqual(normalizeUrl("example.com/post").href, "https://example.com/post", "补前缀");
    let message = "";
    try {
      normalizeUrl("ftp://example.com/a");
    } catch (err) {
      message = err.message;
    }
    assert(message.includes("只支持 http"), `协议拦截不当：${message}`);
  });

  await check("内网与保留地址一律拦截", () => {
    for (const ip of ["127.0.0.1", "10.0.0.5", "192.168.1.9", "169.254.169.254", "172.20.1.1", "::1", "::ffff:127.0.0.1"]) {
      assert(isBlockedAddress(ip), `${ip} 应被拦截`);
    }
    for (const ip of ["8.8.8.8", "93.184.216.34", "114.114.114.114"]) {
      assert(!isBlockedAddress(ip), `${ip} 不应被拦截`);
    }
  });

  console.log("\n[6] 真实抓取本地假站点");
  const { server, port } = await startFakeSite();

  await check("抓到标题与正文，且不含导航页脚", async () => {
    const result = await fetchUrlText(`http://127.0.0.1:${port}/post`, { allowPrivate: true });
    assertEqual(result.title, "测试标题", "title");
    assert(result.text.includes("记忆巩固主要发生在慢波睡眠阶段。"), "正文缺失");
    assert(!result.text.includes("版权所有"), "页脚没去掉");
    assert(!result.text.includes("console.log"), "脚本没去掉");
  });

  await check("跟随重定向后仍取到正文", async () => {
    const result = await fetchUrlText(`http://127.0.0.1:${port}/redirect`, { allowPrivate: true });
    assert(result.url.endsWith("/post"), `最终地址不对：${result.url}`);
    assert(result.text.includes("睡眠"), "重定向后正文缺失");
  });

  await check("非网页类型被拒绝并给出明确提示", async () => {
    let message = "";
    try {
      await fetchUrlText(`http://127.0.0.1:${port}/pdf`, { allowPrivate: true });
    } catch (err) {
      message = err.message;
    }
    assert(message.includes("不是网页"), `提示不当：${message}`);
  });

  await check("默认拒绝抓取内网地址（防 SSRF）", async () => {
    let message = "";
    try {
      await fetchUrlText(`http://127.0.0.1:${port}/post`);
    } catch (err) {
      message = err.message;
    }
    assert(message.includes("拒绝抓取"), `提示不当：${message}`);
  });

  await check("抓不到正文时不返回空串（脚本渲染的空壳页）", async () => {
    const empty = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><body><div id='app'></div></body></html>");
    });
    await new Promise((resolve) => empty.listen(0, "127.0.0.1", resolve));
    let message = "";
    try {
      await fetchUrlText(`http://127.0.0.1:${empty.address().port}/`, { allowPrivate: true });
    } catch (err) {
      message = err.message;
    }
    empty.close();
    assert(message.includes("没有抓到可用的正文"), `提示不当：${message}`);
  });

  server.close();

  console.log("");
  if (failed) {
    console.log(`结果：${passed} 项通过，${failed} 项失败。`);
    process.exit(1);
  }
  console.log(`结果：全部 ${passed} 项通过。`);
}

main().catch((err) => {
  console.error(`测试脚本异常：${err.stack || err.message}`);
  process.exit(1);
});
