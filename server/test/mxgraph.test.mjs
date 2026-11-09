/**
 * Unit tests for the draw.io XML compiler.
 *
 * Run against the built output (`npm run build` first) so the artifact under
 * test is exactly what the server ships:
 *   node --test server/test
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  compileToXml,
  parseDrawioXml,
  assertWellFormed,
  escapeXml,
  IdFactory,
  resolveGraph,
} from '../dist/drawio/mxgraph.js';
import { applyOperations, summarizeSpec, validateSpec, validateCompilation } from '../dist/drawio/validate.js';
import { runLayout } from '../dist/drawio/layout.js';

/** A canonical small flowchart used across several assertions. */
const flow = {
  kind: 'flowchart',
  title: 'Login flow',
  nodes: [
    { id: 'start', label: 'Start', role: 'start' },
    { id: 'check', label: 'Credentials valid?', role: 'decision' },
    { id: 'ok', label: 'Issue token', role: 'process' },
    { id: 'fail', label: 'Reject', role: 'end' },
  ],
  edges: [
    { id: 'e1', source: 'start', target: 'check' },
    { id: 'e2', source: 'check', target: 'ok', label: 'yes' },
    { id: 'e3', source: 'check', target: 'fail', label: 'no' },
  ],
};

test('compiles a spec into well-formed draw.io XML', () => {
  const result = compileToXml(flow);
  assert.equal(result.nodeCount, 4);
  assert.equal(result.edgeCount, 3);
  assertWellFormed(result.xml);

  // Structure draw.io requires.
  assert.match(result.xml, /^<mxfile host="app\.diagrams\.net"/);
  assert.match(result.xml, /<mxCell id="0"\/>/);
  assert.match(result.xml, /<mxCell id="1" parent="0"\/>/);
  assert.match(result.xml, /<\/mxfile>$/);

  // Reserved ids must never be reused by real content.
  const ids = [...result.xml.matchAll(/<mxCell id="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length, 'cell ids must be unique');
  assert.equal(ids.filter((id) => id === '0').length, 1);
  assert.equal(ids.filter((id) => id === '1').length, 1);
});

test('round-trips nodes and edges back out of the XML', () => {
  const { xml, nodeCount, edgeCount } = compileToXml(flow);
  const parsed = parseDrawioXml(xml);
  assert.equal(parsed.nodes.length, nodeCount);
  assert.equal(parsed.edges.length, edgeCount);

  const start = parsed.nodes.find((n) => n.id === 'start');
  assert.ok(start, 'start node survives the round trip');
  assert.equal(start.label, 'Start');
  assert.equal(typeof start.x, 'number');
  assert.equal(typeof start.y, 'number');

  const labels = parsed.edges.map((e) => e.label).filter(Boolean).sort();
  assert.deepEqual(labels, ['no', 'yes']);
});

test('auto-layout places every node without overlap', () => {
  const result = compileToXml(flow);
  const parsed = parseDrawioXml(result.xml);
  for (const node of parsed.nodes) {
    assert.equal(typeof node.x, 'number', `${node.id} has x`);
    assert.equal(typeof node.y, 'number', `${node.id} has y`);
    assert.ok(node.x >= 0 && node.y >= 0, `${node.id} is inside the positive quadrant`);
  }
  // Layered flow: the decision must sit below the start node.
  const start = parsed.nodes.find((n) => n.id === 'start');
  const check = parsed.nodes.find((n) => n.id === 'check');
  assert.ok(check.y > start.y, 'successor is placed on a lower layer');
});

test('LR direction lays nodes out horizontally', () => {
  const result = compileToXml({ ...flow, direction: 'LR', layout: 'layered' });
  const parsed = parseDrawioXml(result.xml);
  const start = parsed.nodes.find((n) => n.id === 'start');
  const check = parsed.nodes.find((n) => n.id === 'check');
  assert.ok(check.x > start.x, 'successor is placed to the right');
});

test('escapes XML-hostile labels and keeps them readable', () => {
  const spec = {
    kind: 'flowchart',
    nodes: [
      { id: 'a', label: 'A & B <tag> "quoted"' },
      { id: 'b', label: 'line one\nline two', sublabel: 'sub & text' },
    ],
    edges: [{ source: 'a', target: 'b' }],
  };
  const { xml } = compileToXml(spec);
  assertWellFormed(xml);
  assert.ok(!/value="[^"]*<tag>/.test(xml), 'raw markup must not reach an attribute');
  assert.match(xml, /&amp;/);

  const parsed = parseDrawioXml(xml);
  const a = parsed.nodes.find((n) => n.id === 'a');
  assert.equal(a.label, 'A & B <tag> "quoted"');

  const b = parsed.nodes.find((n) => n.id === 'b');
  assert.match(b.label, /line one/);
  assert.match(b.label, /sub & text/);
});

test('drops dangling edges instead of emitting invalid XML', () => {
  const spec = {
    kind: 'flowchart',
    nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
    edges: [
      { source: 'a', target: 'b' },
      { source: 'a', target: 'ghost' },
      { source: 'a', target: 'a' },
    ],
  };
  const result = compileToXml(spec);
  assert.equal(result.edgeCount, 1);
  assert.equal(result.warnings.length, 2);
  assertWellFormed(result.xml);
});

test('de-duplicates node ids rather than producing invalid XML', () => {
  const spec = {
    kind: 'flowchart',
    nodes: [
      { id: 'dup', label: 'first' },
      { id: 'dup', label: 'second' },
    ],
    edges: [],
    layout: 'grid',
  };
  const ids = new IdFactory();
  assert.equal(ids.claim('dup'), 'dup');
  assert.equal(ids.claim('dup'), 'dup_1');
  assert.equal(ids.claim('0'), '0_1');
  assert.equal(ids.claim('has space!'), 'has_space_');

  const { xml } = compileToXml(spec);
  assertWellFormed(xml);
  const cellIds = [...xml.matchAll(/<mxCell id="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(cellIds).size, cellIds.length);
});

test('validator reports structural problems', () => {
  const bad = validateSpec({
    nodes: [{ id: 'a', label: 'A' }, { id: 'a', label: 'again' }, { id: '', label: 'no id' }],
    edges: [{ source: 'a', target: 'missing' }],
  });
  assert.equal(bad.ok, false);
  const codes = bad.issues.map((i) => i.code);
  assert.ok(codes.includes('node-id-duplicate'));
  assert.ok(codes.includes('node-id-missing'));
  assert.ok(codes.includes('edge-target-unknown'));
});

test('validator accepts a good spec and compile round-trips', () => {
  const result = validateCompilation(flow);
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.ok(result.xml);
  assert.equal(result.issues.filter((i) => i.level === 'error').length, 0);
});

test('applyOperations edits a spec incrementally', () => {
  const { spec, applied, skipped } = applyOperations(flow, [
    { op: 'add_node', node: { id: 'mfa', label: 'MFA?', role: 'decision' } },
    { op: 'add_edge', edge: { id: 'e4', source: 'ok', target: 'mfa', label: 'then' } },
    { op: 'update_node', id: 'ok', patch: { label: 'Issue JWT token', accent: 'green' } },
    { op: 'remove_edge', id: 'e3' },
    { op: 'set_title', title: 'Login with MFA' },
    { op: 'update_node', id: 'nope', patch: { label: 'x' } },
  ]);

  assert.equal(applied, 5);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /no node "nope"/);
  assert.equal(spec.nodes.length, 5);
  assert.equal(spec.title, 'Login with MFA');
  assert.equal(spec.nodes.find((n) => n.id === 'ok').label, 'Issue JWT token');
  assert.ok(!spec.edges.some((e) => e.id === 'e3'));

  // The edited spec must still compile cleanly.
  const compiled = compileToXml(spec);
  assertWellFormed(compiled.xml);
  assert.equal(compiled.nodeCount, 5);
});

test('removing a node cascades to its edges', () => {
  const { spec } = applyOperations(flow, [{ op: 'remove_node', id: 'check' }]);
  assert.equal(spec.nodes.length, 3);
  assert.equal(spec.edges.length, 0, 'edges touching the removed node are gone');
  assertWellFormed(compileToXml(spec).xml);
});

test('replace_all swaps the whole diagram', () => {
  const { spec } = applyOperations(flow, [
    { op: 'replace_all', spec: { kind: 'mindmap', title: 'New', nodes: [{ id: 'x', label: 'X' }], edges: [] } },
  ]);
  assert.equal(spec.title, 'New');
  assert.equal(spec.nodes.length, 1);
});

test('summarizeSpec produces a compact, complete digest', () => {
  const summary = summarizeSpec(flow);
  assert.match(summary, /kind: flowchart/);
  assert.match(summary, /id=start/);
  assert.match(summary, /check -> ok/);
  assert.match(summary, /label="yes"/);
});

test('empty diagrams are still valid XML', () => {
  const { xml } = compileToXml({ kind: 'flowchart', title: 'Empty', nodes: [], edges: [] });
  assertWellFormed(xml);
  assert.match(xml, /<root>/);
});

test('mindmap layout distributes children radially', () => {
  const spec = {
    kind: 'mindmap',
    layout: 'mindmap',
    nodes: [
      { id: 'root', label: 'MVP' },
      { id: 'a', label: 'Feature A' },
      { id: 'b', label: 'Feature B' },
      { id: 'c', label: 'Feature C' },
    ],
    edges: [
      { source: 'root', target: 'a' },
      { source: 'root', target: 'b' },
      { source: 'root', target: 'c' },
    ],
  };
  const { xml, nodeCount } = compileToXml(spec);
  const parsed = parseDrawioXml(xml);
  assert.equal(parsed.nodes.length, nodeCount);

  const root = parsed.nodes.find((n) => n.id === 'root');
  const others = parsed.nodes.filter((n) => n.id !== 'root');
  // Children must be spread out, not stacked on one axis.
  const dx = others.map((n) => Math.abs(n.x - root.x));
  const dy = others.map((n) => Math.abs(n.y - root.y));
  assert.ok(Math.max(...dx) - Math.min(...dx) > 50, 'children differ horizontally');
  assert.ok(Math.max(...dy) - Math.min(...dy) > 50, 'children differ vertically');
});

test('large graph survives layout without collapsing', () => {
  const nodes = Array.from({ length: 60 }, (_, i) => ({ id: `n${i}`, label: `Step ${i}` }));
  const edges = Array.from({ length: 59 }, (_, i) => ({ source: `n${i}`, target: `n${i + 1}` }));
  const laid = runLayout(nodes, edges, 'layered', { direction: 'TB' });
  assert.equal(laid.length, 60);
  const ys = new Set(laid.map((n) => n.y));
  assert.equal(ys.size, 60, 'a chain must produce 60 distinct layers');
  assertWellFormed(compileToXml({ nodes, edges }).xml);
});

test('assertWellFormed rejects broken XML', () => {
  assert.throws(() => assertWellFormed('<a><b></a>'), /malformed XML/);
  assert.throws(() => assertWellFormed('<a><b>'), /unclosed/);
  assert.doesNotThrow(() => assertWellFormed('<a><b/></a>'));
});

test('escapeXml neutralises every XML metacharacter', () => {
  assert.equal(escapeXml('<&>"\''), '&lt;&amp;&gt;&quot;&apos;');
  assert.equal(escapeXml('a\u0000b'), 'ab');
});

test('resolveGraph keeps caller ids stable across recompiles', () => {
  const first = resolveGraph(flow);
  const second = resolveGraph(flow);
  assert.deepEqual([...first.idMap.entries()], [...second.idMap.entries()]);
  assert.deepEqual(first.edges.map((e) => e.id), ['e1', 'e2', 'e3']);
});
