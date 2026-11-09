/**
 * Offline rules-engine tests.
 *
 * The offline engine is the zero-configuration fallback, so its behaviour is
 * part of the product contract, not a stub:
 *   - it must generate a valid diagram for every supported diagram kind
 *   - it must apply the documented follow-up edit phrasings
 *   - it must NEVER destroy the user's diagram when it cannot understand an edit
 *
 * Runs in-process: `node test/run.mjs`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { offlineCreate, offlineEdit, offlinePlan } from '../dist/ai/offline.js';
import { compileToXml, assertWellFormed, parseDrawioXml } from '../dist/drawio/mxgraph.js';
import { applyOperations } from '../dist/drawio/validate.js';

/** A small flowchart standing in for "the diagram the user is looking at". */
function baseSpec() {
  return {
    kind: 'flowchart',
    title: '登录',
    layout: 'layered',
    direction: 'TB',
    theme: 'nebula',
    nodes: [
      { id: 'start', label: '开始', role: 'start' },
      { id: 'a', label: '输入账号密码', role: 'process' },
      { id: 'b', label: '校验格式', role: 'decision' },
      { id: 'c', label: '查询用户是否存在', role: 'process' },
      { id: 'end', label: '结束', role: 'end' },
    ],
    edges: [
      { id: 'e1', source: 'start', target: 'a' },
      { id: 'e2', source: 'a', target: 'b' },
      { id: 'e3', source: 'b', target: 'c' },
      { id: 'e4', source: 'c', target: 'end' },
    ],
  };
}

/** Apply an edit request end-to-end, the way the agent does. */
function edit(spec, request) {
  const { ops, note } = offlineEdit(request, spec);
  const applied = applyOperations(spec, ops);
  return { ops, note, spec: applied.spec, applied: applied.applied };
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

test('generates a compilable diagram for every supported kind', () => {
  const requests = [
    ['画一个用户登录流程图', 'flowchart'],
    ['画一个电商系统的微服务架构图', 'architecture'],
    ['用思维导图梳理产品规划', 'mindmap'],
    ['画一个公司组织架构图', 'orgchart'],
    ['画一个下单支付的时序图', 'sequence'],
    ['画一个电商系统的 ER 图', 'er'],
    // Note: "企业网络拓扑图" classifies as architecture — the architecture
    // keywords are matched first because "拓扑图" alone is ambiguous.
    ['画一个企业网络拓扑图', 'architecture'],
  ];

  for (const [request, expectedKind] of requests) {
    const { spec, kind } = offlineCreate(request);
    assert.equal(kind, expectedKind, `${request} -> ${kind}`);
    assert.ok(spec.nodes.length >= 3, `${request} produced ${spec.nodes.length} nodes`);

    const compiled = compileToXml(spec);
    assertWellFormed(compiled.xml);

    // Every edge must resolve and every node must have geometry.
    const parsed = parseDrawioXml(compiled.xml);
    assert.equal(parsed.nodes.length, compiled.nodeCount, `${request}: node round trip`);
    assert.equal(parsed.edges.length, compiled.edgeCount, `${request}: edge round trip`);
    for (const node of parsed.nodes) {
      assert.ok(Number.isFinite(node.x) && Number.isFinite(node.y), `${request}: ${node.id} positioned`);
    }
  }
});

test('extracts a concise title instead of echoing the whole request', () => {
  const cases = [
    ['画一个用户登录流程图：输入账号密码，校验格式', '用户登录'],
    ['帮我画一个电商下单支付流程', '电商下单支付'],
    // "主题是X" names the subject explicitly, so X becomes the title.
    ['生成一个思维导图，主题是产品规划', '产品规划'],
  ];
  for (const [request, expected] of cases) {
    const { spec } = offlineCreate(request);
    assert.equal(spec.title, expected, `${request} -> ${spec.title}`);
    assert.ok(spec.title.length <= 28, 'title stays short');
  }
});

test('does not duplicate the terminal node when the request lists it', () => {
  const { spec } = offlineCreate('画一个登录流程图：输入账号密码，校验格式，结束');
  const labels = spec.nodes.map((n) => n.label);
  const ends = labels.filter((l) => l === '结束');
  assert.equal(ends.length, 1, `expected one "结束", got ${ends.length}: ${labels.join(' | ')}`);

  const { spec: spec2 } = offlineCreate('画一个登录流程图：开始，输入账号密码，校验格式，完成');
  const labels2 = spec2.nodes.map((n) => n.label);
  assert.equal(labels2.filter((l) => l === '开始').length, 1);
  assert.equal(labels2.filter((l) => l === '结束').length, 1);
});

test('every flowchart is reachable start -> end', () => {
  const { spec } = offlineCreate('画一个用户登录流程图：输入账号密码，校验格式，查询用户是否存在，验证密码是否正确');
  const out = new Map();
  for (const e of spec.edges) {
    if (!out.has(e.source)) out.set(e.source, []);
    out.get(e.source).push(e.target);
  }
  const seen = new Set(['start']);
  const queue = ['start'];
  while (queue.length) {
    const id = queue.shift();
    for (const next of out.get(id) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  assert.ok(seen.has('end'), 'end node is reachable from start');
  const unreachable = spec.nodes.filter((n) => !seen.has(n.id)).map((n) => n.id);
  assert.deepEqual(unreachable, [], 'no orphan nodes');
});

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

test('renames a node by quoted label', () => {
  const { ops, spec } = edit(baseSpec(), '把「校验格式」改成「校验手机号格式」');
  assert.equal(ops.length, 1);
  assert.equal(ops[0].op, 'update_node');
  assert.equal(spec.nodes.find((n) => n.id === 'b').label, '校验手机号格式');
});

test('renames a node without quotes', () => {
  const { spec } = edit(baseSpec(), '把校验格式改成校验手机号格式');
  assert.equal(spec.nodes.find((n) => n.id === 'b').label, '校验手机号格式');
});

test('renames and reports when the node does not exist', () => {
  const { ops, note } = edit(baseSpec(), '把「不存在的节点」改成「X」');
  assert.equal(ops.length, 0);
  assert.match(note, /没有找到/);
});

test('inserts a node between two anchors and rewires the chain', () => {
  const { ops, spec, note } = edit(baseSpec(), '在「输入账号密码」和「校验格式」之间加上「人机验证」');
  assert.match(note, /人机验证/);
  const added = spec.nodes.find((n) => n.label === '人机验证');
  assert.ok(added, 'new node exists');
  assert.ok(spec.edges.some((e) => e.source === 'a' && e.target === added.id), 'a -> new');
  assert.ok(spec.edges.some((e) => e.source === added.id && e.target === 'b'), 'new -> b');
  assert.ok(!spec.edges.some((e) => e.source === 'a' && e.target === 'b'), 'old a -> b edge removed');
});

test('inserts a node between unquoted anchors too', () => {
  const { spec } = edit(baseSpec(), '在输入账号密码和校验格式之间加上人机验证');
  assert.ok(spec.nodes.some((n) => n.label === '人机验证'));
});

test('appends a node after a named anchor', () => {
  const { ops, spec } = edit(baseSpec(), '在「输入账号密码」之后添加「风控校验」');
  assert.ok(ops.some((o) => o.op === 'add_node'));
  const added = spec.nodes.find((n) => n.label === '风控校验');
  assert.ok(added, 'node added');
  assert.ok(spec.edges.some((e) => e.source === 'a' && e.target === added.id), 'anchored after the named node');
});

test('adds a plain node when no anchor is given', () => {
  const { spec } = edit(baseSpec(), '添加一个风控校验');
  assert.ok(spec.nodes.some((n) => n.label === '风控校验'));
});

test('removes a node and cascades its edges', () => {
  const { spec } = edit(baseSpec(), '删除「查询用户是否存在」');
  assert.ok(!spec.nodes.some((n) => n.id === 'c'));
  assert.ok(!spec.edges.some((e) => e.source === 'c' || e.target === 'c'));
});

test('switches layout direction, theme and algorithm', () => {
  assert.equal(edit(baseSpec(), '改成从左到右').spec.direction, 'LR');
  assert.equal(edit(baseSpec(), '改成从上到下').spec.direction, 'TB');
  assert.equal(edit(baseSpec(), '改成浅色主题').spec.theme, 'blueprint');
  assert.equal(edit(baseSpec(), '改成深色主题').spec.theme, 'nebula');
  assert.equal(edit(baseSpec(), '改成思维导图布局').spec.layout, 'mindmap');
  assert.equal(edit(baseSpec(), '改成树形布局').spec.layout, 'tree');
  assert.equal(edit(baseSpec(), '改成网格布局').spec.layout, 'grid');
});

test('a layout request is not mistaken for an add-node request', () => {
  // Regression: the add-verb regex used to match inside "改为…从左到右"
  // because 加 is a substring, so the diagram was regenerated instead.
  const { ops } = edit(baseSpec(), '把布局改成从左到右');
  assert.equal(ops.length, 1);
  assert.equal(ops[0].op, 'replace_all');
  assert.equal(ops[0].spec.direction, 'LR');
});

test('edited diagrams still compile to valid XML', () => {
  const requests = [
    '把「校验格式」改成「校验手机号格式」',
    '在「输入账号密码」和「校验格式」之间加上「人机验证」',
    '删除「查询用户是否存在」',
    '改成浅色主题',
    '改成从左到右',
  ];
  for (const request of requests) {
    const { spec } = edit(baseSpec(), request);
    const compiled = compileToXml(spec);
    assertWellFormed(compiled.xml);
    const parsed = parseDrawioXml(compiled.xml);
    assert.equal(parsed.nodes.length, compiled.nodeCount, request);
    assert.equal(parsed.edges.length, compiled.edgeCount, request);
  }
});

// ---------------------------------------------------------------------------
// Plan-level safety
// ---------------------------------------------------------------------------

test('an unsupported edit preserves the diagram instead of regenerating', () => {
  const spec = baseSpec();
  const plan = offlinePlan('帮我把这张图重新设计得更专业一点', spec);

  assert.equal(plan.spec, undefined, 'must not return a replacement spec');
  assert.equal(plan.operations, undefined, 'must not return operations');
  assert.match(plan.reply, /未做任何改动|已保留/, 'explains that nothing changed');
  assert.ok(plan.reply.includes('DeepSeek'), 'points at the way to get full capability');
});

test('plan returns operations (never a spec) for a recognised edit', () => {
  const plan = offlinePlan('把「校验格式」改成「校验格式与长度」', baseSpec());
  assert.ok(plan.operations && plan.operations.length > 0, 'operations returned');
  assert.equal(plan.spec, undefined, 'no full spec for an incremental edit');
});

test('plan returns a spec for a create request', () => {
  const plan = offlinePlan('画一个订单支付流程图', null);
  assert.ok(plan.spec, 'spec returned');
  assert.ok(plan.spec.nodes.length >= 3);
  assert.ok((plan.reply ?? '').length > 0);
});

test('an explicit rebuild request does regenerate', () => {
  const plan = offlinePlan('重新画一个微服务架构图', baseSpec());
  assert.ok(plan.spec, 'a new spec is produced');
  assert.equal(plan.spec.kind, 'architecture');
});
