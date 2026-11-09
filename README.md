# AutoDrawFlowchart · AI 智能绘图工具

> 公开源码展示版：本仓库不包含下载的 draw.io 编辑器、依赖包和构建产物。
> 运行前需按下方步骤安装依赖并执行 `npm run setup` 下载上游资源；该脚本当前使用
> draw.io 的 `dev` 分支，下载内容可能随上游更新而变化。本公开副本尚未独立验证完整构建流程。

用自然语言描述，AI 自动生成**可编辑**的流程图 / 架构图 / 思维导图 / ER 图 / 组织架构图。

编辑器内核是 **draw.io 开源代码二次开发**（自托管，非 iframe 外链），大模型使用
**DeepSeek V4.1 Flash**（模型 ID `deepseek-flash`），生成的是标准 **draw.io 兼容 XML**，
可直接在 draw.io / diagrams.net 桌面版或网页版中打开继续编辑。

---

## 目录

- [核心特性](#核心特性)
- [快速开始](#快速开始)
- [架构设计](#架构设计)
- [为什么不让大模型直接写 XML](#为什么不让大模型直接写-xml)
- [目录结构](#目录结构)
- [API](#api)
- [配置项](#配置项)
- [测试与验证](#测试与验证)
- [Loop Engineering 开发过程](#loop-engineering-开发过程)
- [已知环境限制](#已知环境限制)
- [许可与致谢](#许可与致谢)

---

## 核心特性

| 能力 | 说明 |
| --- | --- |
| **自然语言生成** | 一句话生成完整图表，自动判断类型（流程 / 架构 / 思维导图 / ER / 组织架构 / 时序 / 网络 / UML）|
| **连续对话改图** | 追问即改图：「加一个风控校验」「改成横向布局」「把 X 改成 Y」，画布实时更新 |
| **增量编辑** | 追问走 `operations` 增量补丁（add/update/remove），不是整图重画，快且不丢你的手动改动 |
| **手动编辑回流** | 你在画布上的改动会同步回服务端，下一轮 AI 修改基于**你看到的图**，而不是旧版本 |
| **自动排版** | 自研 Sugiyama 分层布局（去环 → 分层 → 重心法降交叉 → 紧凑排布），另含树形 / 放射 / 思维导图 / 网格 / 力导向 |
| **零配置可用** | 没配 API Key 也能用：内置离线规则引擎同样生成合法 draw.io XML，UI 与画布功能完全可用 |
| **自我修复** | 模型输出经过校验（ID 唯一、边引用有效、几何重叠、XML 往返一致），失败自动带错误信息重试一次 |
| **优雅降级** | DeepSeek 调用失败不会 500，自动切到离线引擎并在对话里说明原因 |
| **专业 UI** | 深色科技风：玻璃拟态面板、青→靛→紫渐变体系、可拖拽分栏、实时状态栏、流式思考指示 |

---

## 快速开始

### 环境要求

- **Node.js ≥ 20**（开发使用 v26）
- 可选：DeepSeek API Key（<https://platform.deepseek.com/api_keys>）

### 安装

```bash
npm install          # 安装依赖
npm run setup        # 下载并内置 draw.io 编辑器源码（约 62 MB 下载）
npm run build        # 构建后端 + 前端
npm start            # 启动，默认 http://127.0.0.1:5174
```

> `npm run setup` 会从 `jgraph/drawio` 拉取源码，把 `src/main/webapp`
> （编辑器本体，约 139 MB 静态资源）释放到 `web/public/drawio/`。
> 只需要执行一次；产物已加入 `.gitignore`。

### 配置模型

**不限于 DeepSeek** —— 任何 OpenAI 兼容的 `chat/completions` 接口都可以用，包括免费模型。
见下面的 [使用其他模型 / 免费模型](#使用其他模型--免费模型)。

两种配置方式，任选其一：

**A. 环境变量**（推荐用于部署）

```bash
cp .env.example .env
# 编辑 .env，填入 AI_API_KEY=sk-...
```

**B. 界面内设置**（推荐用于本机试用，切换最方便）

打开页面 → 右上角钥匙图标 → 填入 API Key / Base URL / 模型名 → 「保存」→「测试连接」。
Key 只保存在**服务进程内存**中，不写磁盘。**改完立即生效，无需重启。**

未配置时界面会明确提示当前为离线模式，功能不受限。

### 打开

| 地址 | 说明 |
| --- | --- |
| <http://127.0.0.1:5174> | 应用（前后端同源，生产模式）|

---

## 使用其他模型 / 免费模型

应用只依赖 **OpenAI 兼容协议**，所以换模型就是改 `AI_BASE_URL` + `AI_MODEL` 两行。
没有任何硬编码的 DeepSeek 假设：模型名从配置读取，`thinking` / `reasoning_effort`
这两个 DeepSeek 专有字段**只会发给 deepseek.com**，其他厂商不会被塞进不认识的参数。

### 常见免费 / 低价厂商

| 厂商 | Base URL | 模型名示例 | 备注 |
| --- | --- | --- | --- |
| **OpenRouter** | `https://openrouter.ai/api/v1` | `meta-llama/llama-3.3-70b-instruct:free` | 有 20+ 个 `:free` 后缀模型；免费额度约 20 请求/分、50 请求/天 |
| **Groq** | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` | 推理速度极快；免费额度按模型每天 1000–14400 次 |
| **Cerebras** | `https://api.cerebras.ai/v1` | `llama3.3-70b` | 免费额度 token 上限较高 |
| **GitHub Models** | `https://models.inference.ai.azure.com` | `gpt-4o-mini` | 用 GitHub PAT 当 Key，40+ 模型 |
| **DeepSeek（默认）** | `https://api.deepseek.com` | `deepseek-flash` | DeepSeek V4.1 Flash，唯一支持 `thinking` 的厂商 |

> 免费额度、模型名和可用性由各厂商随时调整，请以其官方文档为准。
> 上表的 Base URL 请在使用前再核对一次。

### 以 OpenRouter 为例

```bash
# .env
AI_API_KEY=sk-or-v1-xxxxxxxx
AI_BASE_URL=https://openrouter.ai/api/v1
AI_MODEL=meta-llama/llama-3.3-70b-instruct:free
```

或在界面里：设置 → 填 Key → Base URL 填 `https://openrouter.ai/api/v1` → 模型填上面那个 →
「保存」→「测试连接」。

### 兼容性是怎么保证的

不同厂商对请求字段的支持并不一致，项目用两层机制保证「填上就能用」：

1. **字段按厂商自动开关**
   `thinking` / `reasoning_effort` 只在 `AI_BASE_URL` 指向 `deepseek.com` 时发送。
   想强制打开/关闭用 `AI_THINKING=1` / `AI_THINKING=0`（例如把 DeepSeek 挂在自己的域名后面）。

2. **被拒绝就自动降级重试**（兜底）
   如果某个厂商仍然拒绝了 `thinking`、`reasoning_effort` 或 `response_format`，
   客户端会**只丢掉被拒的那个字段**并立即重试，而不是整个请求失败。
   因此即使遇到没预料到的厂商，也能跑通。

这两条都由 `server/test/provider-compat.test.mjs` 用模拟厂商验证：
包括「拒绝 thinking」「不支持 JSON 模式」「两个都不支持」以及「中途切换端点立即生效」等场景。

### 换模型会影响效果吗

会。本项目对模型能力的要求集中在两点：**遵循 JSON schema** 和**理解层级关系**。
小模型（8B 级）可以正常出图，但节点粒度、分支标签和排版意图会比大模型粗糙。
另外，模型输出的 JSON 会经过校验和一次带错误信息的自动重试，所以即使偶发不合规也不会直接失败。

**如果不想用任何模型**：留空 API Key 即使用内置离线规则引擎，同样能生成 7 类图表并支持连续修改。

---

## 架构设计

```
┌─────────────────────────────────────────────────────────────────────┐
│  浏览器                                                              │
│                                                                     │
│  ┌───────────────────────────────┐   ┌───────────────────────────┐  │
│  │  左：draw.io 编辑器            │   │  右：AI Agent 面板         │  │
│  │  /drawio/index.html?embed=1   │   │  对话 / 建议 / 快速调整    │  │
│  │  &proto=json  (自托管 iframe) │   │  draw.io XML 预览          │  │
│  └───────────▲───────────────────┘   └───────────┬───────────────┘  │
│              │ postMessage JSON 协议              │ HTTPS/JSON       │
│              │  ← load / autosave / export       │                  │
│              └───────────────┬───────────────────┘                  │
│                        React App (App.tsx)                          │
└──────────────────────────────┼──────────────────────────────────────┘
                               │  /api/*
┌──────────────────────────────▼──────────────────────────────────────┐
│  Node / Express 服务端                                               │
│                                                                     │
│  routes/api.ts ──► ai/agent.ts ──► ai/deepseek.ts ──► OpenAI 兼容接口    │
│       │                 │           (DeepSeek / OpenRouter / Groq / …)  │
│       │                 ├──► ai/prompts.ts    （结构化 JSON 提示词）  │
│       │                 ├──► ai/offline.ts    （离线规则引擎）        │
│       │                 └──► drawio/validate.ts（校验 + 增量编辑）    │
│       │                                                             │
│       └──► drawio/mxgraph.ts ──► drawio/styles.ts (draw.io 样式表)    │
│                       └────────► drawio/layout.ts (自研图布局)        │
│                                                                     │
│  产出：标准 mxfile / mxGraphModel XML，可直接在 draw.io 打开          │
└─────────────────────────────────────────────────────────────────────┘
```

### 数据流（一次生成请求）

1. 前端 `POST /api/chart { message, sessionId? }`
2. `agent.plan()` 判断走 DeepSeek 还是离线引擎
3. 构造提示词：**要求模型输出结构化 JSON（DiagramSpec / operations），而不是 XML**
4. `validateSpec()` 校验 → 有错则把**具体错误**回灌给模型重试一次
5. `applyOperations()` 应用增量编辑（追问场景）
6. `runLayout()` 自动排版（模型不产出坐标，避免重叠）
7. `compileToXml()` 编译为 `mxfile` XML
8. 校验 XML 良构性 + 往返一致性（节点/边数量必须吻合）
9. 前端拿到 XML → 通过 `postMessage` 的 `load` 动作送进 draw.io
10. 用户在画布改动 → draw.io `autosave` 事件 → 前端 `PUT /sessions/:id/diagram` 回流

### 关键设计决策

| 决策 | 理由 |
| --- | --- |
| 自托管 draw.io 而非 iframe 外链 | 真正基于开源代码二次开发；离线可用；可换 UI 主题、可改菜单；无外网依赖 |
| 用 Embed JSON 协议通信 | draw.io 官方支持的集成方式，`load` / `autosave` / `export` / `merge` 全套动作齐备，比 fork 编译更稳 |
| 不把 draw.io 交给打包器 | 编辑器是 139 MB 静态资源，Vite/Rollup 处理它只会拖慢构建；作为 `public/` 原样复制 |
| 服务端持有 diagram spec | spec 是唯一事实源；XML 是编译产物。AI 改图改 spec，不解析 XML，避免格式漂移 |
| 模型只输出 JSON | 见下一节 |

---

## 为什么不让大模型直接写 XML

让 LLM 直接产出 mxGraph XML 在演示里可行，在真实使用中会持续踩同样的坑：

| 常见故障 | 后果 |
| --- | --- |
| 边引用了不存在的 `source`/`target` | draw.io 直接丢弃该连线，用户看到的图比预期少 |
| 重复的 cell id | XML 解析异常 / 节点互相覆盖 |
| 未转义的 `&` `<` `"` | XML 非法，编辑器白屏或报错 |
| 手工编造的 `x`/`y` | 节点重叠成一片，完全不可读 |
| 属性名拼错（`fillColor` → `fillcolor`） | 样式静默失效 |

本项目的做法是让模型只负责**它真正擅长的部分**——理解语义、抽取实体关系、组织层次，
然后由确定性代码负责**必须精确的部分**：

```jsonc
// 模型输出（DiagramSpec）——不关心坐标和 XML
{
  "kind": "flowchart",
  "title": "订单支付流程",
  "nodes": [
    { "id": "submit",   "label": "提交订单", "role": "start" },
    { "id": "stock",    "label": "库存是否充足", "role": "decision" },
    { "id": "pay",      "label": "调用支付网关", "role": "service" },
    { "id": "db",       "label": "订单库", "role": "database" }
  ],
  "edges": [
    { "source": "submit", "target": "stock" },
    { "source": "stock",  "target": "pay", "label": "是" },
    { "source": "stock",  "target": "db",  "label": "否", "line": "dashed", "accent": "rose" }
  ]
}
```

编译管线负责：ID 去重 → 悬空边剔除 → 自动分层排版 → 角色配色 → 转义 → 生成合法 XML → 往返校验。
**结果是「生成的图一定是合法且排版整洁的 draw.io 文件」，而不是「大概率能打开」。**

追问场景同理，模型输出增量操作：

```jsonc
{ "operations": [
    { "op": "add_node", "node": { "id": "risk", "label": "风控校验", "role": "decision" } },
    { "op": "add_edge", "edge": { "source": "submit", "target": "risk" } }
] }
```

---

## 目录结构

```
AutoDrawFlowchart/
├── server/                         # 后端（Express + TypeScript）
│   ├── src/
│   │   ├── index.ts                # 入口：API + 静态资源（导入无副作用）
│   │   ├── config.ts               # 配置与运行时设置（模型 = deepseek-flash）
│   │   ├── routes/api.ts           # REST API
│   │   ├── store/sessions.ts       # 会话 / 对话 / 当前 spec
│   │   ├── ai/
│   │   │   ├── agent.ts            # 编排：选引擎、校验、修复、降级
│   │   │   ├── deepseek.ts         # DeepSeek 客户端（OpenAI 兼容 + JSON 模式）
│   │   │   ├── prompts.ts          # 结构化输出提示词 + 设计规则
│   │   │   └── offline.ts          # 离线规则引擎（无 Key 可用）
│   │   ├── drawio/
│   │   │   ├── types.ts            # DiagramSpec / EditOp 类型定义
│   │   │   ├── mxgraph.ts          # ⭐ Spec → draw.io XML 编译器 + 反向解析
│   │   │   ├── styles.ts           # draw.io 样式词表与配色
│   │   │   ├── layout.ts           # 自研图布局（分层/树/放射/思维导图/网格/力导向）
│   │   │   └── validate.ts         # 校验 + 增量编辑
│   │   └── util/logger.ts
│   └── test/
│       ├── run.mjs                        # 进程内测试运行器
│       ├── tiny-test.mjs                  # 最小测试库（避免 spawn）
│       ├── mxgraph.test.mjs               # 编译器 19 项
│       ├── drawio-bridge.test.mjs         # postMessage 协议 13 项
│       ├── offline.test.mjs               # 离线规则引擎 19 项
│       └── app-integration.dom.test.mjs   # React + 真实 HTTP 集成 10 项
│
├── web/                            # 前端（React + TypeScript）
│   ├── index.html
│   ├── vite.config.mjs             # Vite（可用时）
│   ├── build.mjs                   # 构建入口：Vite 优先，失败自动降级 Rollup+tsc
│   ├── public/drawio/              # ⭐ 自托管 draw.io 编辑器（npm run setup 生成）
│   └── src/
│       ├── App.tsx                 # 应用外壳与状态编排
│       ├── main.tsx
│       ├── components/
│       │   ├── Header.tsx          # 顶栏：标题、供应商状态、导出
│       │   ├── EditorPane.tsx      # draw.io iframe 宿主 + 空状态 + 画布工具条
│       │   ├── AgentPanel.tsx      # AI 面板：消息、快速调整、示例
│       │   ├── MessageList.tsx     # 消息气泡、建议 chips、XML 预览
│       │   ├── Composer.tsx        # 输入框（Enter 发送 / IME 安全）
│       │   ├── SettingsModal.tsx   # API Key / 模型 / 运行模式
│       │   ├── StatusBar.tsx       # 底部实时状态
│       │   ├── Toasts.tsx
│       │   └── Icons.tsx           # 内联 SVG 图标
│       ├── lib/
│       │   ├── drawio.ts           # ⭐ draw.io Embed 协议封装（DrawioBridge）
│       │   ├── api.ts              # 类型化 API 客户端
│       │   └── hooks.ts
│       └── styles/global.css       # 设计系统（tokens + 组件样式）
│
├── tools/
│   ├── fetch-drawio.mjs            # 下载+校验 draw.io 源码
│   ├── extract-drawio.mjs          # 解包 webapp → web/public/drawio
│   ├── smoke-api.mjs               # API 冒烟（30 项）
│   ├── verify.mjs                  # 全链路验证（43 项）
│   ├── demo.mjs                    # 打印一次真实生成的完整 XML
│   ├── demo-offline.mjs            # 逐条验证离线编辑指令
│   └── e2e.mjs                     # 真实浏览器 E2E（需浏览器）
│
├── docs/ARCHITECTURE.md            # 深入设计文档
├── .env.example
└── package.json                    # npm workspaces
```

---

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/health` | 健康检查 + 当前供应商 / 模型 / 编辑器信息 |
| `GET` | `/api/settings` | 当前 AI 设置（**不含** Key 明文）|
| `POST` | `/api/settings` | 运行时切换 Key / 模型 / 地址 / 在线离线 |
| `POST` | `/api/settings/test` | 测试 DeepSeek 连通性 |
| `GET` | `/api/examples` | 示例提示词 |
| `POST` | `/api/chart` | ⭐ **核心**：自然语言 → draw.io XML |
| `GET` | `/api/sessions` `· /:id` | 会话列表 / 详情（含对话历史）|
| `DELETE` | `/api/sessions/:id` | 删除会话 |
| `PUT` | `/api/sessions/:id/diagram` | 画布改动回流（用户手动编辑）|
| `GET` | `/api/sessions/:id/spec` | 取当前 diagram spec 与摘要 |
| `POST` | `/api/sessions/:id/operations` | 直接应用增量操作（不调模型）|
| `POST` | `/api/render` | spec → XML（编程调用）|
| `POST` | `/api/parse` | XML → spec（往返）|

<details>
<summary><code>POST /api/chart</code> 示例</summary>

```bash
curl -s http://127.0.0.1:5174/api/chart \
  -H 'content-type: application/json' \
  -d '{"message":"画一个用户登录流程图：输入账号密码，校验格式，查询用户是否存在，验证密码是否正确"}' \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(j.reply);console.log(j.summary);console.log(j.xml.slice(0,400))})"
```

响应（截断）：

```jsonc
{
  "sessionId": "…",
  "revision": 1,
  "xml": "<mxfile host=\"app.diagrams.net\" …><diagram …><mxGraphModel …>…",
  "spec": { "kind": "flowchart", "nodes": [ … ], "edges": [ … ] },
  "summary": { "title": "用户登录", "kind": "flowchart", "nodes": 9, "edges": 8, "width": 470, "height": 1350 },
  "reply": "已生成「用户登录」，共 9 个节点。",
  "suggestions": ["加一个失败分支", "改成浅色主题"],
  "provider": "deepseek",         // 或 "offline"
  "model": "deepseek-flash",
  "latencyMs": 5231,
  "warnings": [],                 // 被剔除的悬空边等
  "diagnostics": { "attempts": 1, "repairs": [], "warnings": [], "droppedOperations": [] }
}
```

</details>

---

## 配置项

见 [`.env.example`](.env.example)。常用：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `AI_API_KEY` | 空 | **任何** OpenAI 兼容厂商的 Key；留空则走离线引擎 |
| `AI_BASE_URL` | `https://api.deepseek.com` | 换成其他厂商即可切换模型 |
| `AI_MODEL` | `deepseek-flash` | 厂商的模型 ID，原样发送 |
| `AI_THINKING` | 自动 | `thinking` 字段开关；留空＝仅 deepseek.com 发送 |
| `AI_REASONING_EFFORT` | `medium` | `low` / `medium` / `high` |
| `AI_MAX_TOKENS` | `8192` | 复杂图可调高，避免 JSON 被截断 |
| `AI_OFFLINE` | `0` | 设为 `1` 强制离线 |
| `PORT` / `HOST` | `5174` / `127.0.0.1` | 监听地址 |
| `SERVE_STATIC` | `1` | 由本服务托管前端构建产物 |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |

> 旧版 `DEEPSEEK_*` 变量名**仍然兼容**（已有的 `.env` 不用改），同时设置时 `AI_*` 优先。

---

## 测试与验证

本项目采用 **Loop Engineering**：每个阶段都自己跑验证，发现报错立即修复。
所有验证都可在**无浏览器、无网络、无 API Key** 的环境下运行。

```bash
npm test          # 快速层：编译器 19 + 协议 13 + 离线引擎 19 + 厂商兼容 8 = 59 项
npm run test:all  # 全部：再加 React + 真实 HTTP 集成 10 项 = 69 项
npm run smoke     # API 冒烟测试（30 项，需服务已启动）
npm run verify    # 全链路验证（43 项：构建产物 / 编辑器 / API / 往返 / 静态资源）
npm run e2e       # 真实浏览器 E2E（需可用的浏览器）
```

### 测试分层与结果

| 层 | 文件 | 覆盖 | 结果 |
| --- | --- | --- | --- |
| 编译器单测 | `mxgraph.test.mjs` | XML 良构、往返、转义、布局不重叠、ID 去重与去冲突、悬空边、校验器、增量编辑、思维导图放射布局、60 节点链式布局 | **19/19** |
| 协议单测 | `drawio-bridge.test.mjs` | `init` 前排队、autosave 回声过滤、`requestXml`/`exportAs` 关联、异常来源忽略、畸形消息、`spinner`/`status`/`fit` 动作、dispose | **13/13** |
| 离线引擎单测 | `offline.test.mjs` | 7 类图均可编译且往返一致、标题抽取、不重复终止节点、无孤立节点、全部编辑指令（增/删/改/布局/主题）、**无法理解的修改不破坏原图** | **19/19** |
| 厂商兼容单测 | `provider-compat.test.mjs` | 用模拟厂商验证：非 DeepSeek 端点不发 `thinking`、DeepSeek 端点会发、厂商拒绝 `thinking` 时自动降级、不支持 JSON 模式时自动降级、两者都拒绝仍成功、模型 ID 取自配置、**中途切换端点立即生效** | **8/8** |
| 集成（DOM） | `app-integration.dom.test.mjs` | 真实 `<App/>` + 真实 HTTP + 真实编译器：启动拉取、iframe 地址、生成、连续编辑、错误请求不崩、设置弹窗、快速调整、导出入口 | **10/10** |
| API 冒烟 | `tools/smoke-api.mjs` | 健康、创建、编辑、会话、同步、往返、错误处理 | **30/30** |
| 全链路 | `tools/verify.mjs` | 构建产物、draw.io 编辑器完整性、API、生成 XML 自洽性（无悬空边/ID 唯一/无重叠坐标）、多轮编辑、往返、静态资源与编辑器可达 | **43/43** |

演示脚本（需服务已启动）：

```bash
node tools/demo.mjs            # 打印一次真实生成请求的完整 draw.io XML
node tools/demo-offline.mjs    # 逐个验证离线编辑指令，并确认无法理解时不破坏原图
```

> 测试运行器 `server/test/run.mjs` 是自研的**进程内**运行器。
> 原因：Node 自带 `node --test` 会为每个测试文件 spawn 子进程，在禁止 spawn
> 的环境里直接失败；自研运行器同时提供了精确的用例计数、名称/文件过滤与逐用例超时。

---

## Loop Engineering 开发过程

按「先跑通最小闭环，再逐步补齐，每步自验证」推进，实际经过以下循环：

| 循环 | 目标 | 自验证方式 | 过程中发现并修复的真实缺陷 |
| --- | --- | --- | --- |
| **0. 调研** | 摸清 draw.io 代码结构与集成方式 | 联网检索 + 直接读上游源码 `js/bootstrap.js` / `js/diagramly/App.js` | 确认 `embed=1&proto=json` 协议；确认 hostname 判断**只是提示**，自托管可用 |
| **1. 取源码** | 内置编辑器 | 解包后校验必需文件存在 | ① Git 在本机 schannel 证书不可用 → 改用 Node 下载；② 下载 64,787,285 B **gzip 尾部 CRC 损坏**导致 `tar` 中止 → 改为先流式解压成 `.tar` 再解包；③ `strip` 层级差 1，解出多一层 `webapp/` |
| **2. 最小闭环** | 自然语言 → 合法 XML | `smoke-api.mjs` | ① 标签解析**先剥标签后解实体**，把用户写的 `<tag>` 吃掉了 → 先解实体、只剥 draw.io 自身标签；② sublabel 的 `<div style="…">` 引号未转义，**截断了 XML 属性** → 增加属性级转义；③ 重复 ID 时 `idMap` 被后写覆盖，导致边指向错误节点 |
| **3. AI 层** | DeepSeek + 离线双引擎 | 编译 + 调用链检查 | ① 局部变量 `edge` 遮蔽同名辅助函数，导致语法错误 → 重命名；② `Error.cause` 不能作为参数属性 → 改名 `sourceError` |
| **4. 前端** | 编辑器 + AI 面板 | 构建 + 类型检查 | ① 本机 **esbuild 不可用（spawn EPERM）**，Vite 无法启动 → 新增 Rollup + TypeScript 编译器 API 的纯 JS 构建回退；② `.mjs` 配置仍被 esbuild 打包 → 确认并保留回退路径 |
| **5. 协议** | postMessage 桥接 | `drawio-bridge.test.mjs` | ① **`init` 之前就发送 `load`**（协议违规且有竞态）→ 未握手前排队；② `exportAs` 把原始报文（含 `event`/`format`）直接返回给 UI → 只提取 `data`/`xml` |
| **6. 集成** | 真实 React + 真实 HTTP | `app-integration.dom.test.mjs` | ① 渲染期 `scrollIntoView` 不存在会**打断整个 effect** → 加可选调用保护；② **导入 `index.ts` 就会监听端口**，测试无法起独立实例 → 拆出 `start()` 并只在作为入口时调用 |
| **7. 全链路** | 交付物端到端 | `verify.mjs` | ① 压缩后响应没有 `content-length`，用头判断大小失败 → 改测实际响应体字节数 |
| **8. 离线引擎加固** | 离线模式也必须是可用产品 | 新增 `offline.test.mjs`（19 项） | ① **离线编辑返回了 `operations` 却从未被应用**：回复说「已重命名」而画布没变 → 新增 `resolvePlanSpec()` 统一「spec / operations / 无变更」三条路径；② **节点 id 与边 id 共用 `e1..eN` 时生成重复 cell id**，读取时节点被边覆盖（ER 图 4 个节点只剩 1 个）→ 节点与边共用一个 id 空间；③ `attr()` 正则用 `(?:^\|\s)`，导致取 `x` 时误匹配 `exitX` → 改为 `\b` 词边界；④ 「改成从左到右」被「加」字误判为添加节点 → 意图判定改为优先级排序，`add` 放最后；⑤ 引号内标签抽取引用了 `{1,30}?` 惰性量词使配对失败 → 改贪婪 + 反向引用；⑥ 请求含「加 A 和 B 之间」时锚点被引号包裹而无法捕获 → 先剥离引号再匹配；⑦ 无法理解的修改会**重新生成并丢掉用户的图** → 有图时一律不重建，除非用户明确要求换类型；⑧ 步骤里已有「结束」时又追加一个 → 过滤终止性步骤；⑨ 「主题是 X」被截断成「主题」 → 优先识别主题句式 |
| **9. 多厂商支持** | 除 DeepSeek 外可用任意 OpenAI 兼容 / 免费模型 | 新增 `provider-compat.test.mjs`（8 项，模拟厂商） | ① `thinking` / `reasoning_effort` **无条件发送**，Groq 等厂商会 400 → 按 base URL 主机名自动开关，并保留 `AI_THINKING` 强制开关；② 遇到不认识的字段**整个请求失败** → 新增按字段降级重试（只丢掉被拒的那个字段）；③ 环境变量名绑定 DeepSeek，换厂商语义不通 → 引入 `AI_*` 中性名，`DEEPSEEK_*` 保留为别名；④ 测试中发现 **DOM 测试导入期就安装 `window`/`document`**，导致 OpenAI SDK 认为「浏览器环境」而拒绝发请求 → 改为按需安装 + teardown 还原；⑤ `useToasts` 的计时器在组件卸载后仍 `setState` → 加存活标志位并在 teardown 卸载 React 根 |

### 复现验证

```bash
npm run build
npm run test:all
npm start &                      # 或另开终端
npm run verify -- --url http://127.0.0.1:5174
```

---

## 已知环境限制

本次开发环境有两处限制，项目对此做了适配，**在正常环境不受影响**：

1. **无法 spawn 子进程**（`spawn EPERM`）
   - `esbuild` / `vite` / `node --test` / Playwright 启动浏览器均依赖 spawn。
   - 适配：`web/build.mjs` 在 Vite 不可用时自动改用 **Rollup + TypeScript 编译器 API**（纯 JS，进程内）；
     测试改用自研进程内运行器；E2E 支持 `--cdp` 连接已运行的浏览器。
   - 正常环境下 `npm run build` 会走 Vite，`npm run dev:vite` 可启用 Vite HMR。

2. **无可用浏览器自动化**
   - 因此界面正确性由 `app-integration.dom.test.mjs`（linkedom + 真实 React + 真实 HTTP）覆盖，
     它验证启动、渲染、请求、状态流转与错误处理；
     **CSS / 布局 / 绘制**仍需 `npm run e2e` 在真实浏览器中确认。

> 说明：**应用本身完全不依赖上述任何能力** —— 它只是一个 Express 服务 + 静态资源 + 浏览器端 postMessage 通信。

---

## 许可与致谢

- 本项目代码：**Apache-2.0**
- **draw.io**（`jgraph/drawio`，Apache-2.0）—— 编辑器内核，本项目在其开源代码之上做集成与二次开发（自托管、嵌入协议封装、主题与交互定制）
- **DeepSeek** —— 提供 `deepseek-flash`（DeepSeek V4.1 Flash）模型服务

使用 draw.io 时请遵守其许可与商标要求；本项目与 JGraph Ltd / draw.io AG 无隶属关系。
