# Netlify 部署指南

把本应用部署到 Netlify（含后端抽卡功能）。

---

## 先理解一个关键点

**Netlify 是静态托管平台，默认跑不了 Node 服务。**

如果你只上传 `public/` 目录，服务端接口不会有：

| 请求 | 结果 |
|---|---|
| `/` | **200** 页面正常显示 |
| `/api/cards` | **404** ← 服务端抽卡失效 |

原因：`public/` 里只有静态文件，没有后端。服务端代调模型必须走 Functions，
纯静态托管不会执行任何服务端代码。

**两条路可选：**

| | Functions 版（本指南） | 纯静态拖拽上传 |
|---|---|---|
| 做法 | 关联 Git 仓库 + Functions | 只把 `public/` 目录拖上去 |
| 密钥 | 存 Netlify 环境变量，不暴露 | 存**每个访客自己浏览器**的 localStorage |
| 谁提供 API Key | 站点主人 | 每个用户自己（页面「模型配置」里填） |
| 长文章 | 受免费版 10 秒执行限制 | 无执行限制（浏览器直连模型） |
| 适合 | 公开给别人用的站点 | 自己一个人用 |

纯静态路径的原理：前端探测不到 `/api` 时会**自动切换为「浏览器直连模式」**，
页面弹出「模型配置」面板，访客填自己的接口地址、模型名与 API Key
（只保存在本机浏览器，不进代码不上传），之后浏览器直接调模型接口完成抽卡。
注意必须上传 `public/` 的**全部 6 个文件**（`core.mjs` 与两个 prompt 文件同级），
漏传会提示「提示词文件加载失败」。

**解决办法（Functions 版）**：本仓库已经做好了，你只需要按下面配置。

---

## 部署步骤

### 1. 推送代码

确保仓库里包含这些新增文件：

```
netlify.toml                          ← 必须在【仓库根目录】
app/core.mjs                          ← 抽卡核心逻辑（三种部署方式共用）
app/prompt-bundle.mjs                 ← 提示词（由 sync-prompt.mjs 生成）
app/netlify/functions/api.mjs         ← 无服务器函数入口
app/test-netlify.mjs                  ← 本地校验脚本
```

### 2. 配置 Netlify

在 Netlify 后台，**Site configuration → Build & deploy** 填：

| 项 | 值 |
|---|---|
| Base directory | **留空**（必须是仓库根目录） |
| Build command | **留空**（本项目零依赖、无构建步骤） |
| Publish directory | `app/public` |
| Functions directory | `app/netlify/functions` |

> **为什么 base 必须留空？**
> 函数需要 `import` 上一级目录的 `app/core.mjs` 和 `app/prompt-bundle.mjs`。
> 若 base 设成 `app/`，函数目录之外的模块不会被 Netlify 打包，
> 线上会报 `Cannot find module`。这一点很容易踩坑。

### 3. 设置环境变量

**Site configuration → Environment variables**，至少两个：

| 变量 | 说明 | 示例 |
|---|---|---|
| `LLM_BASE_URL` | 模型接口地址 | `https://api.deepseek.com/v1` |
| `LLM_API_KEY` | 你的密钥 | `sk-xxxxxxxx` |

公网部署**强烈建议**再加一个：

| 变量 | 说明 |
|---|---|
| `APP_TOKEN` | 访问口令。设置后，页面需输入口令才能抽卡 |

可选：

| 变量 | 默认 | 说明 |
|---|---|---|
| `LLM_MODEL` | `deepseek-chat` | 模型名 |
| `LLM_JSON_MODE` | `1` | 是否要求模型输出 JSON |
| `MAX_INPUT_CHARS` | `60000` | 文章字数上限 |
| `ATTEMPT_BUDGET_MS` | `8000` | 全部重试的时间预算（见下方限制说明） |

**密钥安全性**：`LLM_API_KEY` 只存在 Netlify 服务端，浏览器拿不到，
也不会出现在前端代码或构建产物里。这一点与自托管版本完全一致。

### 4. 重新部署

改完环境变量需要 **Trigger deploy** 才会生效。

---

## 部署前先本地验证

不要等上线才发现问题。在 `app/` 目录下运行：

```bash
# 提供环境变量后运行（Windows Git Bash 示例）
export LLM_BASE_URL=https://api.deepseek.com/v1
export LLM_API_KEY=sk-xxxx
node test-netlify.mjs
```

它会检查 19 项，包括**部署最容易失败的一环**——函数 import 的模块能否解析：

```
[1] 依赖与打包完整性
  ✓  函数文件存在
  ✓  函数 import 的 2 个模块都能解析
  ✓  提示词已同步（prompt-bundle.mjs 不旧于 SKILL.md）
[3] 路由分发
  ✓  GET /api/health 返回 200
  ...
[6] 真实抽卡
  ✓  耗时 2.7s，5 张卡片
  ✓  耗时在平台时限内（< 8 秒有安全余量）
```

---

## 平台限制（务必了解）

### 执行超时

| 版本 | 单次执行上限 |
|---|---|
| Netlify 免费版 | **10 秒** |
| Netlify Pro | 26 秒 |

抽卡实测：短文章 1.5-3 秒，长文章 4-8 秒。**大部分情况够用，但有两个风险**：

1. **长文章**可能超 10 秒；
2. **首次失败触发重试**时，3 次尝试累计可能超时。

针对第 2 点，代码里加了**时间预算保护**（`ATTEMPT_BUDGET_MS`，默认 8 秒）：
预算耗尽就停止重试，返回**可读的提示**（HTTP 504 + 具体建议），
而不是撞平台超时变成难懂的 502。

### 什么时候该改用自托管

如果你需要：

- 处理超长文章（不受 10 秒限制）
- 稳定的大流量（无冷启动、无并发限制）
- 接本地模型（如 Ollama，Netlify 访问不到你的内网）

**改用自托管版本**（`app/server.js`）。功能完全相同，
且抽卡规则、提示词、核心逻辑都是一份代码。

---

## 两套部署方式的关系

```
                    skills/make-knowledge-cards/SKILL.md
                                  │  唯一规则真源
                                  │  node sync-prompt.mjs
                    ┌─────────────┴─────────────┐
                    ▼                           ▼
          prompt-skill.md              prompt-bundle.mjs
        （自托管用 fs 读）            （Netlify 打包时 import）
                    │                           │
                    └─────────────┬─────────────┘
                                  ▼
                             app/core.mjs
                      （抽卡核心：拼提示词 → 调模型 → 校验结果）
                                  │
                    ┌─────────────┴─────────────┐
                    ▼                           ▼
              app/server.js            app/netlify/functions/api.mjs
             （自托管单端口）              （Netlify 无服务器）
```

**关键设计**：
- 抽卡规则只有一份真源（SKILL.md），两套部署都从它同步
- 核心逻辑只有一份（core.mjs），两套部署共用
- 前端请求路径完全一致（`/api/cards`、`/api/health`），
  **前端代码不需要为部署方式做任何分支判断**

---

## 排障

| 现象 | 原因 | 解决 |
|---|---|---|
| `/api/*` 全部 404 | 只上传了静态文件，没有函数 | 确认 `netlify.toml` 在仓库根，且 Functions 目录配对了 |
| 部署日志报 `Cannot find module` | base 设成了 `app/` | base 改为留空（仓库根） |
| `/api/health` 说 `mode: unconfigured` | 没配 `LLM_API_KEY` | 在环境变量里添加后重新部署 |
| 抽卡 504 超时 | 文章过长或触发重试超时限 | 分段处理，或改用自托管版本 |
| 改了 SKILL.md 但规则没生效 | 忘了同步 | `node sync-prompt.mjs` 后重新部署 |

改动规则后**必须**重新部署（Netlify 不会自动感知 SKILL.md 的变化）。
