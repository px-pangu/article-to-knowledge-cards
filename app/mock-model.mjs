#!/usr/bin/env node

/**
 * 假模型服务，用于本地测试抽卡链路。
 *
 * 故意返回「被 ```json 代码块包裹」的内容，用来验证服务端的
 * JSON 提取逻辑能正确处理这种情况（真实模型经常这么干）。
 *
 * 用法：node mock-model.mjs [port]
 * 然后让 app 指向它：LLM_BASE_URL=http://127.0.0.1:9911/v1
 */

import http from "node:http";

const port = Number(process.argv[2] || 9911);

const CARD_PAYLOAD = {
  title: "深度工作与浮浅工作",
  genre: "说明文",
  insufficient: false,
  notice: "",
  cards: [
    {
      title: "什么是深度工作",
      core: "深度工作指在无干扰状态下专注进行的职业活动，这种努力能创造新价值、提升技能，且难以复制。",
      explain: "它的关键在于“无干扰”与“高认知投入”两个条件同时成立。正因为它难以复制，才构成个人的竞争壁垒。",
      example: "在无干扰状态下专注完成一项需要动脑的职业活动，即属于深度工作。",
      quiz: "",
    },
    {
      title: "什么是浮浅工作",
      core: "浮浅工作指在受干扰状态下进行的、不需要太多认知努力的事务性任务。",
      explain: "浮浅工作的典型特征是认知投入低、易被打断、价值有限。它会让人显得很忙，但并不等同于产出。",
      example: "",
      quiz: "如果一项任务可以一边开会一边处理，按本文标准它更可能属于哪一类工作？",
    },
    {
      title: "判断任务是否可替代",
      core: "判断一项任务是否属于深度工作，可以看新人能否在短期内学会——若能，则它多半是可替代的浮浅任务。",
      explain: "这条标准把“学习门槛”当作价值的代理指标：门槛低意味着供给充足，因而可替代性高。",
      example: "",
      quiz: "一项只需半天培训就能上手的工作，按本文判断标准属于深度工作还是浮浅工作？",
    },
  ],
  coverage_note: "原文中关于时间管理工具的举例未成卡，因其属于方法细节而非独立知识点。",
};

const server = http.createServer((req, res) => {
  if (req.method !== "POST" || !req.url.endsWith("/chat/completions")) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "mock: 路径不存在" } }));
    return;
  }

  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const parsed = JSON.parse(body || "{}");
    const userMsg = parsed.messages?.find((m) => m.role === "user")?.content || "";
    const systemLen = parsed.messages?.find((m) => m.role === "system")?.content?.length || 0;

    // 关键：故意包一层 ```json 代码块，模拟真实模型的常见行为
    const content = "```json\n" + JSON.stringify(CARD_PAYLOAD) + "\n```";

    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "chatcmpl-mock",
        object: "chat.completion",
        model: parsed.model || "mock",
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { prompt_tokens: Math.round(systemLen / 2), completion_tokens: 400, total_tokens: 0 },
        _mock: { receivedUserChars: userMsg.length, systemPromptChars: systemLen },
      })
    );
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`假模型服务已启动：http://127.0.0.1:${port}/v1/chat/completions`);
});
