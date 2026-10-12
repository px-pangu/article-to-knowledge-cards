# 文章转知识卡片 · 网页应用

把 [make-knowledge-cards](../skills/make-knowledge-cards/) Skill 包成的一个网页应用，
支持**三种部署方式**：自托管（Node 单端口）、Netlify（无服务器函数）、
纯静态托管（GitHub Pages / 任意静态空间，浏览器直连模型）。

粘贴一篇文章，把文章连同 `SKILL.md` 一起发给大模型，返回结构化的 5-8 张知识卡片，
前端渲染成卡片并支持复制 / 下载 Markdown。

**零依赖**：只用 Node 内置模块，不需要 `npm install`，不需要数据库，不写任何文件到磁盘。

> **部署到 Netlify？** 见 [DEPLOY-NETLIFY.md](DEPLOY-NETLIFY.md)。
> 走 Functions（服务端代调模型，密钥不暴露）；如果只是把 `public/` 拖拽上传，
> 页面会自动进入「浏览器直连模式」，也能用 —— 详见下表第三列。

---

## 三种部署方式

| | 自托管（推荐） | Netlify Functions | 纯静态托管 |
|---|---|---|---|
| 入口 | `server.js` | `netlify/functions/api.mjs` | 上传 `public/` 目录 |
| 运行方式 | Node 常驻进程 | 无服务器函数 | 无后端，浏览器直连模型 |
| 执行时限 | 无 | 免费版 10 秒 / Pro 26 秒 | 无（受模型接口本身限制） |
| API Key | 存服务端 `.env` | 存 Netlify 环境变量 | 存**用户浏览器** localStorage |
| 密钥暴露面 | 无（最安全） | 无 | 无（不进代码不上传，但浏览器里可见） |
| 适合 | 自有服务器、长文章、大流量、接本地模型 | 快速上线、多人使用 | 自己用、不想管服务器 |
| 核心逻辑 | 共用 `core.mjs` | 共用 `core.mjs` | 共用 `core.mjs`（`public/core.mjs`） |
| 抽卡规则 | 共用 SKILL.md | 共用 SKILL.md | 共用 SKILL.md |

前两种方式**接口路径完全一致**（`/api/cards`、`/api/health`）。

第三种方式：前端启动时探测 `./api/health`，探测不到服务端就自动切换为
「浏览器直连模式」—— 打开「模型配置」面板填自己的接口地址、模型名与 API Key
（保存在本机浏览器），抽卡请求由浏览器直接发往模型接口，**不经过任何中间服务器**。
DeepSeek 与 OpenAI 的接口均允许浏览器直连（CORS 已验证）。

### 纯静态托管怎么传

把 `public/` 目录里的**全部 6 个文件**上传到静态空间的根目录（或任一子目录）：

```
public/
├── index.html                # 页面
├── style.css                 # 样式
├── app.js                     # 前端逻辑（双模式）
├── core.mjs                   # 抽卡核心逻辑（浏览器直连用）
├── prompt-skill.md            # 抽卡规则（浏览器直连用）
└── prompt-output-contract.md  # JSON 输出契约（浏览器直连用）
```

这些文件**必须同级**（前端用相对路径 `./` 引用，子目录部署也不会 404）。
上传后打开页面，状态栏显示「浏览器直连 · 模型名」即部署成功。

---

## 它和 Skill 的关系

抽卡规则**只有一份真源**，就是 `skills/make-knowledge-cards/SKILL.md`。

```
skills/make-knowledge-cards/SKILL.md   ← 唯一的规则文件（Skill 与 App 共用）
              │
              │  node sync-prompt.mjs
              ▼
app/prompt-skill.md                   ← 同步产物（自托管版启动时读入内存）
app/prompt-bundle.mjs                 ← 同步产物（Netlify 版打包时 import）
app/prompt-output-contract.md         ← 把「输出 Markdown」改成「输出 JSON」
app/public/core.mjs                   ← 副本（浏览器直连模式 import 的抽卡逻辑）
app/public/prompt-skill.md            ← 副本（浏览器直连模式 fetch 的抽卡规则）
app/public/prompt-output-contract.md   ← 副本（浏览器直连模式 fetch 的输出契约）
```

因此：**改抽卡规则只需改 SKILL.md**，然后跑一次同步脚本、重启服务（或重新部署），
代码一行都不用动。

> 为什么要生成两份？自托管版用 `fs` 读 `.md`；而 Netlify 打包时只带上
> 被 `import` 的模块，运行时的 `fs.readFileSync` 读不到 `.md`，
> 所以必须有一份能 import 的 `.mjs`。两份内容逐字相同，由同一脚本生成。

`output-contract.md` 是唯一的适配层 —— Skill 原本输出 Markdown 给人看，网页应用需要 JSON 给程序用。
该文件明确要求模型「除输出格式外，SKILL.md 的全部规则继续完全适用」。

---

## 运行环境

| 项 | 要求 |
| --- | --- |
| Node.js | **18 或以上**（用到内置 `fetch`），推荐 20/22 LTS |
| 依赖 | 无 |
| 数据库 | 无 |
| 内存 | 约 50 MB |
| 出网 | 需要能访问你配置的大模型接口 |

检查版本：`node --version`

---

## 本地运行

```bash
cd app

# 1. 同步抽卡规则（首次必须执行，否则服务拒绝启动）
node sync-prompt.mjs

# 2. 准备配置
cp .env.example .env
#    编辑 .env，至少填 LLM_API_KEY

# 3. 启动
node server.js
```

打开 `http://127.0.0.1:8787`。

Windows 下也可以直接双击 **`start.bat`** —— 它会自动找到 Node、同步规则、启动服务，
并在服务真正就绪后自动打开浏览器。再双击一次也不会启动第二个服务：端口被占用时
会识别出「已经在运行」，直接帮你把页面打开。

> **想更省事**：把 `start.bat` 右键 →「发送到」→「桌面快捷方式」，以后双击桌面图标即可。
> 图标可用 `icon.ico`。

### 出问题了先跑诊断

```bash
node doctor.mjs
```

它会按「配置 → 规则同步 → 端口 → 接口响应 → 模型连通性」逐环检查，
在**第一处断裂点**停下并给出修复命令。比对着报错猜要快得多：

```
[1] 运行环境      ✓  Node 22.22.2
[2] 配置文件      ✗  LLM_API_KEY 为空
                     修复：在 .env 中填写 LLM_API_KEY
[3] 抽卡规则      ✓  prompt-skill.md 已同步（6070 字符）
[4] 服务端口      ✓  127.0.0.1:8787 正在监听
[5] 接口响应      ✓  健康接口返回正常 JSON
```

### 先不花钱验证一遍

不想立刻消耗模型额度，可以先跑演示模式 —— 它返回固定示例卡片，**不调用模型**，
用来确认「网页 → 服务端 → 渲染」整条链路是通的：

```bash
# Linux / macOS
DRY_RUN=1 node server.js

# Windows PowerShell
$env:DRY_RUN="1"; node server.js

# 或直接
npm run dry-run
```

页面右上角会显示「演示模式」，卡片区出现 3 张示例卡片即表示部署成功。

---

## 配置项

全部通过 `app/.env` 设置（服务启动时自动读取，已存在的系统环境变量优先）。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址。挂反代时建议改 `127.0.0.1` 只允许本机访问 |
| `APP_TOKEN` | 空 | 访问口令。**公网部署务必填写**，否则任何人可消耗你的模型额度 |
| `LLM_BASE_URL` | `https://api.deepseek.com/v1` | 模型接口地址，OpenAI 兼容协议 |
| `LLM_MODEL` | `deepseek-chat` | 模型名 |
| `LLM_API_KEY` | 空 | 模型密钥。留空时抽卡接口会明确报错 |
| `LLM_JSON_MODE` | `0` | 设为 `1` 时传 `response_format=json_object`，可降低解析失败率 |
| `LLM_TIMEOUT_MS` | `180000` | 单次调用超时（毫秒） |
| `MAX_INPUT_CHARS` | `60000` | 单篇文章字数上限 |
| `DRY_RUN` | `0` | 设为 `1` 进入演示模式 |

### 常见模型接口

| 服务 | `LLM_BASE_URL` | `LLM_MODEL` 示例 |
| --- | --- | --- |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| 阿里云百炼（通义千问） | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |
| 月之暗面 Kimi | `https://api.moonshot.cn/v1` | `moonshot-v1-32k` |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-plus` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o` |
| 本地 Ollama | `http://127.0.0.1:11434/v1` | `qwen2.5:14b` |

用 Ollama 时数据完全不出机器，`LLM_API_KEY` 填任意非空值即可（如 `ollama`）。

---

## 部署到自己的服务器

以 Ubuntu / Debian 为例，其他发行版把包管理器命令换掉即可。

### 1. 装 Node

```bash
# NodeSource 官方源（推荐 22 LTS）
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version
```

### 2. 上传代码

```bash
# 方式一：直接 clone
git clone https://github.com/px-pangu/article-to-knowledge-cards.git
cd article-to-knowledge-cards/app

# 方式二：只传 app 目录
scp -r ./app user@your-server:/opt/ato-card
```

放好之后：

```bash
cd /opt/ato-card      # 或 article-to-knowledge-cards/app
node sync-prompt.mjs
cp .env.example .env
nano .env             # 填 LLM_API_KEY，公网部署再填 APP_TOKEN
chmod 600 .env        # 密钥文件只有属主可读
```

### 3. 用 systemd 常驻

新建 `/etc/systemd/system/ato-card.service`：

```ini
[Unit]
Description=Article to Knowledge Cards
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/ato-card
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

启用：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now ato-card
sudo systemctl status ato-card
sudo journalctl -u ato-card -f      # 看日志
```

### 4. 反向代理与 HTTPS

**方案 A：Caddy（推荐，自动申请并续期证书）**

`/etc/caddy/Caddyfile`：

```
your-domain.com {
    reverse_proxy 127.0.0.1:8787
}
```

```bash
sudo systemctl reload caddy
```

**方案 B：Nginx + certbot**

```nginx
server {
    listen 80;
    server_name your-domain.com;

    client_max_body_size 2m;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # 抽卡可能耗时 30 秒以上，必须放宽超时，否则会 504
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
```

```bash
sudo certbot --nginx -d your-domain.com
```

### 5. 绑定域名

1. 在域名服务商处添加 **A 记录**：`your-domain.com` → 你的服务器公网 IP
2. 等 DNS 生效（通常几分钟）：`dig +short your-domain.com`
3. 用 Caddy 或 certbot 签发 HTTPS 证书（见上）

> **国内服务器注意**：若服务器在中国大陆，80/443 端口对外提供服务需要完成 **ICP 备案**，
> 否则会被拦截。中国香港等境外服务器无此限制，但访问速度取决于线路。

配置完成后，把 `HOST` 改为 `127.0.0.1` 并重启服务，让应用只接受来自反代的请求。

---

## 更新抽卡规则

改完 `skills/make-knowledge-cards/SKILL.md` 之后：

```bash
node sync-prompt.mjs   # 同步到 app/prompt-skill.md
sudo systemctl restart ato-card
```

规则改动**不需要改任何代码**。`output-contract.md` 只在「数据格式」层面适配，不参与抽卡判断。

---

## 自检

服务跑起来后，用内置的脚本逐项检查：

```bash
# 环境诊断：配置 / 目录结构 / 规则同步 / 端口 / 接口 / 模型连通性
node doctor.mjs

# 冒烟检查：模拟浏览器完整链路，用真文章真实抽卡（会消耗模型额度）
node test-smoke-check.mjs http://127.0.0.1:8787

# 端到端校验：29 项接口行为（启用了 APP_TOKEN 时把口令作为第二个参数）
node test-e2e-check.mjs http://127.0.0.1:8787

# JSON 容错修复的单元测试：17 项，含真实坏样本
node test-repair-json.mjs

# 真机压测：连续抽卡，统计成功率与自动重试次数（会消耗模型额度）
node test-stress-check.mjs http://127.0.0.1:8787 8

# Netlify 部署校验：打包完整性 + 函数行为（部署前跑，会消耗额度）
export LLM_BASE_URL=https://api.deepseek.com/v1 LLM_API_KEY=sk-xxxx
node test-netlify.mjs

# 纯静态托管校验：同级资源 + 相对路径 + 自动切换浏览器直连 + 真实抽卡（会消耗额度）
node test-static-check.mjs
```

也可以用 npm 简称（在 `app/` 目录下）：`npm run doctor` / `smoke` / `e2e` / `test:json` / `stress` / `netlify` / `static`。

**遇到问题先跑 `doctor.mjs`** —— 它会在第一处断裂点停下并给出修复命令。

四个脚本的分工：

| 脚本 | 回答的问题 | 是否消耗额度 |
|---|---|---|
| `test-smoke-check.mjs` | 用户真实操作能走通吗？ | 是（真实抽卡 2 次） |
| `test-e2e-check.mjs` | 接口行为都正确吗？ | 否（配合 mock 更是零消耗） |
| `test-repair-json.mjs` | JSON 容错逻辑还对吗？ | 否 |
| `test-netlify.mjs` | 部署到 Netlify 能跑起来吗？ | 是（真实抽卡 1 次） |

`test-netlify.mjs` 专门检查**部署最容易失败的一环**：函数 `import` 的模块
能否被解析（Netlify 打包时若模块在函数目录之外，线上会报 `Cannot find module`），
以及提示词是否忘了同步。**部署前务必先跑它。**

`test-e2e-check.mjs` 覆盖健康接口、静态资源、抽卡主流程、字段完整性、Markdown 导出、
错误处理（空输入 / 超长 / 路径穿越 / 错误方法）与口令拦截，全部通过时退出码为 0。

`test-smoke-check.mjs` 是**最接近用户真实体验**的一项：它先确认首页和静态资源能加载，
再用一篇信息充足的文章真实抽卡，验证卡片数落在 5-8 区间、字段完整；
最后用一段信息不足的短文确认**没有为了凑数而注水**。

`test-stress-check.mjs` 的第二个参数是执行次数（默认 8）。它依次用四类文体
（说明文 / 操作教程 / 观点评论 / 信息不足）真实调用模型，逐次打印卡片数、耗时，
以及是否靠「自动重试」救回，最后给出成功率汇总。它是判断**规则与 JSON 稳定性**的
主要手段 —— 单次成功不足以说明问题，连续多次通过才算稳定。

### 不想消耗模型额度测试主流程

`mock-model.mjs` 是一个假模型服务，按 OpenAI 协议返回固定卡片，
且**故意把 JSON 包在 ```json 代码块里** —— 用来验证服务端能正确处理这种情况：

```bash
node mock-model.mjs 9911                             # 终端 A

PORT=8788 \
LLM_BASE_URL=http://127.0.0.1:9911/v1 \
LLM_API_KEY=mock \
LLM_MODEL=mock-model \
node server.js                                        # 终端 B

node test-e2e-check.mjs http://127.0.0.1:8788        # 终端 C
```

---

## 目录结构

```
app/
├── core.mjs                   # 抽卡核心逻辑（三种部署方式共用）
├── server.js                  # 自托管入口：静态托管 + /api/cards + /api/health
├── prompt-skill.md            # 抽卡规则，由 SKILL.md 同步而来，勿手改
├── prompt-bundle.mjs          # 同上内容，供 Netlify 打包 import，勿手改
├── prompt-output-contract.md  # JSON 输出契约（唯一的适配层）
├── sync-prompt.mjs            # SKILL.md → prompt-skill.md + prompt-bundle.mjs + public/ 副本
├── doctor.mjs                 # 一键诊断：逐环检查并指出断裂点
├── DEPLOY-NETLIFY.md          # Netlify 部署指南
├── icon.ico                   # 应用图标（多尺寸，桌面快捷方式用）
├── netlify/
│   └── functions/
│       └── api.mjs            # Netlify 无服务器函数入口
├── test-smoke-check.mjs       # 冒烟：模拟浏览器完整链路（真实抽卡）
├── test-e2e-check.mjs         # 端到端校验（29 项）
├── test-repair-json.mjs       # JSON 容错修复单元测试（17 项）
├── test-stress-check.mjs      # 真机压测：多轮抽卡，统计成功率与重试
├── test-netlify.mjs           # Netlify 打包完整性 + 函数行为校验（19 项）
├── test-static-check.mjs      # 纯静态托管校验（22 项）
├── mock-model.mjs             # 假模型服务
├── package.json               # 零依赖，仅定义脚本
├── start.bat                  # Windows 一键启动（自动定位 Node、开浏览器）
├── .env.example               # 配置模板（复制为 .env 使用）
└── public/                    # 上传静态托管时把整个目录传上去（6 个文件同级）
    ├── index.html
    ├── style.css
    ├── app.js                 # 双模式前端（服务端 / 浏览器直连）
    ├── core.mjs               # 抽卡逻辑副本（浏览器直连用）
    ├── prompt-skill.md        # 抽卡规则副本（浏览器直连用）
    └── prompt-output-contract.md
```

**结构约定**：除前端三件套在 `public/` 里，其余文件**全部平铺在 `app/` 根目录**，
不再有 `prompts/`、`scripts/`、`tests/` 子目录。文件按用途用前缀区分：
`prompt-*` 是提示词、`test-*` 是校验脚本、其余为运行所需。
唯一的子目录是 `netlify/functions/`（Netlify 要求函数放在指定文件名下）。

> `public/` 是**唯一对外暴露**的目录。`server.js`、`.env`、`prompt-*.md`
> 都是它的同级文件，因此无法通过 URL 下载到 —— 这一点有 e2e 用例守护。

---

## 接口

### `GET /api/health`

```json
{
  "ok": true,
  "mode": "live",
  "model": "deepseek-chat",
  "baseUrl": "https://api.deepseek.com/v1",
  "promptChars": 7913,
  "maxInputChars": 60000,
  "tokenRequired": false,
  "uptimeSec": 42
}
```

### `POST /api/cards`

请求：

```json
{ "text": "文章正文……" }
```

带口令时加请求头：`Authorization: Bearer <APP_TOKEN>`

成功响应：

```json
{
  "ok": true,
  "data": {
    "title": "深度工作与浮浅工作",
    "genre": "说明文",
    "insufficient": false,
    "notice": "",
    "cards": [
      {
        "no": 1,
        "title": "什么是深度工作",
        "core": "……",
        "explain": "……",
        "example": "……"
      }
    ],
    "coverageNote": "……"
  },
  "meta": { "mode": "live", "model": "deepseek-chat", "elapsedMs": 18320, "inputChars": 412 }
}
```

失败响应：`{ "ok": false, "error": "可读的中文错误说明" }`

| 状态码 | 含义 |
| --- | --- |
| 400 | 文本为空、JSON 非法 |
| 401 | 口令缺失或错误 |
| 413 | 文本超出 `MAX_INPUT_CHARS` |
| 502 | 模型接口报错、超时，或返回的数据不符合契约 |
| 500 | 服务端配置问题（如未填 `LLM_API_KEY`） |

---

## 常见问题

**页面能打开，但点「生成知识卡片」后报「请求没有到达应用服务」**
这条错误表示前端拿到的不是 JSON，而是纯文本 —— 说明请求被**中间层的反向代理**拦下了，
没有到达应用。最常见的原因是：反向代理配置指向了一个**不是本应用在监听的端口**。
先跑 `node doctor.mjs` 确认，再看反代配置里的 `proxy_pass` / `reverse_proxy` 地址。

**报「无法连接到服务」**
服务没启动。在 `app` 目录执行 `node server.js`（Windows 可双击 `start.bat`）。

**启动时报「缺少提示词文件」**
首次运行必须执行 `node sync-prompt.mjs`。它会把 SKILL.md 复制到 `app/prompt-skill.md`。

**页面能打开，但抽卡返回 500「未配置 LLM_API_KEY」**
`.env` 里没填密钥，或填好后没重启服务。注意 `.env` 里等号两侧不要留空格，
密钥整串复制，前后不要带引号。

**返回 401，提示「模型拒绝了密钥」**
`LLM_API_KEY` 填错了，或该密钥已被吊销。去模型服务商控制台重新生成一个。

**返回 402，提示「账户余额不足」**
模型账户没钱了，需要充值。

**返回 404，提示「接口地址或模型名不对」**
`LLM_BASE_URL` 或 `LLM_MODEL` 不匹配。注意 `LLM_BASE_URL` 要写到版本号那一层
（如 `https://api.deepseek.com/v1`），服务会自动拼 `/chat/completions`，**不要**自己把
`/chat/completions` 写进去。

**返回 502，错误信息是「模型未返回可解析的 JSON」或「JSON 无法解析」**
模型输出了不合法 JSON。服务已内置两层防护：

1. **自动重试**：最多尝试 3 次，每次略微提高 temperature 以跳出相同的错误模式
2. **容错修复**：自动修补三类常见错误 —— 中文文本里误用英文直引号、尾随逗号、字符串内裸换行

若仍失败，通常是模型能力不足。建议：换用更强的模型，或确认 `.env` 中已开启
`LLM_JSON_MODE=1`（DeepSeek、OpenAI、阿里云百炼支持）。

**卡片内容里引号变成了 `"` 而不是中文引号**
这是模型生成时用了英文直引号的缘故。`output-contract.md` 已明确要求使用中文引号，
容错修复会保证 JSON 能解析成功、内容不丢失，但不改写引号本身。

**返回 502，错误信息是「无法连接模型接口」**
服务器出网受限，或 `LLM_BASE_URL` 写错了。用 `curl` 直接测一下该地址是否可达。
注意 `LLM_BASE_URL` 要写到版本号那一层（如 `.../v1`），服务会自动拼 `/chat/completions`。

**Nginx 反代后抽卡 504**
`proxy_read_timeout` 默认 60 秒，抽卡经常更久。按上面的配置改成 300 秒。

**复制按钮在 http 下不生效**
浏览器只在 HTTPS 或 localhost 下提供剪贴板接口。代码里已内置降级方案（`execCommand`），
若仍失败，请按上面的步骤配好 HTTPS。

**会不会把我的文章存下来**
不会。服务不写数据库、不落盘、不记录请求内容，请求处理完即释放。
唯一的出网请求是发往你自己配置的 `LLM_BASE_URL`。若用本地 Ollama，数据完全不出机器。

---

## 已知限制

- 不支持网页抓取、PDF、图片、Office 文档 —— 只能输入纯文本（粘贴或 .md / .txt）
- 不支持 Anki `.apkg` 导出（卡片 JSON 转 `.apkg` 是纯脚本活，可另行添加）
- 无用户系统、无历史记录、无并发限流。若对外公开使用，建议在反代层加限流
- 单次请求非流式，长时间等待期间页面只显示已用时；如需逐字返回可改用 SSE
