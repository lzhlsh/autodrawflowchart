/**
 * End-to-end verification of the delivered artifact.
 *
 * Boots the real server against the real build and checks every layer:
 *   1. build artifacts exist and are non-trivial
 *   2. the vendored draw.io editor is complete and served
 *   3. the REST API answers and reports provider state
 *   4. natural language -> validated draw.io XML, create + edit turns
 *   5. the compiled XML parses back to the same graph (round trip)
 *   6. the SPA is served with the draw.io editor reachable from it
 *
 * Exits non-zero on the first failing category, printing what failed.
 *
 * Usage:
 *   node tools/verify.mjs                     # reuse http://127.0.0.1:5199 if up, else try to spawn one
 *   node tools/verify.mjs --url http://127.0.0.1:5174
 *   node tools/verify.mjs --port 5199
 *   node tools/verify.mjs --keep              # do not kill a spawned server
 */
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { assertWellFormed, parseDrawioXml, compileToXml } from '../server/dist/drawio/mxgraph.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const urlArg = args.indexOf('--url');
const portArg = args.indexOf('--port');
const PORT = portArg >= 0 ? Number(args[portArg + 1]) : 5199;
/** When --url is given we never spawn: the caller owns the server lifecycle. */
const EXTERNAL = urlArg >= 0;
const BASE = EXTERNAL ? args[urlArg + 1].replace(/\/+$/, '') : `http://127.0.0.1:${PORT}`;

let failures = 0;
let checks = 0;

function check(name, ok, detail = '') {
  checks += 1;
  if (ok) {
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `\n      \x1b[90m${detail}\x1b[0m` : ''}`);
  }
}

function section(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

async function json(pathname, init) {
  const res = await fetch(BASE + pathname, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 200) };
  }
  return { status: res.status, body, headers: res.headers };
}

async function waitForServer(timeoutMs = 30000) {
  const started = Date.now();
  for (;;) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    if (Date.now() - started > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function main() {
  console.log(`\n\x1b[1mAutoDrawFlowchart — full verification\x1b[0m`);

  // ---------------------------------------------------------------------
  section('1. build artifacts');
  const serverEntry = path.join(ROOT, 'server', 'dist', 'index.js');
  const webIndex = path.join(ROOT, 'web', 'dist', 'index.html');
  check('server build exists (server/dist/index.js)', existsSync(serverEntry));
  check('web build exists (web/dist/index.html)', existsSync(webIndex));

  if (existsSync(webIndex)) {
    const html = await import('node:fs').then((fs) => fs.readFileSync(webIndex, 'utf8'));
    check('web build references a hashed bundle', /assets\/main-[\w-]+\.js/.test(html) || /assets\/index-[\w-]+\.js/.test(html));
    check('web build links a stylesheet', /assets\/[\w-]+\.css/.test(html));
  }

  // ---------------------------------------------------------------------
  section('2. vendored draw.io editor');
  const drawioDir = path.join(ROOT, 'web', 'public', 'drawio');
  const required = ['index.html', 'js/main.js', 'js/app.min.js', 'js/bootstrap.js', 'styles/grapheditor.css'];
  for (const file of required) {
    check(`editor file present: ${file}`, existsSync(path.join(drawioDir, file)));
  }
  const appBundle = path.join(drawioDir, 'js', 'app.min.js');
  if (existsSync(appBundle)) {
    const size = statSync(appBundle).size;
    check('editor bundle is substantial (>5 MB)', size > 5 * 1024 * 1024, `${(size / 1048576).toFixed(1)} MB`);
  }
  check(
    'extracted editor was copied into the web build',
    existsSync(path.join(ROOT, 'web', 'dist', 'drawio', 'index.html')),
  );

  // ---------------------------------------------------------------------
  section('3. boot the server');
  // Prefer an already-running server (and fall back to it automatically when
  // spawning a child process is not permitted in this environment).
  let child = null;
  let started = false;

  const existing = await fetch(`${BASE}/api/health`).then(
    (r) => r.ok,
    () => false,
  );

  if (existing) {
    console.log(`  \x1b[90mreusing the server already listening on ${BASE}\x1b[0m`);
    started = true;
  } else if (EXTERNAL) {
    console.log(`  \x1b[90m--url given, not spawning a server\x1b[0m`);
  } else {
    try {
      child = spawn(process.execPath, [serverEntry], {
        cwd: ROOT,
        env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', AI_OFFLINE: '1', LOG_LEVEL: 'warn' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      console.log(`  \x1b[90mcannot spawn a server here (${err.message})\x1b[0m`);
    }
  }

  let serverLog = '';
  if (child) {
    child.stdout?.on('data', (d) => (serverLog += d.toString()));
    child.stderr?.on('data', (d) => (serverLog += d.toString()));
    child.on('error', (err) => (serverLog += `spawn error: ${err.message}\n`));
  }

  try {
    if (!started) started = await waitForServer();
    check(`server reachable on ${BASE}`, started, serverLog.slice(-400));

    if (started) {
      // -----------------------------------------------------------------
      section('4. API surface');
      const health = await json('/api/health');
      check('GET /api/health -> 200', health.status === 200);
      check('health reports a provider', ['deepseek', 'offline'].includes(health.body?.provider));
      check('health identifies the editor', String(health.body?.editor ?? '').includes('draw.io'));

      const settings = await json('/api/settings');
      check('GET /api/settings -> 200', settings.status === 200);
      check('settings never leak the key', !JSON.stringify(settings.body).includes('sk-'));

      const examples = await json('/api/examples');
      check('GET /api/examples returns presets', (examples.body?.examples?.length ?? 0) > 0);

      // -----------------------------------------------------------------
      section('5. natural language -> draw.io XML');
      const created = await json('/api/chart', {
        method: 'POST',
        body: JSON.stringify({
          message:
            '画一个订单支付流程图：用户提交订单，校验库存，判断库存是否充足，充足则创建支付单，调用支付网关，支付成功则更新订单状态并通知用户，库存不足或支付失败则取消订单并退款',
        }),
      });
      check('POST /api/chart -> 200', created.status === 200, JSON.stringify(created.body).slice(0, 300));

      const b = created.body;
      check('returns mxfile XML', typeof b?.xml === 'string' && b.xml.startsWith('<mxfile'));
      check('summary reports nodes', (b?.summary?.nodes ?? 0) > 3, `nodes=${b?.summary?.nodes}`);
      check('summary reports edges', (b?.summary?.edges ?? 0) > 2, `edges=${b?.summary?.edges}`);
      check('reply is present', (b?.reply ?? '').length > 0);

      let xmlOk = true;
      let xmlDetail = '';
      try {
        assertWellFormed(b.xml);
        const parsed = parseDrawioXml(b.xml);
        if (parsed.nodes.length !== b.summary.nodes) {
          xmlOk = false;
          xmlDetail = `parsed ${parsed.nodes.length} nodes vs summary ${b.summary.nodes}`;
        } else if (parsed.edges.length !== b.summary.edges) {
          xmlOk = false;
          xmlDetail = `parsed ${parsed.edges.length} edges vs summary ${b.summary.edges}`;
        }
      } catch (err) {
        xmlOk = false;
        xmlDetail = err.message;
      }
      check('emitted XML is well-formed and self-consistent', xmlOk, xmlDetail);

      if (typeof b?.xml === 'string') {
        const parsed = parseDrawioXml(b.xml);
        const ids = new Set(parsed.nodes.map((n) => n.id));
        const dangling = parsed.edges.filter((e) => !ids.has(e.source) || !ids.has(e.target));
        check('no dangling edge references', dangling.length === 0, JSON.stringify(dangling.slice(0, 3)));

        const allIds = [...b.xml.matchAll(/<mxCell id="([^"]+)"/g)].map((m) => m[1]);
        check('cell ids are unique', new Set(allIds).size === allIds.length);
        check('reserved root cells present', b.xml.includes('<mxCell id="0"/>') && b.xml.includes('<mxCell id="1" parent="0"/>'));

        // Geometry must be non-overlapping for a readable diagram.
        const positions = parsed.nodes.map((n) => `${n.x},${n.y}`);
        check('every node has coordinates', parsed.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y)));
        check('no two nodes share a position', new Set(positions).size === positions.length);
      }

      // -----------------------------------------------------------------
      section('6. multi-turn editing');
      const edited = await json('/api/chart', {
        method: 'POST',
        body: JSON.stringify({ sessionId: b.sessionId, message: '把「校验库存」改成「校验库存与限购」，并改成浅色主题' }),
      });
      check('follow-up turn -> 200', edited.status === 200, JSON.stringify(edited.body).slice(0, 300));
      check('revision advanced', (edited.body?.revision ?? 0) > (b.revision ?? 0));
      check('edited XML still well-formed', (() => {
        try {
          assertWellFormed(edited.body?.xml ?? '');
          return true;
        } catch {
          return false;
        }
      })());

      const session = await json(`/api/sessions/${b.sessionId}`);
      check('session records the conversation', (session.body?.messages?.length ?? 0) >= 4);

      const sync = await json(`/api/sessions/${b.sessionId}/diagram`, {
        method: 'PUT',
        body: JSON.stringify({ xml: edited.body.xml }),
      });
      check('canvas -> server sync works', sync.status === 200 && sync.body?.nodeCount === edited.body?.summary?.nodes);

      // -----------------------------------------------------------------
      section('7. compiler round trip');
      const spec = {
        kind: 'flowchart',
        title: 'Round trip',
        nodes: [
          { id: 'a', label: 'A & B', role: 'start' },
          { id: 'b', label: 'B', role: 'decision' },
          { id: 'c', label: 'C', role: 'end' },
        ],
        edges: [
          { source: 'a', target: 'b', label: 'go' },
          { source: 'b', target: 'c', label: 'yes' },
        ],
      };
      const local = compileToXml(spec);
      assertWellFormed(local.xml);
      const reparsed = parseDrawioXml(local.xml);
      check('local compile keeps 3 nodes', reparsed.nodes.length === 3, `got ${reparsed.nodes.length}`);
      check('local compile keeps 2 edges', reparsed.edges.length === 2, `got ${reparsed.edges.length}`);

      const rendered = await json('/api/render', { method: 'POST', body: JSON.stringify({ spec }) });
      check('POST /api/render -> 200', rendered.status === 200);
      const parsedBack = await json('/api/parse', { method: 'POST', body: JSON.stringify({ xml: rendered.body.xml }) });
      check('POST /api/parse round trips', parsedBack.body?.nodeCount === 3 && parsedBack.body?.edgeCount === 2);

      // -----------------------------------------------------------------
      section('8. frontend + editor are served');
      const spa = await fetch(`${BASE}/`);
      const spaHtml = await spa.text();
      check('SPA served at /', spa.status === 200 && spaHtml.includes('<div id="root">'));

      const editorPage = await fetch(`${BASE}/drawio/index.html?embed=1&proto=json`);
      const editorHtml = await editorPage.text();
      check('draw.io editor served at /drawio/', editorPage.status === 200 && editorHtml.includes('js/main.js'));

      // Note: compression is enabled, so responses are chunked and omit
      // content-length. Measure the decoded body instead.
      const bundleRes = await fetch(`${BASE}/drawio/js/app.min.js`);
      const bundleBytes = bundleRes.ok ? (await bundleRes.arrayBuffer()).byteLength : 0;
      check(
        'draw.io app bundle served',
        bundleRes.status === 200 && bundleBytes > 5 * 1024 * 1024,
        `status=${bundleRes.status} bytes=${bundleBytes}`,
      );

      const cssRes = await fetch(`${BASE}/assets/app.css`);
      check('app stylesheet served', cssRes.status === 200);
      const css = await cssRes.text();
      check('stylesheet contains the design system', css.includes('--accent-cyan') && css.includes('.header'));
    }
  } finally {
    if (child && !args.includes('--keep')) child.kill();
    // Give the process a moment to release the port.
    await new Promise((r) => setTimeout(r, 300));
  }

  // ---------------------------------------------------------------------
  console.log('');
  if (failures === 0) {
    console.log(`\x1b[32m\x1b[1m✓ verification passed\x1b[0m — ${checks} checks\n`);
  } else {
    console.log(`\x1b[31m\x1b[1m✗ verification failed\x1b[0m — ${failures} of ${checks} checks failed\n`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('\nverification crashed:', err);
  process.exitCode = 1;
});
