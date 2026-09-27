"use strict";

(function () {
  const $ = (id) => document.getElementById(id);

  const els = {
    statusText: $("statusText"),
    statusDot: $("statusDot"),
    uploadBtn: $("uploadBtn"),
    clearBtn: $("clearBtn"),
    fileInput: $("fileInput"),
    textInput: $("textInput"),
    charCount: $("charCount"),
    fileHint: $("fileHint"),
    tokenBox: $("tokenBox"),
    tokenInput: $("tokenInput"),
    generateBtn: $("generateBtn"),
    generateLabel: $("generateLabel"),
    hint: $("hint"),
    elapsed: $("elapsed"),
    outputActions: $("outputActions"),
    copyBtn: $("copyBtn"),
    downloadBtn: $("downloadBtn"),
    emptyState: $("emptyState"),
    errorBox: $("errorBox"),
    result: $("result"),
    resultMeta: $("resultMeta"),
    noticeBox: $("noticeBox"),
    cards: $("cards"),
    coverageBox: $("coverageBox"),
    toast: $("toast"),
  };

  const STORAGE = {
    draft: "akc.draft",
    token: "akc.token",
  };

  let state = {
    data: null,
    meta: null,
    controller: null,
    timer: null,
    maxInputChars: 60000,
    cancelBtn: null,
  };

  /* ---------- 工具 ---------- */

  function showToast(message) {
    els.toast.textContent = message;
    els.toast.hidden = false;
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => {
      els.toast.hidden = true;
    }, 2200);
  }

  function setError(message) {
    if (!message) {
      els.errorBox.hidden = true;
      els.errorBox.textContent = "";
      return;
    }
    els.errorBox.textContent = message;
    els.errorBox.hidden = false;
  }

  function updateCharCount() {
    const len = els.textInput.value.length;
    els.charCount.textContent = `${len} 字`;
    const over = len > state.maxInputChars;
    els.charCount.classList.toggle("over", over);
    if (over) {
      els.fileHint.textContent = `超出上限 ${state.maxInputChars} 字，请分段`;
    } else if (!els.fileHint.dataset.locked) {
      els.fileHint.textContent = "";
    }
  }

  /* ---------- 服务状态 ---------- */

  async function checkHealth() {
    try {
      const res = await fetch("/api/health");
      const health = await res.json();
      if (!health.ok) throw new Error("health 返回异常");

      state.maxInputChars = health.maxInputChars || 60000;

      if (health.mode === "dry-run") {
        els.statusDot.className = "status-dot demo";
        els.statusText.textContent = "演示模式";
        els.statusText.title = "服务以 DRY_RUN=1 启动，返回固定示例，不调用模型";
      } else {
        els.statusDot.className = "status-dot ok";
        els.statusText.textContent = health.model ? `已就绪 · ${health.model}` : "已就绪";
      }

      if (health.tokenRequired) {
        els.tokenBox.hidden = false;
        els.tokenInput.value = localStorage.getItem(STORAGE.token) || "";
      }
      if (health.baseUrl) els.statusText.title = `模型接口：${health.baseUrl}`;
      updateCharCount();
    } catch (err) {
      els.statusDot.className = "status-dot bad";
      els.statusText.textContent = "服务异常";
    }
  }

  /* ---------- 输入 ---------- */

  function readFile(file) {
    if (file.size > 1024 * 1024) {
      setError("文件超过 1 MB，请先裁剪后再上传。");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      els.textInput.value = String(reader.result || "");
      els.fileHint.dataset.locked = "1";
      els.fileHint.textContent = `已载入 ${file.name}`;
      updateCharCount();
      setError("");
      saveDraft();
    };
    reader.onerror = () => setError("文件读取失败，请确认是纯文本文件。");
    reader.readAsText(file, "utf-8");
  }

  function saveDraft() {
    try {
      localStorage.setItem(STORAGE.draft, els.textInput.value);
    } catch (err) {
      /* 容量超限时忽略 */
    }
  }

  /* ---------- 渲染 ---------- */

  function section(labelText, bodyText, opts) {
    const wrap = document.createElement("div");
    wrap.className = "section";

    const label = document.createElement("div");
    label.className = "section-label" + (opts && opts.quiz ? " quiz" : "");
    label.textContent = labelText;

    const body = document.createElement("div");
    body.className = "section-body" + (opts && opts.core ? " core" : "") + (opts && opts.quiz ? " quiz-text" : "");
    body.textContent = bodyText;

    wrap.appendChild(label);
    wrap.appendChild(body);
    return wrap;
  }

  function render(data, meta) {
    els.emptyState.hidden = true;
    els.result.hidden = false;
    els.outputActions.hidden = false;
    els.cards.textContent = "";
    els.cards.appendChild(titleNode(data.title));

    els.resultMeta.textContent = "";
    const metaBits = [`共 ${data.cards.length} 张卡片`];
    if (data.genre) metaBits.push(`体裁：${data.genre}`);
    if (meta && meta.elapsedMs) metaBits.push(`耗时 ${(meta.elapsedMs / 1000).toFixed(1)} 秒`);
    if (meta && meta.inputChars) metaBits.push(`原文 ${meta.inputChars} 字`);
    if (meta && meta.model) metaBits.push(meta.model);
    if (meta && meta.attempts > 1) metaBits.push(`重试 ${meta.attempts - 1} 次`);
    if (meta && meta.mode === "dry-run") metaBits.push("演示数据");
    metaBits.forEach((bit) => {
      const span = document.createElement("span");
      span.textContent = bit;
      els.resultMeta.appendChild(span);
    });

    if (data.notice) {
      els.noticeBox.textContent = data.notice;
      els.noticeBox.hidden = false;
    } else {
      els.noticeBox.hidden = true;
    }

    data.cards.forEach((card) => {
      const node = document.createElement("article");
      node.className = "card";

      const head = document.createElement("div");
      head.className = "card-title";
      const no = document.createElement("span");
      no.className = "card-no";
      no.textContent = String(card.no).padStart(2, "0");
      const name = document.createElement("span");
      name.textContent = card.title;
      head.appendChild(no);
      head.appendChild(name);
      node.appendChild(head);

      node.appendChild(section("核心知识", card.core, { core: true }));
      node.appendChild(section("简明解释", card.explain));
      if (card.example) node.appendChild(section("例子", card.example));
      if (card.quiz) node.appendChild(section("自测问题", card.quiz, { quiz: true }));

      els.cards.appendChild(node);
    });

    if (data.coverageNote) {
      els.coverageBox.textContent = "";
      const strong = document.createElement("strong");
      strong.textContent = "覆盖说明　";
      els.coverageBox.appendChild(strong);
      els.coverageBox.appendChild(document.createTextNode(data.coverageNote));
      els.coverageBox.hidden = false;
    } else {
      els.coverageBox.hidden = true;
    }
  }

  function titleNode(title) {
    const h = document.createElement("h3");
    h.className = "result-title";
    h.textContent = `知识卡片：${title}`;
    return h;
  }

  /* ---------- 导出 ---------- */

  function toMarkdown(data) {
    const out = [];
    out.push(`# 知识卡片：${data.title}`);
    out.push("");

    const bits = [`共 ${data.cards.length} 张卡片`];
    if (data.genre) bits.push(`体裁：${data.genre}`);
    bits.push("来源：网页应用");
    out.push(`> ${bits.join("　|　")}`);
    if (data.notice) {
      out.push(">");
      out.push(`> 说明：${data.notice}`);
    }
    out.push("");

    data.cards.forEach((card) => {
      out.push("---");
      out.push("");
      out.push(`## 卡片 ${card.no}｜${card.title}`);
      out.push("");
      out.push("**核心知识**");
      out.push(card.core);
      out.push("");
      out.push("**简明解释**");
      out.push(card.explain);
      out.push("");
      if (card.example) {
        out.push("**例子**");
        out.push(card.example);
        out.push("");
      }
      if (card.quiz) {
        out.push("**自测问题**");
        out.push(card.quiz);
        out.push("");
      }
    });

    if (data.coverageNote) {
      out.push("---");
      out.push("");
      out.push("**覆盖说明**");
      out.push(data.coverageNote);
      out.push("");
    }

    return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
  }

  async function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (err) {
        /* 退回到 execCommand */
      }
    }
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch (err) {
      ok = false;
    }
    document.body.removeChild(ta);
    return ok;
  }

  function safeFileName(name) {
    return (
      String(name || "知识卡片")
        .replace(/[\\/:*?"<>|\r\n\t]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 40) || "知识卡片"
    );
  }

  function download() {
    if (!state.data) return;
    const text = toMarkdown(state.data);
    const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${safeFileName(state.data.title)}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast("已下载 Markdown 文件");
  }

  /* ---------- 生成 ---------- */

  function setLoading(loading) {
    els.generateBtn.disabled = loading;
    els.generateLabel.textContent = loading ? "正在抽卡…" : "生成知识卡片";
    els.hint.hidden = loading;

    if (loading) {
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "btn btn-cancel";
      cancel.textContent = "取消";
      cancel.addEventListener("click", () => {
        if (state.controller) state.controller.abort();
      });
      state.cancelBtn = cancel;
      els.generateBtn.insertAdjacentElement("afterend", cancel);

      const started = Date.now();
      els.elapsed.hidden = false;
      els.elapsed.textContent = "已用时 0 秒";
      state.timer = setInterval(() => {
        els.elapsed.textContent = `已用时 ${Math.round((Date.now() - started) / 1000)} 秒`;
      }, 1000);
    } else {
      if (state.cancelBtn && state.cancelBtn.parentNode) {
        state.cancelBtn.parentNode.removeChild(state.cancelBtn);
      }
      state.cancelBtn = null;
      clearInterval(state.timer);
      state.timer = null;
      els.elapsed.hidden = true;
    }
  }

  async function generate() {
    const text = els.textInput.value.trim();
    setError("");

    if (!text) {
      setError("请先粘贴文章正文，或上传 .md / .txt 文件。");
      els.textInput.focus();
      return;
    }
    if (text.length > state.maxInputChars) {
      setError(`文章过长（${text.length} 字），上限 ${state.maxInputChars} 字。请分段处理。`);
      return;
    }

    const token = els.tokenInput.value.trim();
    if (!els.tokenBox.hidden && !token) {
      setError("本站已启用访问口令，请展开「访问口令」填写后再试。");
      return;
    }
    if (token) {
      try {
        localStorage.setItem(STORAGE.token, token);
      } catch (err) {
        /* 忽略 */
      }
    }

    state.controller = new AbortController();
    setLoading(true);

    let gotPlainText = false;
    let httpStatus = 0;

    try {
      const res = await fetch("/api/cards", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ text }),
        signal: state.controller.signal,
      });

      httpStatus = res.status;
      let payload;
      try {
        payload = await res.json();
      } catch (err) {
        gotPlainText = true;
        throw new Error(`服务返回了非 JSON 内容（HTTP ${res.status}）。`);
      }

      if (!res.ok || !payload.ok) {
        throw new Error(payload.error || `请求失败（HTTP ${res.status}）。`);
      }

      state.data = payload.data;
      state.meta = payload.meta || {};
      render(state.data, state.meta);
      saveDraft();
    } catch (err) {
      if (err.name === "AbortError") {
        setError("已取消本次生成。");
      } else if (err instanceof TypeError || gotPlainText) {
        // fetch 抛 TypeError，或收到纯文本响应，都说明请求没能到达应用本身：
        // 要么服务没启动，要么中间的反向代理指到了错误的后端端口
        setError(
          "请求没有到达应用服务。\n\n" +
            "常见原因：\n" +
            "1. 服务端没有启动 —— 在 app 目录执行 node server.js\n" +
            "2. 前面挂了反向代理，但它指向的后端端口不是本应用正在监听的端口" +
            (httpStatus ? `\n\n（本次收到 HTTP ${httpStatus}，响应为纯文本而非 JSON）` : "")
        );
      } else {
        setError(
          `${err.message}\n\n` +
            "若反复失败，请检查服务端 .env 中的 LLM_API_KEY、LLM_BASE_URL 与 LLM_MODEL 是否正确。"
        );
      }
    } finally {
      setLoading(false);
      state.controller = null;
    }
  }

  /* ---------- 事件绑定 ---------- */

  els.uploadBtn.addEventListener("click", () => els.fileInput.click());
  els.fileInput.addEventListener("change", (event) => {
    const file = event.target.files && event.target.files[0];
    if (file) readFile(file);
    event.target.value = "";
  });

  els.clearBtn.addEventListener("click", () => {
    els.textInput.value = "";
    delete els.fileHint.dataset.locked;
    els.fileHint.textContent = "";
    els.cards.textContent = "";
    els.result.hidden = true;
    els.emptyState.hidden = false;
    els.outputActions.hidden = true;
    setError("");
    state.data = null;
    updateCharCount();
    saveDraft();
    els.textInput.focus();
  });

  els.generateBtn.addEventListener("click", generate);
  els.copyBtn.addEventListener("click", async () => {
    if (!state.data) return;
    const ok = await copyText(toMarkdown(state.data));
    showToast(ok ? "Markdown 已复制到剪贴板" : "复制失败，请手动选择内容");
  });
  els.downloadBtn.addEventListener("click", download);

  els.textInput.addEventListener("input", () => {
    delete els.fileHint.dataset.locked;
    els.fileHint.textContent = "";
    updateCharCount();
    clearTimeout(saveDraft._t);
    saveDraft._t = setTimeout(saveDraft, 600);
  });

  els.textInput.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      generate();
    }
  });

  /* ---------- 启动 ---------- */

  try {
    const draft = localStorage.getItem(STORAGE.draft);
    if (draft) els.textInput.value = draft;
  } catch (err) {
    /* 忽略 */
  }
  updateCharCount();
  checkHealth();
})();
