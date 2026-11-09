/**
 * Offline diagram engine.
 *
 * Produces real, editable Diagrams without any network access. This exists so
 * the app has a working end-to-end loop before an API key is configured (and so
 * the UI can be demonstrated/tested hermetically). It is a deterministic
 * heuristic parser, not a language model — it recognises intent keywords, pulls
 * out a topic and any enumerated steps, then emits a well-structured spec.
 *
 * Whenever a DeepSeek key is present this module is bypassed entirely.
 */
import type { AgentPlan, DiagramEdge, DiagramKind, DiagramNode, DiagramSpec, EditOp } from '../drawio/types.js';

// ---------------------------------------------------------------------------
// Language helpers
// ---------------------------------------------------------------------------

/** Splits a request into candidate step phrases on the usual separators. */
function splitSteps(text: string): string[] {
  // Requests usually start with a preamble naming the diagram:
  //   "画一个电商下单支付流程图：用户提交订单，校验库存…"
  // Everything before the first colon/，after the diagram-type keyword is
  // instruction, not a step — drop it so step 1 is not the whole preamble.
  let body = text;
  const head = DIAGRAM_WORD_RE.exec(body);
  if (head) {
    const afterKeyword = body.slice(head.index + head[0].length);
    const boundary = /[：:，,。.]/.exec(afterKeyword);
    if (boundary) body = afterKeyword.slice(boundary.index + 1);
  }

  const normalised = body
    // enumerated lists: 1. 2) 3、 (1) etc.
    .replace(/(?:^|\s)(?:\(?\d{1,2}\)?[.、)）])\s*/g, '\n')
    // explicit sequencing words
    .replace(/(?:然后|接着|之后|其次|最后|再|并且|同时|->|→|=>|,|，|;|；|\n)+/g, '\n');

  const cleaned = normalised
    .split('\n')
    .map((s) => s.trim())
    // Drop any remaining leading instruction words so we keep the content words.
    .map((s) => s.replace(/^(?:请|帮我|帮忙|生成|画|绘制|创建|做|来|一个|一张|个|张)\s*/g, '').trim())
    // A leading diagram-type keyword can still survive (e.g. no colon present).
    .map((s) => {
      const m = DIAGRAM_WORD_RE.exec(s);
      return m && m.index === 0 ? s.slice(m[0].length).replace(/^[：:，,。.\s]+/, '').trim() : s;
    })
    .filter((s) => s.length > 1 && s.length <= 40);

  // "判断库存是否充足，充足则创建支付单" produces a decision plus an outcome that
  // only restates the branch. Keep the decision (it becomes a diamond with
  // labelled edges) and drop the redundant outcome clause.
  const OUTCOME_PREFIX = /^(是|否|对|不对|可以|不可以|充足|不足|成功|失败|通过|不通过|允许|不允许)/;
  const CONDITION_WORD = /(是否|能否|有没有|能否|判断|检查|校验|验证|如果)/;
  return cleaned.filter((step, i) => {
    if (i === 0) return true;
    if (!OUTCOME_PREFIX.test(step)) return true;
    const previous = cleaned[i - 1];
    if (!CONDITION_WORD.test(previous)) return true;
    // The decision's own subject must appear in the outcome clause for it to be
    // a restatement (e.g. "库存" appears in both).
    const subject = previous.replace(/.*?(是否|能否|有没有)/, '').replace(/[？?。.]/g, '').slice(0, 4);
    return !(subject.length >= 2 && step.includes(subject));
  });
}

const DIAGRAM_WORD_RE =
  /(流程图|架构图|思维导图|组织架构图|脑图|时序图|拓扑图|结构图|类图|状态图|用例图|ER\s*图|er\s*图|流程|架构|diagram|flowchart|mind\s*map)/i;

/**
 * Pull a short, human-readable title out of the request.
 *
 * Strategy: drop the leading "画一个/帮我生成" verb, cut at the first
 * diagram-type keyword ("用户登录流程图：…" -> "用户登录"), then cut at the first
 * clause separator. Falls back to a character cap so titles stay chip-sized.
 */
function trimTopic(text: string): string {
  let t = text
    .replace(/^(?:请|帮我|帮忙|麻烦|可以|能否|我想|我要)?\s*/g, '')
    .replace(/^(?:生成|画|绘制|创建|做|来|设计|输出|整理|梳理)\s*/g, '')
    .replace(/^(?:一)?(?:个|张|幅|份)\s*/g, '')
    .trim();

  // "…，主题是产品规划" / "…，主题为X" names the topic explicitly — prefer it.
  const explicit = /主题(?:是|为|：|:)\s*([^，,。.；;\n]{1,30})/.exec(t);
  if (explicit) return cap(explicit[1].trim());

  // The diagram-type keyword is never part of the subject; cut there.
  const kw = DIAGRAM_WORD_RE.exec(t);
  if (kw && kw.index > 0) t = t.slice(0, kw.index);
  else if (kw && kw.index === 0) t = t.slice(kw[0].length).trim();

  // Everything after the first clause boundary is instruction, not topic.
  t = (t.split(/[：:，,。.；;\n（(]/)[0] ?? t).trim();
  t = t.replace(/[的\s]+$/g, '').trim();

  return cap(t) || '主题';
}

/** Clamp a title to a chip-friendly length. */
function cap(value: string): string {
  const t = value.replace(/[的\s]+$/g, '').trim();
  if (!t) return '';
  return t.length > 28 ? `${t.slice(0, 28)}…` : t;
}

function detectKind(text: string): DiagramKind {
  const t = text.toLowerCase();
  if (/思维导图|脑图|mind\s*map/.test(t)) return 'mindmap';
  if (/组织架构|组织图|汇报|org\s*chart/.test(t)) return 'orgchart';
  if (/架构图|系统架构|微服务|部署|architecture|拓扑|topology/.test(t)) return 'architecture';
  if (/时序|sequence/.test(t)) return 'sequence';
  if (/er\s*图|实体关系|表结构|数据库设计/.test(t)) return 'er';
  if (/网络|network/.test(t)) return 'network';
  if (/uml|类图/.test(t)) return 'uml';
  return 'flowchart';
}

function looksLikeEdit(text: string): boolean {
  return /改成|改为|变成|换成|添加|加上|新增|增加|删除|删掉|去掉|移除|重命名|改一下|修改|调整|改名为|把.+改成|加一个|加个|连接|连起来|补充/.test(
    text,
  );
}

/**
 * True only when the user clearly wants the current diagram thrown away.
 *
 * Deliberately conservative: a vague "make it nicer" must NOT be treated as a
 * rebuild, because the offline engine would replace a real diagram with a
 * generic template. Regeneration also requires an explicit diagram type, so
 * "重新画一个架构图" rebuilds while "重新设计得更专业" does not.
 */
function wantsFullRebuild(text: string): boolean {
  const explicitRebuild = /(重新|从头|推倒|整个重)(生成|画|绘制|设计|做|来)|重做|换一种(图|类型|风格)/.test(text);
  if (!explicitRebuild) return false;
  // Require a target diagram type, otherwise we have nothing better to build.
  return DIAGRAM_WORD_RE.test(text);
}

// ---------------------------------------------------------------------------
// Node helpers
// ---------------------------------------------------------------------------

let counter = 0;
/** Deterministic-ish unique ids for offline nodes. */
function nid(prefix: string): string {
  counter += 1;
  return `${prefix}${counter}`;
}

function node(partial: Partial<DiagramNode> & { label: string }): DiagramNode {
  return { id: partial.id ?? nid('n'), ...partial } as DiagramNode;
}

function link(source: string, target: string, label?: string, extra: Partial<DiagramEdge> = {}): DiagramEdge {
  return { source, target, label, ...extra };
}

// ---------------------------------------------------------------------------
// Generators per diagram kind
// ---------------------------------------------------------------------------

/**
 * Steps that name the flow's terminal markers. We synthesise the start/end
 * nodes ourselves, so keeping these as steps produces a duplicated "结束".
 */
const TERMINAL_STEP = /^(开始|启动|起點|起点|结束|完成|终止|退出|end|start|finish)$/i;

function flowchartSpec(topic: string, steps: string[]): DiagramSpec {
  const nodes: DiagramNode[] = [node({ id: 'start', label: '开始', role: 'start', accent: 'green' })];
  const edges: DiagramEdge[] = [];

  // Drop terminal markers the user listed; the diagram adds its own.
  const meaningful = steps.filter((s) => !TERMINAL_STEP.test(s));
  const hasDecision = /是否|判断|检查|校验|验证|如果|若|条件|审批/.test(meaningful.join(' '));
  // The synthetic "结束" node is always added, so leave room for it.
  const middle = meaningful.slice(0, 9);

  if (middle.length === 0) {
    // No usable steps — produce a canonical happy path so the output is still useful.
    const generic = ['接收请求', '校验参数', '处理业务逻辑', '返回结果'];
    generic.forEach((label, i) => {
      const n = node({ id: `step${i + 1}`, label, role: i === 1 ? 'decision' : 'process' });
      nodes.push(n);
    });
  } else {
    middle.forEach((label, i) => {
      const isDecision = /是否|判断|检查|校验|验证|如果|审批/.test(label);
      nodes.push(
        node({
          id: `step${i + 1}`,
          label,
          role: isDecision ? 'decision' : 'process',
          shape: isDecision ? 'diamond' : undefined,
        }),
      );
    });
  }

  const end = node({ id: 'end', label: '结束', role: 'end', accent: 'rose' });
  nodes.push(end);

  // start -> ... -> end
  const chain = nodes.filter((n) => n.id !== 'end');
  for (let i = 0; i < chain.length - 1; i += 1) {
    edges.push(link(chain[i].id, chain[i + 1].id));
  }
  edges.push(link(chain[chain.length - 1].id, end.id));

  if (hasDecision) {
    // Give the decision a visible failure branch so it reads as a real flowchart.
    const decision = nodes.find((n) => n.role === 'decision');
    const alreadyHasBranch = edges.some((e) => e.label);
    if (decision && !alreadyHasBranch) {
      const fail = node({ id: nid('fail'), label: '返回错误', role: 'end', accent: 'rose' });
      nodes.push(fail);
      const out = edges.find((e) => e.source === decision.id);
      if (out) out.label = '是';
      edges.push(link(decision.id, fail.id, '否', { line: 'dashed', accent: 'rose' }));
    }
  }

  return {
    kind: 'flowchart',
    title: topic,
    layout: 'layered',
    direction: 'TB',
    theme: 'nebula',
    nodes,
    edges,
  };
}

function architectureSpec(topic: string, steps: string[]): DiagramSpec {
  const nodes: DiagramNode[] = [
    node({ id: 'client', label: '客户端', sublabel: 'Web / Mobile', role: 'client', accent: 'slate' }),
    node({ id: 'cdn', label: 'CDN', role: 'external', accent: 'cyan' }),
    node({ id: 'gateway', label: 'API 网关', sublabel: '鉴权 / 限流', role: 'service', accent: 'cyan' }),
    node({ id: 'auth', label: '认证服务', role: 'service', accent: 'violet' }),
    node({ id: 'biz', label: '业务服务', role: 'service', accent: 'blue' }),
    node({ id: 'cache', label: '缓存', sublabel: 'Redis', role: 'database', accent: 'amber' }),
    node({ id: 'db', label: '主数据库', role: 'database', accent: 'violet' }),
    node({ id: 'mq', label: '消息队列', role: 'queue', accent: 'amber' }),
  ];
  const edges: DiagramEdge[] = [
    link('client', 'cdn'),
    link('cdn', 'gateway'),
    link('gateway', 'auth', '校验'),
    link('gateway', 'biz', '转发'),
    link('biz', 'cache', '读', { line: 'dashed' }),
    link('biz', 'db', '读写'),
    link('biz', 'mq', '异步', { animated: true }),
  ];

  // Fold in any concrete components the user named.
  const extras = steps.filter((s) => !/^(客户端|网关|服务|数据库|缓存)$/.test(s)).slice(0, 5);
  extras.forEach((label, i) => {
    const n = node({ id: `extra${i + 1}`, label, role: 'service', accent: 'blue' });
    nodes.push(n);
    if (i > 0) edges.push(link(`extra${i}`, n.id, undefined, { line: 'dashed' }));
  });

  return {
    kind: 'architecture',
    title: topic,
    layout: 'layered',
    direction: 'LR',
    theme: 'nebula',
    nodes,
    edges,
  };
}

function mindmapSpec(topic: string, steps: string[]): DiagramSpec {
  const branches = steps.length >= 2 ? steps.slice(0, 6) : ['核心能力', '目标用户', '商业模式', '关键指标'];
  const nodes: DiagramNode[] = [node({ id: 'root', label: topic, role: 'service', accent: 'violet' })];
  const edges: DiagramEdge[] = [];

  branches.forEach((label, i) => {
    const accent = (['cyan', 'blue', 'green', 'amber', 'rose', 'violet'] as const)[i % 6];
    const branch = node({ id: `b${i + 1}`, label, accent, role: 'process' });
    nodes.push(branch);
    edges.push(link('root', branch.id));
  });

  return {
    kind: 'mindmap',
    title: topic,
    layout: 'mindmap',
    direction: 'TB',
    theme: 'nebula',
    nodes,
    edges,
  };
}

function orgchartSpec(topic: string, steps: string[]): DiagramSpec {
  const nodes: DiagramNode[] = [node({ id: 'ceo', label: steps[0] ?? '负责人', role: 'process', accent: 'violet' })];
  const edges: DiagramEdge[] = [];
  const reports = steps.length > 1 ? steps.slice(1, 5) : ['研发部', '产品部', '市场部', '运营部'];

  reports.forEach((label, i) => {
    const n = node({ id: `dept${i + 1}`, label, accent: 'cyan' });
    nodes.push(n);
    edges.push(link('ceo', n.id));
  });

  return { kind: 'orgchart', title: topic, layout: 'tree', direction: 'TB', theme: 'nebula', nodes, edges };
}

function sequenceSpec(topic: string, steps: string[]): DiagramSpec {
  const actors = steps.length >= 2 ? steps.slice(0, 4) : ['用户', '前端', '服务端', '数据库'];
  const nodes: DiagramNode[] = actors.map((label, i) =>
    node({ id: `actor${i + 1}`, label, role: 'client', accent: i === 0 ? 'slate' : 'cyan' }),
  );
  const edges: DiagramEdge[] = [];
  for (let i = 0; i < nodes.length - 1; i += 1) {
    edges.push(link(nodes[i].id, nodes[i + 1].id, `请求 ${i + 1}`, { line: 'solid' }));
    if (i < nodes.length - 2) {
      edges.push(
        link(nodes[i + 1].id, nodes[i].id, `响应 ${i + 1}`, { line: 'dashed', accent: 'green', arrow: 'open' }),
      );
    }
  }
  return { kind: 'sequence', title: topic, layout: 'layered', direction: 'LR', theme: 'nebula', nodes, edges };
}

function erSpec(topic: string, steps: string[]): DiagramSpec {
  const entities = steps.length >= 2 ? steps.slice(0, 5) : ['用户', '订单', '商品', '支付'];
  const nodes: DiagramNode[] = entities.map((label, i) =>
    node({ id: `e${i + 1}`, label, shape: 'rect', role: 'database', accent: 'violet' }),
  );
  const edges: DiagramEdge[] = [];
  for (let i = 0; i < nodes.length - 1; i += 1) {
    edges.push(link(nodes[i].id, nodes[i + 1].id, '1 : N', { style: 'entity', arrow: 'none' }));
  }
  return { kind: 'er', title: topic, layout: 'layered', direction: 'LR', theme: 'nebula', nodes, edges };
}

function networkSpec(topic: string, steps: string[]): DiagramSpec {
  const nodes: DiagramNode[] = [
    node({ id: 'internet', label: 'Internet', role: 'external', shape: 'cloud' }),
    node({ id: 'fw', label: '防火墙', role: 'service', accent: 'rose' }),
    node({ id: 'lb', label: '负载均衡', role: 'service', accent: 'cyan' }),
    node({ id: 'srv1', label: '应用服务器 1', role: 'process' }),
    node({ id: 'srv2', label: '应用服务器 2', role: 'process' }),
    node({ id: 'db', label: '数据库', role: 'database' }),
  ];
  const extra = steps.slice(0, 3).map((label, i) =>
    node({ id: `n${i + 1}`, label, role: 'process', accent: 'slate' }),
  );
  nodes.push(...extra);
  const edges: DiagramEdge[] = [
    link('internet', 'fw'),
    link('fw', 'lb'),
    link('lb', 'srv1'),
    link('lb', 'srv2'),
    link('srv1', 'db'),
    link('srv2', 'db'),
    ...extra.map((n) => link('fw', n.id, undefined, { line: 'dashed' })),
  ];
  return { kind: 'network', title: topic, layout: 'radial', direction: 'TB', theme: 'nebula', nodes, edges };
}

function genericSpec(topic: string, steps: string[]): DiagramSpec {
  const items = steps.length ? steps.slice(0, 8) : ['要点一', '要点二', '要点三'];
  const nodes: DiagramNode[] = items.map((label, i) => node({ id: `i${i + 1}`, label, accent: 'blue' }));
  const edges: DiagramEdge[] = [];
  for (let i = 0; i < nodes.length - 1; i += 1) edges.push(link(nodes[i].id, nodes[i + 1].id));
  return { kind: 'generic', title: topic, layout: 'layered', direction: 'TB', theme: 'nebula', nodes, edges };
}

/** Build a full spec for a create request. */
export function offlineCreate(request: string): { spec: DiagramSpec; kind: DiagramKind } {
  const kind = detectKind(request);
  const topic = trimTopic(request);
  const steps = splitSteps(request);

  let spec: DiagramSpec;
  switch (kind) {
    case 'mindmap':
      spec = mindmapSpec(topic, steps);
      break;
    case 'architecture':
      spec = architectureSpec(topic, steps);
      break;
    case 'orgchart':
      spec = orgchartSpec(topic, steps);
      break;
    case 'sequence':
      spec = sequenceSpec(topic, steps);
      break;
    case 'er':
      spec = erSpec(topic, steps);
      break;
    case 'network':
      spec = networkSpec(topic, steps);
      break;
    case 'flowchart':
      spec = flowchartSpec(topic, steps);
      break;
    default:
      spec = genericSpec(topic, steps);
      break;
  }
  return { spec, kind };
}

// ---------------------------------------------------------------------------
// Offline edits
// ---------------------------------------------------------------------------

/**
 * Characters that quote a label in the user's phrasing: 「」 “” ‘’ "" ''.
 * Stripped so `加上「人机验证」` yields the label `人机验证`, not `「人机验证」`.
 */
const QUOTES = /^[「『“”"'\s]+|[」』“”"'\s]+$/g;

/**
 * Matches a quoted run with properly paired delimiters, e.g. 「X」 or “X”.
 *
 * Two details that are easy to get wrong:
 *  - a plain `[「」]` character class lets the closing delimiter match the
 *    opening one, so `加上「人机验证」` matched only `加上「人`;
 *  - the inner quantifier must be GREEDY. With `{1,30}?` the lazy match stops
 *    after one character and the backreference then fails on the next
 *    character, so the whole pattern misses.
 */
const QUOTED_RUN = /([「『“‘"'])([^」』”’"']{1,30})\1/;

/**
 * Inner text of the first quoted run in `value`.
 *
 * Kept for label recovery on the ORIGINAL request, where delimiters still exist.
 */
function innerQuoted(value: string): string | null {
  const m = QUOTED_RUN.exec(value);
  return m ? m[2].trim() : null;
}

/** Strip surrounding quotes/whitespace from a captured label. */
function cleanLabel(value: string): string {
  return (innerQuoted(value) ?? value).replace(QUOTES, '').trim();
}

/**
 * Best-effort local edit. Handles the common "add / remove / rename / restyle"
 * phrasings so follow-up turns work without a model; anything subtler returns no
 * ops and the caller reports that a model is required.
 *
 * Order matters: `add` is checked LAST because its verbs (加) are substrings of
 * other intents (改为…从左到右), which previously swallowed layout requests.
 */
export function offlineEdit(request: string, spec: DiagramSpec): { ops: EditOp[]; note: string } {
  const ops: EditOp[] = [];
  const nodes = spec.nodes ?? [];
  const findByName = (needle: string) =>
    nodes.find((n) => n.label.includes(needle) || needle.includes(n.label)) ??
    nodes.find((n) => n.id === needle);

  // Bracket characters sit *around* the names we want ("在「A」和「B」之间"), and
  // a character class that excludes them can never capture A or B. Drop the
  // delimiters up front and work on the bare text everywhere below.
  const plain = request.replace(/[「」『』“”"']/g, '');

  // --- direction (checked before add: "改成从左到右" contains 加? no, but
  //     "改为横向" must not fall through to regeneration) ---
  if (/横向|从左到右|左右|left\s*to\s*right|\bLR\b/i.test(request)) {
    return { ops: [{ op: 'replace_all', spec: { ...spec, direction: 'LR', layout: 'layered' } }], note: '已切换为从左到右布局' };
  }
  if (/纵向|从上到下|上下|top\s*to\s*bottom|\bTB\b/i.test(request)) {
    return { ops: [{ op: 'replace_all', spec: { ...spec, direction: 'TB', layout: 'layered' } }], note: '已切换为从上到下布局' };
  }

  // --- theme ---
  if (/浅色|白色|打印|light|blueprint/i.test(request)) {
    return { ops: [{ op: 'replace_all', spec: { ...spec, theme: 'blueprint' } }], note: '已切换为浅色主题' };
  }
  if (/深色|暗色|科技感|dark|nebula/i.test(request)) {
    return { ops: [{ op: 'replace_all', spec: { ...spec, theme: 'nebula' } }], note: '已切换为深色科技主题' };
  }

  // --- layout algorithm ---
  if (/思维导图|放射|绕圈|radial|mindmap/i.test(request)) {
    return { ops: [{ op: 'replace_all', spec: { ...spec, layout: 'mindmap' } }], note: '已切换为思维导图放射布局' };
  }
  if (/树形|树状|层级|组织架构|tree/i.test(request)) {
    return { ops: [{ op: 'replace_all', spec: { ...spec, layout: 'tree' } }], note: '已切换为树形布局' };
  }
  if (/网格|九宫格|grid/i.test(request)) {
    return { ops: [{ op: 'replace_all', spec: { ...spec, layout: 'grid' } }], note: '已切换为网格布局' };
  }

  // --- rename node ---
  const renameMatch =
    /(?:把|将)?\s*([^，,。.\s]{1,20}?)\s*(?:改成|改为|改名为|重命名为|变成|换成)\s*([^，,。.\s]{1,20}?)\s*(?:$|[，,。.])/.exec(
      plain,
    );
  if (renameMatch) {
    const from = cleanLabel(renameMatch[1]);
    const to = cleanLabel(renameMatch[2]);
    const target = findByName(from);
    if (target) {
      ops.push({ op: 'update_node', id: target.id, patch: { label: to } });
      return { ops, note: `已将「${target.label}」重命名为「${to}」` };
    }
    return { ops: [], note: `没有找到名为「${from}」的节点` };
  }

  // --- remove node ---
  const delMatch = /(?:删除|删掉|去掉|移除|拿掉)\s*(?:节点)?\s*([^，,。.\s]{1,20}?)\s*(?:$|[，,。.])/.exec(plain);
  if (delMatch) {
    const needle = cleanLabel(delMatch[1]);
    const target = findByName(needle);
    if (target) {
      ops.push({ op: 'remove_node', id: target.id });
      return { ops, note: `已删除「${target.label}」及其连线` };
    }
    return { ops: [], note: `没有找到名为「${needle}」的节点` };
  }

  // --- add node (last: its verbs are the most ambiguous) ---
  const ADD_VERB = /(?:添加|加上|新增|增加|加一个|加个|插入|加入)/;
  const addVerb = ADD_VERB.exec(plain);
  if (addVerb) {
    // Everything after the verb is the new node's description.
    // "在 A 和 B 之间加上 C" -> "C";  "添加一个风控校验" -> "风控校验".
    const afterVerb = plain.slice(addVerb.index + addVerb[0].length);
    const bare = /^\s*(?:一个|个|名|名为|叫|节点)?\s*([^，,。.\s]{1,20})/.exec(afterVerb);
    const label = cleanLabel(bare?.[1] ?? innerQuoted(request.slice(request.indexOf(addVerb[0]))) ?? '');
    if (!label) {
      return { ops: [], note: '' };
    }
    const newNode = node({ id: nid('new'), label, role: 'process', accent: 'cyan' });

    // "在 A 和 B 之间加上 X"  → splice into the chain. Matching runs on `plain`
    // because the delimiters sit around the names we need to capture.
    const between = /([^，,\s]{1,20})\s*(?:和|与|跟|及)\s*([^，,\s]{1,20})\s*(?:之间|中间)/.exec(plain);
    if (between) {
      const a = findByName(cleanLabel(between[1]));
      const b = findByName(cleanLabel(between[2]));
      if (a && b) {
        // Careful: `edge` is the module-level helper — do not shadow it here.
        ops.push({ op: 'add_node', node: newNode });
        const existingLink = (spec.edges ?? []).find(
          (e) => (e.source === a.id && e.target === b.id) || (e.source === b.id && e.target === a.id),
        );
        if (existingLink?.id) ops.push({ op: 'remove_edge', id: existingLink.id });
        ops.push({ op: 'add_edge', edge: link(a.id, newNode.id) });
        ops.push({ op: 'add_edge', edge: link(newNode.id, b.id) });
        return { ops, note: `已在「${a.label}」和「${b.label}」之间插入「${label}」` };
      }
      // One of the anchors is not a real node — say so instead of guessing.
      return {
        ops: [],
        note: `没有找到「${cleanLabel(between[1])}」或「${cleanLabel(between[2])}」节点，未做改动`,
      };
    }

    const after = /([^，,\s]{1,20})\s*(?:之后|后面|后)\s*(?:添加|加上|新增|增加|加入)/.exec(plain);
    const tail = after ? findByName(cleanLabel(after[1])) : nodes[nodes.length - 2];
    ops.push({ op: 'add_node', node: newNode });
    if (tail) {
      const outEdge = (spec.edges ?? []).find((e) => e.source === tail.id);
      if (outEdge?.id) ops.push({ op: 'remove_edge', id: outEdge.id });
      ops.push({ op: 'add_edge', edge: link(tail.id, newNode.id) });
      if (outEdge) ops.push({ op: 'add_edge', edge: link(newNode.id, outEdge.target) });
    }
    return { ops, note: `已添加节点「${label}」` };
  }

  return { ops: [], note: '' };
}

/** Full offline planning entry point. */
export function offlinePlan(request: string, currentSpec: DiagramSpec | null): AgentPlan {
  const isEdit = currentSpec !== null && (currentSpec.nodes?.length ?? 0) > 0;
  const wantsRebuild = wantsFullRebuild(request);

  if (isEdit && wantsRebuild) {
    // The user explicitly asked for a different diagram: a genuine create.
    const { spec } = offlineCreate(request);
    return {
      reply:
        `已重新生成「${spec.title}」，共 ${spec.nodes?.length ?? 0} 个节点。` +
        `（离线模式：未配置 DeepSeek API Key，正在使用内置规则引擎）`,
      spec,
      suggestions: ['改成浅色主题', '把布局改成从左到右', '配置 DeepSeek API Key'],
    };
  }

  if (isEdit) {
    // An existing diagram is showing. Whatever the request means, the one thing
    // we must NOT do is silently replace it with a generic template. Try to
    // interpret the request as an edit; if that fails, keep the diagram intact
    // and explain how to get full natural-language editing.
    const { ops, note } = offlineEdit(request, currentSpec as DiagramSpec);
    if (ops.length > 0) {
      return {
        reply: `${note}（离线模式：未配置 DeepSeek API Key，正在使用内置规则引擎）`,
        operations: ops,
        suggestions: ['配置 DeepSeek API Key 以启用完整 AI 能力', '改一个颜色', '加一个决策分支'],
      };
    }

    return {
      reply:
        `离线模式暂时无法理解这条修改指令：\n「${request.trim()}」\n\n` +
        '当前图表已保留，未做任何改动。\n' +
        '离线引擎支持这些指令：\n' +
        '· 添加 / 删除节点：「在 A 和 B 之间加上 X」「删除 X」\n' +
        '· 重命名：「把 X 改成 Y」\n' +
        '· 布局：「改成从左到右 / 从上到下 / 思维导图 / 树形 / 网格」\n' +
        '· 主题：「改成浅色主题 / 深色主题」\n\n' +
        '如需任意自然语言修改，请在右上角设置中配置 DeepSeek API Key。',
      // No spec and no operations: the session keeps its current diagram.
      suggestions: ['改成从左到右', '改成浅色主题', '配置 DeepSeek API Key'],
    };
  }

  const { spec } = offlineCreate(request);
  const count = spec.nodes?.length ?? 0;
  return {
    reply:
      `已生成「${spec.title}」，共 ${count} 个节点。（离线模式：未配置 DeepSeek API Key，` +
      `当前由内置规则引擎生成；配置 Key 后即可使用 DeepSeek V4.1 Flash 的完整理解能力）`,
    spec,
    suggestions: ['加一个失败分支', '改成浅色主题', '把布局改成从左到右', '补充缓存层'],
  };
}
