/**
 * 文件文本抽取 —— 浏览器端零依赖实现
 *
 * 作用：让用户直接把 PDF / Word / Excel / 纯文本丢进来，前端先把它们变成纯文本，
 * 再交给原有的抽卡链路（core.mjs）。这样安排的好处：
 *   - 服务端保持零依赖（不装 pdf-parse / mammoth / xlsx）；
 *   - 纯静态托管（浏览器直连）模式同样可用，因为解析发生在浏览器里；
 *   - 三种部署方式共用同一份抽取逻辑，与 core.mjs 的定位一致。
 *
 * 实现取舍（为什么这么做）：
 *   - .docx / .xlsx 本质是 zip —— 自己读中央目录 + inflate 即可，约 150 行；
 *   - .pdf 用 pdf.js（CDN 懒加载）：自己写 PDF 文本抽取要处理 CMap 与字体编码，
 *     中文 PDF 极易抽成乱码，不划算。代价是首次解析 PDF 需要联网；
 *   - 图片与扫描版 PDF 不做 OCR：需要引入几十 MB 的识别模型，收益不划算，
 *     抽不出文字时给出明确的错误提示，而不是硬猜。
 *
 * 只依赖浏览器与 Node 都具备的标准能力：Blob / TextDecoder / DecompressionStream。
 * 因此这份文件既能被浏览器 import，也能在 Node 里跑单元测试。
 */

/* ---------- 对外常量 ---------- */

export const TEXT_EXTENSIONS = ["md", "markdown", "txt", "text", "csv"];
export const ZIP_EXTENSIONS = ["docx", "xlsx"];
export const PDF_EXTENSIONS = ["pdf"];

/** 给 <input type="file"> 的 accept 用 */
export const FILE_ACCEPT = ".md,.markdown,.txt,.text,.csv,.docx,.xlsx,.pdf";

/** 单个文件大小上限（PDF 可能很大，但也别让浏览器卡死） */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

/** 默认抽取后文本上限，与服务端 MAX_INPUT_CHARS 对齐 */
export const DEFAULT_MAX_CHARS = 60000;

/* PDF 解析走 CDN：pdfjs-dist 的 legacy 构建可直接被浏览器 import。
 * 路径已核实存在（legacy/build/pdf.mjs、pdf.worker.mjs、standard_fonts/）。 */
const PDFJS_VERSION = "4.10.38";
const PDFJS_BASE = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/legacy/build/`;
const PDFJS_FONTS = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/standard_fonts/`;
const PDF_MAX_PAGES = 300;

const KIND_LABEL = {
  md: "Markdown",
  markdown: "Markdown",
  txt: "文本",
  text: "文本",
  csv: "CSV",
  docx: "Word",
  xlsx: "Excel",
  pdf: "PDF",
};

/* ---------- 小工具 ---------- */

const decoder = new TextDecoder("utf-8");

export function extOf(name) {
  const match = /\.([a-z0-9]+)$/i.exec(String(name || "").trim());
  return match ? match[1].toLowerCase() : "";
}

/** 统一清洗：换行归一、去掉分页符、压缩空行 */
export function tidyText(input) {
  return String(input || "")
    .replace(/\r\n?/g, "\n")
    .replace(/\f/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeXmlEntities(input) {
  return String(input || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeChar(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeChar(parseInt(dec, 10)))
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function safeChar(code) {
  return Number.isFinite(code) && code > 0 && code <= 0x10ffff
    ? String.fromCodePoint(code)
    : "";
}

/** 把一个 XML 片段里的 <t>文本</t> 全部拼起来（docx / xlsx 共用） */
function collectT(xml) {
  const out = [];
  const re = /<t[^>]*>([\s\S]*?)<\/t>/g;
  let m;
  while ((m = re.exec(xml))) out.push(decodeXmlEntities(m[1]));
  return out.join("");
}

/* ---------- ZIP（docx / xlsx 的容器） ---------- */

/**
 * 极简 ZIP 读取器：只读中央目录，按需解压需要的条目。
 * 不支持 ZIP64 与加密文档 —— 这两类会给出明确报错，不静默返回空内容。
 */
export async function readZip(buffer) {
  const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

  // EOCD 在文件末尾（最多带 64KB 注释），从后往前找签名
  let eocd = -1;
  const min = Math.max(0, u8.length - 65558);
  for (let i = u8.length - 22; i >= min; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw new Error("这个文件不是有效的 docx / xlsx（zip 容器损坏或不是 Office 文档）。");
  }

  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const entries = Object.create(null);

  for (let i = 0; i < count; i++) {
    if (p + 46 > u8.length || view.getUint32(p, true) !== 0x02014b50) break;

    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOff = view.getUint32(p + 42, true);
    const name = decoder.decode(u8.subarray(p + 46, p + 46 + nameLen));

    if (localOff + 30 <= u8.length && view.getUint32(localOff, true) === 0x04034b50) {
      const lNameLen = view.getUint16(localOff + 26, true);
      const lExtraLen = view.getUint16(localOff + 28, true);
      const start = localOff + 30 + lNameLen + lExtraLen;
      const raw = u8.subarray(start, start + compSize);
      entries[name] = method === 0 ? raw : await inflateRaw(raw);
    }

    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** 解压一段 raw deflate 数据：浏览器走 DecompressionStream，Node 走 zlib（测试用） */
export async function inflateRaw(bytes) {
  if (typeof DecompressionStream === "function") {
    for (const format of ["deflate-raw", "deflate"]) {
      try {
        const ds = new DecompressionStream(format);
        const stream = new Blob([bytes]).stream().pipeThrough(ds);
        return new Uint8Array(await new Response(stream).arrayBuffer());
      } catch (err) {
        /* 换下一种格式再试 */
      }
    }
  }
  // Node 环境（单元测试）没有 DecompressionStream 的旧版本，退回内置 zlib
  const { inflateRawSync } = await import("node:zlib");
  return new Uint8Array(inflateRawSync(bytes));
}

/* ---------- docx ---------- */

export function docxToText(zip) {
  const xml = zip["word/document.xml"];
  if (!xml) {
    throw new Error("这个 .docx 里没有 word/document.xml，可能不是标准 Word 文档。");
  }

  let s = decoder.decode(xml);
  // 先按块级结构换成换行 / 制表符，再一次性剥掉所有标签
  s = s.replace(/<\/w:p>/g, "\n");
  s = s.replace(/<w:br\s*\/?>/g, "\n");
  s = s.replace(/<w:cr\s*\/?>/g, "\n");
  s = s.replace(/<w:tab\s*\/?>/g, "\t");
  // 单元格收尾时，段落带来的那个换行要吃掉，否则会得到「甲\n\t乙」这种断行
  s = s.replace(/\n?<\/w:tc>/g, "\t");
  s = s.replace(/<\/w:tr>/g, "\n");
  s = s.replace(/<[^>]+>/g, "");
  return tidyText(decodeXmlEntities(s));
}

/* ---------- xlsx ---------- */

/** 共享字符串表：<si> 里可能有多段 <r><t>，全部拼起来 */
function readSharedStrings(xml) {
  const list = [];
  const re = /<si>([\s\S]*?)<\/si>|<si\s*\/>/g;
  let m;
  while ((m = re.exec(xml))) list.push(m[1] ? collectT(m[1]) : "");
  return list;
}

/** 工作表与名字的对应关系（workbook.xml + rels），拿不到名字就退回「工作表 N」 */
function readSheetIndex(zip) {
  const wb = zip["xl/workbook.xml"];
  const rels = zip["xl/_rels/workbook.xml.rels"];
  if (!wb) return [];

  const relMap = Object.create(null);
  if (rels) {
    const re = /<Relationship\b([^>]*)\/?>/g;
    let m;
    while ((m = re.exec(decoder.decode(rels)))) {
      const id = /Id="([^"]*)"/.exec(m[1]);
      const target = /Target="([^"]*)"/.exec(m[1]);
      const type = /Type="([^"]*)"/.exec(m[1]);
      if (!id || !target) continue;
      if (type && !/worksheet/.test(type[1])) continue;
      let path = target[1].replace(/^\/+/, "");
      if (!path.startsWith("xl/")) path = `xl/${path}`;
      relMap[id[1]] = path;
    }
  }

  const sheets = [];
  const re = /<sheet\b([^>]*?)\/?>/g;
  let m;
  let n = 0;
  while ((m = re.exec(decoder.decode(wb)))) {
    const attrs = m[1] || "";
    const name = /name="([^"]*)"/.exec(attrs);
    const rid = /r:id="([^"]*)"/.exec(attrs) || /id="([^"]*)"/.exec(attrs);
    n += 1;
    const path = rid ? relMap[rid[1]] : "";
    if (path && zip[path]) sheets.push({ name: name ? decodeXmlEntities(name[1]) : `工作表 ${n}`, xml: zip[path] });
  }
  return sheets;
}

function sheetToRows(xml, shared) {
  const rows = [];
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>|<row\b[^>]*\/>/g;
  let rowMatch;
  while ((rowMatch = rowRe.exec(decoder.decode(xml)))) {
    const rowXml = rowMatch[1] || "";
    const cells = [];
    const cellRe = /<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*?)\/?>/g;
    let cellMatch;
    while ((cellMatch = cellRe.exec(rowXml))) {
      const attrs = cellMatch[1] || cellMatch[3] || "";
      const inner = cellMatch[2] || "";
      const type = (/t="([^"]*)"/.exec(attrs) || [])[1] || "n";

      let value = "";
      const inline = /<is>([\s\S]*?)<\/is>/.exec(inner);
      if (inline) {
        value = collectT(inline[1]);
      } else {
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
        value = v ? decodeXmlEntities(v[1]) : "";
        if (type === "s") {
          const idx = Number(value);
          value = Number.isInteger(idx) && shared[idx] !== undefined ? shared[idx] : "";
        } else if (type === "b") {
          value = value === "1" ? "TRUE" : "FALSE";
        }
      }
      cells.push(value.trim());
    }
    // 整行都是空单元格时跳过，避免输出一大片空行
    if (cells.some((c) => c !== "")) rows.push(cells.join(" | ").replace(/(\s*\|\s*)+$/g, ""));
  }
  return rows;
}

export function xlsxToText(zip) {
  const shared = zip["xl/sharedStrings.xml"] ? readSharedStrings(decoder.decode(zip["xl/sharedStrings.xml"])) : [];
  let sheets = readSheetIndex(zip);

  if (!sheets.length) {
    // rels 缺失或命名不一致时，退回到按文件名顺序扫描所有工作表
    sheets = Object.keys(zip)
      .filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))
      .sort((a, b) => {
        const na = Number(/(\d+)\.xml$/.exec(a)[1]);
        const nb = Number(/(\d+)\.xml$/.exec(b)[1]);
        return na - nb;
      })
      .map((k, i) => ({ name: `工作表 ${i + 1}`, xml: zip[k] }));
  }
  if (!sheets.length) {
    throw new Error("这个 .xlsx 里没有找到工作表，文件可能已损坏。");
  }

  const blocks = [];
  let rowCount = 0;
  sheets.forEach((sheet) => {
    const rows = sheetToRows(sheet.xml, shared);
    rowCount += rows.length;
    if (rows.length) blocks.push(`【${sheet.name}】\n${rows.join("\n")}`);
  });
  return { text: tidyText(blocks.join("\n\n")), sheets: sheets.length, rows: rowCount };
}

/* ---------- pdf ---------- */

async function loadPdfjs() {
  let mod;
  try {
    mod = await import(/* webpackIgnore: true */ `${PDFJS_BASE}pdf.mjs`);
  } catch (err) {
    throw new Error(
      "PDF 解析库加载失败。PDF 解析需要从 CDN 下载 pdf.js（约 1 MB），" +
        "请确认当前网络可以访问 cdn.jsdelivr.net 后重试；" +
        "若是离线环境，请把 PDF 先另存为 .txt / .md 再上传。"
    );
  }
  const lib = mod.GlobalWorkerOptions ? mod : mod.default || mod.pdfjsLib;
  if (lib && lib.GlobalWorkerOptions) {
    lib.GlobalWorkerOptions.workerSrc = `${PDFJS_BASE}pdf.worker.mjs`;
  }
  return lib;
}

function pdfItemsToText(items) {
  let out = "";
  let lastY = null;
  for (const item of items) {
    if (!item || typeof item.str !== "string") continue;
    const y = Array.isArray(item.transform) ? item.transform[5] : null;
    if (lastY !== null && y !== null && Math.abs(y - lastY) > 3) out += "\n";
    out += item.str;
    lastY = y === null ? lastY : y;
    if (item.hasEOL) out += "\n";
  }
  return out;
}

export async function pdfToText(buffer) {
  const lib = await loadPdfjs();
  const data = new Uint8Array(buffer instanceof Uint8Array ? buffer.slice(0) : new Uint8Array(buffer));

  let doc;
  try {
    doc = await lib.getDocument({
      data,
      standardFontDataUrl: PDFJS_FONTS,
      isEvalSupported: false,
    }).promise;
  } catch (err) {
    throw new Error(`PDF 打开失败：${err && err.message ? err.message : err}。加密或已损坏的 PDF 无法抽取文字。`);
  }

  try {
    const total = doc.numPages || 0;
    const pages = Math.min(total, PDF_MAX_PAGES);
    const chunks = [];
    for (let i = 1; i <= pages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      chunks.push(pdfItemsToText(content.items || []));
      page.cleanup();
    }
    return { text: tidyText(chunks.join("\n")), pages, totalPages: total };
  } finally {
    if (doc && typeof doc.destroy === "function") doc.destroy().catch(() => {});
  }
}

/* ---------- 对外主入口 ---------- */

function truncate(text, limit) {
  if (text.length <= limit) return { text, truncated: false };
  return { text: text.slice(0, limit), truncated: true };
}

/**
 * 从二进制内容里抽文本。
 * @param {ArrayBuffer|Uint8Array} buffer
 * @param {string} ext 不含点的小写扩展名
 * @param {{maxChars?: number}} [opts]
 */
export async function extractBuffer(buffer, ext, opts = {}) {
  const limit = opts.maxChars || DEFAULT_MAX_CHARS;
  const kind = KIND_LABEL[ext] || ext.toUpperCase();

  if (TEXT_EXTENSIONS.includes(ext)) {
    const raw = buffer instanceof Uint8Array ? decoder.decode(buffer) : new TextDecoder("utf-8").decode(buffer);
    const text = tidyText(raw);
    const cut = truncate(text, limit);
    return { ...cut, chars: cut.text.length, kind, detail: "" };
  }

  if (ext === "docx") {
    const text = docxToText(await readZip(buffer));
    const cut = truncate(text, limit);
    return { ...cut, chars: cut.text.length, kind, detail: "" };
  }

  if (ext === "xlsx") {
    const { text, sheets, rows } = xlsxToText(await readZip(buffer));
    const cut = truncate(text, limit);
    return { ...cut, chars: cut.text.length, kind, detail: `${sheets} 个工作表 · ${rows} 行` };
  }

  if (ext === "pdf") {
    const { text, pages, totalPages } = await pdfToText(buffer);
    const cut = truncate(text, limit);
    const detail = totalPages > pages ? `${pages}/${totalPages} 页` : `${pages} 页`;
    return { ...cut, chars: cut.text.length, kind, detail };
  }

  throw new Error(
    `不支持的文件类型：.${ext}。` +
      `目前支持 ${FILE_ACCEPT}；旧版 .doc / .xls 与图片请先另存为上述格式。`
  );
}

/**
 * 从 File / Blob 抽文本（浏览器入口）。
 * 返回结果里 text 可以直接喂给抽卡链路；truncated 表示被 maxChars 截断过。
 */
export async function extractFile(file, opts = {}) {
  const name = file.name || opts.name || "文件";
  const ext = extOf(name);
  const size = typeof file.size === "number" ? file.size : 0;

  if (!ext) throw new Error("这个文件没有扩展名，无法判断类型。");
  if (size && size > MAX_FILE_BYTES) {
    throw new Error(
      `文件过大（${(size / 1024 / 1024).toFixed(1)} MB），上限 ${MAX_FILE_BYTES / 1024 / 1024} MB。`
    );
  }

  let result;
  if (TEXT_EXTENSIONS.includes(ext)) {
    result = await extractBuffer(new Uint8Array(await file.arrayBuffer()), ext, opts);
  } else {
    result = await extractBuffer(await file.arrayBuffer(), ext, opts);
  }

  if (!result.text || result.text.length < 20) {
    throw new Error(
      ext === "pdf"
        ? "这个 PDF 里没有抽到文字。它可能是扫描件或纯图片 PDF（本应用不做 OCR），" +
            "也可能是加密文档。请改用含文字层的 PDF，或另存为 .txt 后再上传。"
        : `没有从 ${name} 中读到内容，文件可能是空的。`
    );
  }
  return { ...result, name };
}
