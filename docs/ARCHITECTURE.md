# 架构与实现细节

本文档记录 AutoDrawFlowchart 的设计决策、数据契约与实现要点。
面向需要继续开发或审查该代码库的人。

---

## 1. 分层与依赖方向

```
        ┌──────────────────────────────────────────┐
        │  web/src  (React UI)                     │
        │  只依赖 lib/api.ts 与 lib/drawio.ts       │
        └───────────────┬──────────────────────────┘
                        │ HTTP / postMessage
        ┌───────────────▼──────────────────────────┐
        │  server/src/routes  (HTTP 边界)           │
        │  只做校验、会话读写、响应整形              │
        └───────────────┬──────────────────────────┘
                        │
        ┌───────────────▼──────────────────────────┐
        │  server/src/ai  (编排 + 模型/离线引擎)     │
        │  不了解 HTTP，只处理「请求 → spec」        │
        └───────────────┬──────────────────────────┘
                        │ DiagramSpec
        ┌───────────────▼──────────────────────────┐
        │  server/src/drawio  (纯函数编译管线)       │
        │  types → layout → styles → mxgraph        │
        │  无 I/O，完全可单测                        │
        └──────────────────────────────────────────┘
```

**关键点**：`drawio/` 层是纯函数、无 I/O、无网络。
整个「画图正确性」都集中在这里，因此可以用单元测试完整覆盖——
这也是本项目能在无浏览器环境下高置信度验证的核心原因。

---

## 2. 数据契约

### 2.1 DiagramSpec（模型输出 / 会话事实源）

```ts
interface DiagramSpec {
  kind?: 'flowchart' | 'architecture' | 'mindmap' | 'sequence'
       | 'er' | 'orgchart' | 'uml' | 'network' | 'generic';
  title?: string;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  layout?: 'layered' | 'tree' | 'radial' | 'mindmap' | 'grid' | 'force' | 'none';
  direction?: 'TB' | 'BT' | 'LR' | 'RL';
  theme?: 'nebula' | 'blueprint' | 'light';
}

interface DiagramNode {
  id: string;            // 必需、唯一
  label: string;         // 必需
  sublabel?: string;
  shape?: NodeShape;     // rect|rounded|ellipse|diamond|hexagon|cylinder|cloud|…
  role?: NodeRole;       // start|end|process|decision|data|database|service|…
  accent?: NodeAccent;   // blue|cyan|violet|green|amber|rose|slate|none
  x?: number; y?: number;         // 省略 → 自动排版
  width?: number; height?: number;
  style?: string;        // 逃生口：原始 draw.io style 片段
  parent?: string;       // 容器节点
}

interface DiagramEdge {
  id?: string;
  source: string; target: string;   // 必须指向已存在的 node.id
  label?: string;
  style?: 'orthogonal' | 'straight' | 'curved' | 'entity';
  arrow?: 'classic' | 'open' | 'block' | 'none' | 'diamond';
  line?: 'solid' | 'dashed' | 'dotted';
  accent?: NodeAccent;
  animated?: boolean;
  exitX?: number; exitY?: number; entryX?: number; entryY?: number;
}
```

设计取舍：

- **`role` 与 `shape` 分离**。`role` 表达语义（这是「决策」还是「数据库」），`shape` 表达几何。
  模型只需给 `role`，配色与形状自动派生（`styles.ts` 的 `ROLE_ACCENT` / `ROLE_SHAPE`），
  这样生成的图**整体风格一致**，而不是每条节点随机配色。
- **坐标可选**。模型给坐标通常重叠严重；省略坐标交给布局引擎是默认且推荐路径。
- **`style` 作为逃生口**。需要精细控制时可直接注入 draw.io 原生 style 片段，与原样式合并（后者覆盖前者）。

### 2.2 EditOp（追问场景）

```ts
type EditOp =
  | { op: 'add_node'; node: DiagramNode }
  | { op: 'add_edge'; edge: DiagramEdge }
  | { op: 'update_node'; id: string; patch: Partial<DiagramNode> }
  | { op: 'update_edge'; id: string; patch: Partial<DiagramEdge> }
  | { op: 'remove_node'; id: string }      // 级联删除相关边
  | { op: 'remove_edge'; id: string }
  | { op: 'set_title'; title: string }
  | { op: 'replace_all'; spec: DiagramSpec };
```

`applyOperations()` 的容错策略：**未知 ID 跳过并记录原因，绝不抛错**。
一个部分错误的计划仍然产出一张可用的图，而不是整个请求失败。

---

## 3. 编译管线（`mxgraph.ts`）

```
DiagramSpec
   │
   ├─ resolveGraph()
   │    1. IdFactory.claim()    单一 id 空间：节点与边共用（见下）
   │    2. 记录 logical id → cell id 映射（首个占用者获胜，避免覆盖）
   │    3. 边端点解析；未知端点 / 自环 → 丢弃并写入 warnings
   │    4. needsLayout?  → runLayout()
   │    5. findOverlaps() → 未排版且有重叠时给出提示
   │
   ├─ compileToXml()
   │    6. 节点：nodeStyle() → escapeXml(toLabelHtml(label, sublabel))
   │    7. 边：  edgeStyle() → escapeXml(toLabelHtml(label))
   │    8. 组装 mxfile / diagram / mxGraphModel(root: id=0, id=1)
   │
   └─ validateCompilation()
        9. assertWellFormed()      自研栈式良构校验
       10. parseDrawioXml()        反向解析
       11. 节点/边数量必须与编译结果一致，否则报 error
```

#### 不变量：节点与边共用一个 id 空间

draw.io 要求同一个 model 内 cell id 全局唯一，而业务 spec 完全可能给节点和边
起相同的名字 —— ER 模板就同时用了 `e1..eN`。若节点与边各用一个 `IdFactory`，
就会产出重复 cell id；任何按 id 建 Map 的读取方（包括本项目的反向解析器）
都会**让边覆盖掉节点**（ER 图 4 个实体只剩 1 个可见）。

因此 `resolveGraph()` 只创建一个 `IdFactory`：先 claim 所有节点 id，再 claim 边 id。
这条不变量由 `mxgraph.test.mjs` 的「cell ids are unique」与
`offline.test.mjs` 的「7 类图往返一致」共同守护。

### 3.1 转义规则（曾出过真实 bug 的地方）

draw.io 的 `value` 属性**内容是 HTML**（因为 `html=1`）。因此存在**两层转义**：

```ts
// 第一层：用户文本 → HTML 片段。转义 &<> 但保留我们自己的标记。
toLabelHtml(label, sublabel)
  → escapeXml(label) + '<div style="font-size:10px;…">' + escapeXml(sublabel) + '</div>'

// 第二层：整个 HTML 片段 → XML 属性值。必须连引号一起转义，
// 否则上面那段自带的双引号会提前结束 value="…"。
escapeXml(toLabelHtml(...))   // quotes: true（默认）
```

反向解析 `fromLabelHtml()` 的顺序同样有讲究：
**先解码实体，再只剥离 draw.io 自身产生的标签**（`br`/`div`/`span`/`font`/…）。
如果先剥标签，用户写的字面量 `<tag>`（已被转义为 `&lt;tag&gt;`）会被连带删掉。

### 3.2 布局引擎（`layout.ts`）

自研实现，零依赖。核心是 Sugiyama 风格的分层布局：

| 阶段 | 算法 | 说明 |
| --- | --- | --- |
| 1. 去环 | 迭代式 DFS | 指回栈内节点的边标记为反向；只影响分层视图，不移动语义 |
| 2. 分层 | Kahn 拓扑 + 最长路径松弛 | 每个节点位于其最深前驱的下一层 → 产生自然的「自上而下流动」 |
| 3. 降交叉 | 重心法（barycentre），默认 8 轮交替扫描 | 相邻层交替排序，显著减少连线交叉 |
| 4. 排布 | 逐层紧凑排布 + 公共脊线居中 | 同层沿交叉轴依次摆放，各层以最长层为基准居中 |

另提供专用模式：

- `treeLayout`：自顶向下整洁树，子树占据连续区间（组织架构图）
- `mindmapLayout`：根居中、一级分支绕椭圆均匀分布、二级分支向外偏移（思维导图）
- `radialLayout`：BFS 环状（网络拓扑）
- `forceLayout`：Fruchterman-Reingold 变体（关系图）
- `gridLayout`：网格；也是 `layout: 'none'` 但坐标缺失时的兜底

`findOverlaps()` 用轴对齐包围盒 + padding 做重叠检测，供校验器与编译器复用。

### 3.3 样式词表（`styles.ts`）

三套主题（`nebula` 深色科技 / `blueprint` 浅色 / `light`），每套 8 个强调色，
每个强调色是 `{fill, stroke, text}` 三元组。角色 → 强调色、角色 → 形状各有一张映射表。

`nodeStyle()` 与 `edgeStyle()` 输出**逐段拼接的 draw.io 原生 style 串**，
最后经 `dedupe()` 按 key 去重（后者覆盖前者），所以调用方注入的 `style` 能覆盖默认值。

产出示例：

```
whiteSpace=wrap;html=1;rounded=1;arcSize=14;fillColor=#0e1e3a;strokeColor=#3b82f6;
strokeWidth=2;shadow=1;shadowColor=#000000;shadowOpacity=45;fontColor=#cfe2ff;
fontSize=13;fontFamily=Inter, Helvetica, Arial, sans-serif;align=center;verticalAlign=middle;
```

---

## 4. AI 层

### 4.1 双引擎

| 引擎 | 触发条件 | 产出 |
| --- | --- | --- |
| **DeepSeek** | 存在 API Key 且未强制离线 | 模型返回 JSON spec / operations |
| **离线规则引擎** | 无 Key、强制离线、或 DeepSeek 调用失败 | 确定性关键词解析 → 8 类图模板 |

`providerMode()` 是唯一判定入口，返回 `{ mode, reason }`，`reason` 会展示在 UI 与健康检查里，
便于排查「为什么现在是离线」。

**降级而非失败**：`agent.plan()` 捕获 DeepSeek 异常后切换到离线引擎，
并在 `reply` 开头加 `⚠️` 说明原因，同时写入 `diagnostics.fallback`。
用户始终拿到一张可编辑的图。

### 4.2 提示词要点（`prompts.ts`）

- 明确给出 **JSON schema 文档**（字段、枚举、必需性）
- 10 条**设计规则**：不产出坐标、必须给 `role`、决策要用 diamond、
  分支边必须带标签、ID 命名规范、节点数量区间、**标签语言跟随用户语言**……
- 明确告知可用 `replace_all` 的边界（仅在用户要求重做时）
- **必须包含 "json" 字样**：DeepSeek JSON 模式（`response_format: {type:'json_object'}`）的硬性要求
- 区分创建提示词（要 `spec`）与编辑提示词（要 `operations`，并附当前图摘要）

### 4.3 自我修复循环

```
尝试 1 ──► 模型 ──► 解析 JSON ──► 构造 spec ──► validateCompilation()
   ▲                                                   │
   │                                          有 error? │
   └──────────── 把「具体错误清单」回灌 ◄────────────────┘
                     （最多 2 次尝试）
```

回灌的是**结构化错误**（`code: message` 列表），例如：

```
- edge-target-unknown: edge target "ghost" is not a node id
- node-id-duplicate: duplicate node id "dup"
```

同时处理三类模型异常：

| 异常 | 处理 |
| --- | --- |
| JSON 不可解析 | 提示「只返回一个 JSON 对象」并重试 |
| 空响应 | DeepSeek JSON 模式已知问题；退避重试（400/800ms） |
| `finish_reason: 'length'` | 明确报「token 预算不足，请调高 `DEEPSEEK_MAX_TOKENS`」，不伪装成语法错误 |
| 编辑轮只返回自然语言、没有 `operations` | 明确要求返回 `operations` |

### 4.4 离线规则引擎（`offline.ts`）

不是「假数据」，而是**确定性可用的生成器**：

1. `detectKind()` 用关键词正则判断图表类型（思维导图 / 组织架构 / 架构 / 时序 / ER / 网络 / UML / 流程）
2. `trimTopic()` 抽取标题：剥离「画一个/帮我生成」动词 → 在首个图表类型词处截断 → 在首个标点处截断 → 限长
3. `splitSteps()` 按编号、连接词、标点切分步骤
4. 按类型套用模板（流程含决策分支、架构含网关/缓存/队列、思维导图放射、ER 带基数…）
5. 编辑场景 `offlineEdit()` 支持：「在 A 和 B 之间加 X」「删除 X」「把 X 改成 Y」「改横向/浅色」

因此离线模式下**功能闭环完整**：能生成、能追问修改、能编辑画布、能导出。

---

## 5. 前端

### 5.1 draw.io Embed 协议封装（`lib/drawio.ts`）

`DrawioBridge` 类独占所有 `postMessage`，React 组件不直接接触协议。它负责：

| 关注点 | 实现 |
| --- | --- |
| **握手** | 未收到 `init` 前**不发送**任何消息，`post()` 自动入队，`init` 时 flush（协议要求，且避免帧内监听器尚未安装的竞态）|
| **来源校验** | 只接受来自自己 iframe `contentWindow` 的消息，忽略其他窗口 |
| **请求/响应关联** | `waitFor(event)` 按事件名挂起 promise，带超时；`load`/`export`/`merge` 各自等待对应事件 |
| **回声过滤** | 记录 `loadedXml`；editor 回报的 autosave 若与之一致则视为自己触发的加载，不当作「用户编辑」 |
| **生命周期** | `dispose()` 移除监听、拒绝所有挂起 promise（避免泄漏） |
| **`exportAs` 整形** | 只返回 `{data, xml}`，不把 `event`/`format` 等协议字段泄漏进 UI |

iframe URL 由 `editorUrl()` 统一构造：

```
/drawio/index.html?embed=1&proto=json&spin=1&libraries=1
                  &noSaveBtn=1&noExitBtn=1&saveAndExit=0&ui=dark&lang=zh
```

### 5.2 编辑器 → 服务端回流

用户手动改动 → draw.io 触发 `autosave`（加载时以 `autosave: 1` 开启）→
前端比对 `expectedXml` 判定是否为真实用户编辑 → `PUT /api/sessions/:id/diagram`。

服务端把 XML 反解析回 spec（`layout: 'none'`，保留用户坐标），
于是**下一轮 AI 修改的起点就是用户当前看到的图**。
回流失败只记静默（下一轮从上一状态开始），不打断用户。

### 5.3 状态编排（`App.tsx`）

- 所有跨组件状态集中在 `App`，子组件保持无状态/受控
- `inFlight` ref 防止并发提交（UI 与请求双保险）
- 乐观插入用户消息气泡，网络请求返回后补上助手消息
- 通过 `data-testid="app-state"` 暴露一份机器可读状态（provider / busy / 节点数 / XML 长度…），
  供 E2E 断言使用，避免测试去抓界面文案

### 5.4 设计系统（`styles/global.css`）

- **Token 优先**：颜色、圆角、阴影、动效、字号全部是 CSS 变量，集中在 `:root`
- **暗色科技风**：`#070b14` 深空底 + 三层径向辉光 + 48px 网格遮罩（`mask-image` 渐隐）
- **玻璃拟态**：`backdrop-filter: blur(20px) saturate(150%)` 用于顶栏 / 面板 / 悬浮工具条
- **青→靛→紫渐变**作为品牌与状态强调色
- **可访问性**：`:focus-visible` 键盘焦点环、`aria-*` 标注、`prefers-reduced-motion` 降级
- **响应式分栏**：可拖拽分隔条（`role="separator"`），双击复位

---

## 6. 构建系统

`web/build.mjs` 是构建入口，两级策略：

```
esbuild 可用？ ──是──► vite build（主路径，正常环境）
      │
      否
      ▼
rollup + TypeScript 编译器 API（回退路径，纯 JS、进程内）
  1. 用 ts.transpileModule() 把 src/**/*.tsx? 转成 ESM 到 .build-tmp/
  2. rollup 打包（node-resolve + commonjs + 自研 css 插件）
  3. 自研 cssPlugin 拦截 .css：从 src/ 真实路径读取，输出单个 assets/app.css
  4. 用源码 index.html 生成产物 HTML（注入 hashed bundle 与 css）
  5. copyPublic() 把 public/（含 draw.io）复制进 dist/
```

回退路径存在的唯一原因：`esbuild` 需要 spawn 一个 helper 进程，
在禁止 spawn 的环境里 Vite 连启动都不能。两条路径产物等价（同样的 hashed bundle + css + draw.io）。

---

## 7. 测试策略

### 7.1 为什么需要自研运行器

| 方案 | 问题 |
| --- | --- |
| `node --test` | 每个测试文件 spawn 一个子进程 |
| `run({ files: [...] })` | 同样 spawn |
| `run({ files: [] })` | 进程内可用，但只产出 summary 事件，**拿不到逐用例的通过/失败**，且 `testNamePatterns` 不过滤已注册的用例 |

因此 `server/test/tiny-test.mjs` 提供一个最小 `node:test` 兼容层
（`test` / `it` / `describe` + 属性挂载），由模块定制钩子把 `node:test` 重定向过去。
`server/test/run.mjs` 负责收集、过滤（名称或文件名正则）、逐用例超时、计数与报告。
行为已用「故意失败的探针测试」验证过退出码正确。

### 7.2 分层

| 层 | 是否需要浏览器 | 是否需要网络 |
| --- | --- | --- |
| 编译器单测 / 协议单测（`*.test.mjs`）| 否 | 否 |
| DOM 集成（`*.dom.test.mjs`）| 否（linkedom + 真实 React）| 否（本地 ephemeral 端口）|
| API 冒烟 / 全链路验证 | 否 | 否 |
| E2E（`tools/e2e.mjs`）| **是** | 否 |

DOM 集成测试的输入驱动方式：**直接调用 React 挂在节点上的 `onChange` / `onClick`**
（从 `__reactProps$…` expando 读取），而不是合成事件。
原因是 linkedom 不能可靠地把冒泡事件投递给 React 的委托根监听器，
而该测试的目标是验证**我们组件自身的逻辑**（状态、副作用、请求、渲染），
浏览器事件管线交给 `tools/e2e.mjs`。

---

## 8. 扩展指南

| 想做什么 | 改哪里 |
| --- | --- |
| 增加图形（新 `shape`） | `drawio/types.ts` 的 `NodeShape` + `styles.ts` 的 `SHAPE_KEY` / `defaultSize` |
| 调整配色 | `drawio/styles.ts` 的 `NEBULA` / `BLUEPRINT` 调色板 |
| 新布局算法 | `drawio/layout.ts` 加函数并在 `runLayout()` 的 switch 中注册 |
| 改模型行为 | `ai/prompts.ts` 的 `DESIGN_RULES` / schema 文档 |
| 换模型 | `.env` 的 `DEEPSEEK_MODEL`，或界面上直接改（无需改代码）|
| 持久化会话 | 实现 `store/sessions.ts` 的同名接口（已是 async 形态），换掉内存 Map |
| 增加图表类型 | `types.ts` 的 `DiagramKind` + `offline.ts` 模板 + `prompts.ts` 的 `guessKind` |
| 编辑器 UI 定制 | 覆盖 `web/public/drawio/js/PostConfig.js`（draw.io 官方定制入口）|

---

## 9. 安全考虑

- **API Key 不落盘**：界面输入的 Key 只存服务进程内存；`.env` 已加入 `.gitignore`
- **Key 不回显**：`/api/settings` 只返回 `hasApiKey` 与来源，绝不返回明文
- **XML 注入**：所有用户/模型文本经 `escapeXml` 双重转义，控制字符被剥离
- **iframe 来源校验**：只处理来自自己 iframe 窗口的 postMessage
- **iframe sandbox**：`allow-scripts allow-same-origin`（draw.io 需要）但不含 `allow-top-navigation`
- **错误边界**：错误统一为 `{error:{code,message}}`；不把内部堆栈返回给前端
