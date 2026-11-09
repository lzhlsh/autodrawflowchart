/**
 * API smoke test — the "minimal closed loop" verification.
 *
 * Exercises the real HTTP surface against a running server: create a diagram
 * from natural language, then edit it with follow-up turns, confirming the XML
 * stays valid draw.io XML the whole way.
 *
 * Usage: node tools/smoke-api.mjs [baseUrl]
 */
import { parseDrawioXml, assertWellFormed } from '../server/dist/drawio/mxgraph.js';

const BASE = process.argv[2] ?? 'http://127.0.0.1:5174';

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function json(path, init) {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 300) };
  }
  return { status: res.status, body };
}

async function main() {
  console.log(`\n\x1b[1mAPI smoke test\x1b[0m -> ${BASE}\n`);

  // --- health ------------------------------------------------------------
  console.log('health');
  const health = await json('/api/health');
  check('GET /api/health returns 200', health.status === 200, `status ${health.status}`);
  check('health.ok is true', health.body.ok === true);
  check('provider is reported', ['deepseek', 'offline'].includes(health.body.provider), health.body.provider);

  // --- create ------------------------------------------------------------
  console.log('\ncreate diagram from natural language');
  const created = await json('/api/chart', {
    method: 'POST',
    body: JSON.stringify({
      message:
        '画一个用户登录流程图：输入账号密码，校验格式，查询用户是否存在，验证密码是否正确，校验通过后生成令牌并返回，失败则提示错误信息并记录日志',
    }),
  });
  check('POST /api/chart returns 200', created.status === 200, `status ${created.status} ${JSON.stringify(created.body).slice(0, 200)}`);

  const b = created.body;
  const sessionId = b.sessionId;
  check('response carries a sessionId', typeof sessionId === 'string' && sessionId.length > 0);
  check('response carries draw.io XML', typeof b.xml === 'string' && b.xml.startsWith('<mxfile'));
  check('diagram has nodes', (b.summary?.nodes ?? 0) > 2, `nodes=${b.summary?.nodes}`);
  check('diagram has edges', (b.summary?.edges ?? 0) > 1, `edges=${b.summary?.edges}`);
  check('reply is non-empty', typeof b.reply === 'string' && b.reply.length > 0);

  // XML must be parseable and self-consistent.
  let xmlOk = true;
  let parseDetail = '';
  try {
    assertWellFormed(b.xml);
    const parsed = parseDrawioXml(b.xml);
    if (parsed.nodes.length !== b.summary.nodes) {
      xmlOk = false;
      parseDetail = `parsed ${parsed.nodes.length} nodes, summary said ${b.summary.nodes}`;
    }
    if (parsed.edges.length !== b.summary.edges) {
      xmlOk = false;
      parseDetail = `parsed ${parsed.edges.length} edges, summary said ${b.summary.edges}`;
    }
  } catch (err) {
    xmlOk = false;
    parseDetail = err.message;
  }
  check('returned XML is well-formed and matches the summary', xmlOk, parseDetail);

  // No dangling edge references.
  const parsed = parseDrawioXml(b.xml);
  const nodeIds = new Set(parsed.nodes.map((n) => n.id));
  const dangling = parsed.edges.filter((e) => !nodeIds.has(e.source) || !nodeIds.has(e.target));
  check('no dangling edge references', dangling.length === 0, JSON.stringify(dangling.slice(0, 3)));

  // --- edit turn ---------------------------------------------------------
  console.log('\nedit the diagram with a follow-up turn');
  const edited = await json('/api/chart', {
    method: 'POST',
    body: JSON.stringify({ sessionId, message: '在「输入账号密码」和「校验格式」之间加上「人机验证」，并改成浅色主题' }),
  });
  check('follow-up returns 200', edited.status === 200, `status ${edited.status}`);
  check('revision increased', (edited.body.revision ?? 0) > (b.revision ?? 0));
  check('still returns valid XML', typeof edited.body.xml === 'string' && edited.body.xml.startsWith('<mxfile'));
  if (typeof edited.body.xml === 'string') {
    try {
      assertWellFormed(edited.body.xml);
      check('edited XML well-formed', true);
    } catch (err) {
      check('edited XML well-formed', false, err.message);
    }
  }

  // --- session state -----------------------------------------------------
  console.log('\nsession + sync endpoints');
  const sess = await json(`/api/sessions/${sessionId}`);
  check('GET session returns 200', sess.status === 200);
  check('session has message history', (sess.body.messages?.length ?? 0) >= 4, `messages=${sess.body.messages?.length}`);
  check(
    'history contains both roles',
    (sess.body.messages ?? []).some((m) => m.role === 'user') &&
      (sess.body.messages ?? []).some((m) => m.role === 'assistant'),
  );

  // Simulate the user editing the canvas, then round-trip it back.
  const sync = await json(`/api/sessions/${sessionId}/diagram`, {
    method: 'PUT',
    body: JSON.stringify({ xml: edited.body.xml }),
  });
  check('PUT diagram sync returns 200', sync.status === 200, JSON.stringify(sync.body).slice(0, 200));
  check('synced node count matches', sync.body.nodeCount === edited.body.summary.nodes, `${sync.body.nodeCount} vs ${edited.body.summary.nodes}`);

  // --- edit after a manual canvas change --------------------------------
  const afterSync = await json('/api/chart', {
    method: 'POST',
    body: JSON.stringify({ sessionId, message: '把「输入账号密码」改成「输入手机号与验证码」' }),
  });
  check('edit after canvas sync returns 200', afterSync.status === 200, JSON.stringify(afterSync.body).slice(0, 200));

  // --- render / parse round trip ----------------------------------------
  console.log('\nrender + parse round trip');
  const spec = {
    kind: 'flowchart',
    title: 'Round trip',
    nodes: [
      { id: 'a', label: 'A & B', role: 'start' },
      { id: 'b', label: 'B', role: 'process' },
    ],
    edges: [{ source: 'a', target: 'b', label: 'go' }],
  };
  const rendered = await json('/api/render', { method: 'POST', body: JSON.stringify({ spec }) });
  check('POST /api/render returns 200', rendered.status === 200, JSON.stringify(rendered.body).slice(0, 200));
  const reparsed = await json('/api/parse', { method: 'POST', body: JSON.stringify({ xml: rendered.body.xml }) });
  check('POST /api/parse returns 200', reparsed.status === 200);
  check('round trip keeps 2 nodes', reparsed.body?.nodeCount === 2, `got ${reparsed.body?.nodeCount}`);
  check('round trip keeps 1 edge', reparsed.body?.edgeCount === 1, `got ${reparsed.body?.edgeCount}`);

  // --- error handling ----------------------------------------------------
  console.log('\nerror handling');
  const bad = await json('/api/chart', { method: 'POST', body: JSON.stringify({ message: '' }) });
  check('empty message rejected with 400', bad.status === 400, `status ${bad.status}`);
  check('error envelope has code+message', Boolean(bad.body?.error?.code && bad.body?.error?.message));
  const missing = await json('/api/sessions/does-not-exist');
  check('unknown session returns 404', missing.status === 404, `status ${missing.status}`);
  const badXml = await json('/api/parse', { method: 'POST', body: JSON.stringify({ xml: '<mxfile><broken>' }) });
  check('malformed XML rejected', badXml.status >= 400, `status ${badXml.status}`);

  // --- examples ----------------------------------------------------------
  const examples = await json('/api/examples');
  check('GET /api/examples returns a list', Array.isArray(examples.body?.examples) && examples.body.examples.length > 0);

  console.log('');
  if (failures === 0) {
    console.log('\x1b[32m\x1b[1mAPI smoke test passed\x1b[0m\n');
  } else {
    console.log(`\x1b[31m\x1b[1m${failures} check(s) failed\x1b[0m\n`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('smoke test crashed:', err);
  process.exitCode = 1;
});
