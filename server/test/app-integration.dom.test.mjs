/**
 * App-level integration test: real React UI + real HTTP + real draw.io compiler.
 *
 * Why this exists: browsers cannot be launched in every environment (sandboxes
 * commonly deny `child_process.spawn`, which both Playwright and headless Chrome
 * need). Rather than skip verifying the frontend, this test mounts the actual
 * `<App />` component in a lightweight DOM, points `fetch` at a real server
 * instance on an ephemeral port, and asserts on the rendered output.
 *
 * Driving input: linkedom does not deliver bubbling events to React's delegated
 * root listener reliably, so instead of hand-crafting synthetic events we invoke
 * the `onChange` / `onClick` handlers that React actually attached to the nodes
 * (read from the `__reactProps$…` expando). That exercises our components' real
 * logic — state, effects, requests and rendering — which is what this test is
 * for. Hit-testing and browser event plumbing are covered by `tools/e2e.mjs`
 * where a real browser is available.
 *
 * Runs in-process: `node test/run.mjs`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseHTML } from 'linkedom';

const HERE = import.meta.dirname;
const WEB_SRC = path.resolve(HERE, '..', '..', 'web', 'src');
const TMP = path.join(HERE, '.tmp-app');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Silence React's "not wrapped in act(...)" warning.
 *
 * The app's boot sequence resolves a fetch outside our `act()` window, which
 * React reports even though every assertion helper polls inside `act()`. The
 * warning is expected here and would otherwise bury genuine console errors, so
 * it is filtered — but only that exact message.
 */
const nativeConsoleError = console.error.bind(console);
console.error = (...args) => {
  if (String(args[0] ?? '').includes('not wrapped in act(')) return;
  nativeConsoleError(...args);
};

// ---------------------------------------------------------------------------
// 1. TypeScript loader for the web sources.
//    Node has no built-in TS support and esbuild/tsx need a child process, so we
//    transpile with the TypeScript compiler API (pure JavaScript) via a module
//    customization hook.
// ---------------------------------------------------------------------------
mkdirSync(TMP, { recursive: true });
const CSS_STUB = path.join(TMP, 'css-stub.mjs');
writeFileSync(CSS_STUB, 'export default undefined;\n', 'utf8');

const HOOKS = path.join(TMP, 'ts-hooks.mjs');
writeFileSync(
  HOOKS,
  `
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const WEB_SRC = ${JSON.stringify(WEB_SRC)};
const CSS_STUB = ${JSON.stringify(pathToFileURL(CSS_STUB).href)};

// The app uses bundler-style extensionless imports ("./components/Header").
const EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js', '.mjs'];

export async function resolve(specifier, context, nextResolve) {
  // Stylesheets become a no-op module: this test does not exercise CSS.
  if (specifier.endsWith('.css')) return { url: CSS_STUB, shortCircuit: true };

  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    if (!specifier.startsWith('.') && !specifier.startsWith('/')) throw err;
    const base = context.parentURL ? path.dirname(fileURLToPath(context.parentURL)) : WEB_SRC;
    const target = specifier.startsWith('/') ? specifier : path.resolve(base, specifier);
    for (const ext of EXTENSIONS) {
      const candidate = target + ext;
      if (existsSync(candidate)) return { url: pathToFileURL(candidate).href, shortCircuit: true };
    }
    for (const ext of EXTENSIONS) {
      const candidate = path.join(target, 'index' + ext);
      if (existsSync(candidate)) return { url: pathToFileURL(candidate).href, shortCircuit: true };
    }
    throw err;
  }
}

export async function load(url, context, nextLoad) {
  if (!url.startsWith('file:') || !/\\.tsx?$/.test(url)) return nextLoad(url, context);
  const file = fileURLToPath(url);
  if (!file.startsWith(WEB_SRC)) return nextLoad(url, context);
  const out = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      isolatedModules: true,
    },
    fileName: file,
  });
  return { format: 'module', source: out.outputText, shortCircuit: true };
}
`,
  'utf8',
);

const { register } = await import('node:module');
register(pathToFileURL(HOOKS).href, import.meta.url);

// ---------------------------------------------------------------------------
// 2. DOM shim — installed before React is imported.
// ---------------------------------------------------------------------------
const { window: shimWindow, document: shimDocument } = parseHTML(
  '<!doctype html><html><head></head><body><div id="root"></div></body></html>',
);

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
    key: (i) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
}

const domShim = {
  navigator: { userAgent: 'node-linkedom', clipboard: { writeText: async () => {} } },
  location: { href: 'http://127.0.0.1/', search: '', hash: '', protocol: 'http:', host: '127.0.0.1' },
  localStorage: memoryStorage(),
  innerWidth: 1600,
  innerHeight: 950,
  requestAnimationFrame: (cb) => setTimeout(() => cb(Date.now()), 0),
  cancelAnimationFrame: (id) => clearTimeout(id),
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  scrollTo: () => {},
};

for (const [key, value] of Object.entries(domShim)) {
  try {
    Object.defineProperty(shimWindow, key, { value, writable: true, configurable: true });
  } catch {
    /* some linkedom props are getter-only */
  }
}

/**
 * Globals this file replaces. Snapshotted now so the teardown can put the
 * process back the way it found it — other test files in the same run (notably
 * the provider-compatibility tests) must not inherit a fake browser.
 */
const DOM_GLOBALS = [
  'window',
  'document',
  'navigator',
  'localStorage',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'getComputedStyle',
  'Event',
  'CustomEvent',
  'HTMLElement',
  'Element',
  'Node',
];
const savedGlobals = new Map(DOM_GLOBALS.map((key) => [key, globalThis[key]]));

/**
 * Install the DOM shim.
 *
 * Deliberately NOT done at module scope. The OpenAI SDK throws from its
 * constructor when `window`/`document` exist ("running in a browser-like
 * environment"), and test files are all imported before any test runs. Leaving
 * the globals installed during import therefore poisons every later test that
 * talks to a live endpoint — which is exactly what happened to the
 * provider-compatibility tests in the `--all` tier.
 *
 * Installing lazily (from the first test) keeps module evaluation side-effect
 * free, so file import order can no longer matter.
 */
let domInstalled = false;
function installDomShim() {
  if (domInstalled) return;
  domInstalled = true;

  for (const method of ['scrollIntoView', 'scrollTo', 'focus', 'blur', 'getBoundingClientRect']) {
    if (typeof shimWindow.Element?.prototype?.[method] !== 'function') {
      try {
        Object.defineProperty(shimWindow.Element.prototype, method, {
          value:
            method === 'getBoundingClientRect'
              ? () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 })
              : () => {},
          writable: true,
          configurable: true,
        });
      } catch {
        /* some linkedom props are getter-only */
      }
    }
  }

  globalThis.window = shimWindow;
  globalThis.document = shimDocument;
  globalThis.navigator = domShim.navigator;
  globalThis.localStorage = domShim.localStorage;
  globalThis.requestAnimationFrame = domShim.requestAnimationFrame;
  globalThis.cancelAnimationFrame = domShim.cancelAnimationFrame;
  globalThis.getComputedStyle = domShim.getComputedStyle;
  globalThis.Event = shimWindow.Event;
  globalThis.CustomEvent = shimWindow.CustomEvent;
  globalThis.HTMLElement = shimWindow.HTMLElement ?? class {};
  globalThis.Element = shimWindow.Element ?? class {};
  globalThis.Node = shimWindow.Node ?? class {};
}

// ---------------------------------------------------------------------------
// 3. Start a real server on an ephemeral port and route fetch() to it.
// ---------------------------------------------------------------------------
const { app } = await import('../dist/index.js');
const listener = createServer(app);
await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
const BASE = `http://127.0.0.1:${listener.address().port}`;

const nativeFetch = globalThis.fetch;
const requestLog = [];
/** Swapped in by the first test, once the DOM shim is up. */
let routedFetch = nativeFetch;

// ---------------------------------------------------------------------------
// 4. Import React and the App. These only *define* components; nothing renders
//    until the first test installs the shim.
// ---------------------------------------------------------------------------
const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { App } = await import(pathToFileURL(path.join(WEB_SRC, 'App.tsx')).href);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const root = shimDocument.getElementById('root');

/** React stores the props it rendered on each host node under this expando. */
function reactProps(node) {
  if (!node) return null;
  const key = Object.keys(node).find((k) => k.startsWith('__reactProps$'));
  return key ? node[key] : null;
}

/** Invoke a React handler (onChange/onClick) the way the framework would. */
async function invokeHandler(node, handlerName, event) {
  const props = reactProps(node);
  const handler = props?.[handlerName];
  assert.equal(typeof handler, 'function', `${handlerName} handler attached to the node`);
  await act(async () => {
    handler(event);
  });
}

async function settle(rounds = 6) {
  for (let i = 0; i < rounds; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      await new Promise((r) => setTimeout(r, 15));
    });
  }
}

async function waitFor(predicate, label, timeoutMs = 90000) {
  const started = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      await new Promise((r) => setTimeout(r, 25));
    });
  }
}

function state() {
  const el = shimDocument.querySelector('[data-testid="app-state"]');
  if (!el) return null;
  const get = (name) => el.getAttribute(name);
  return {
    backendOnline: get('data-backend-online'),
    editorReady: get('data-editor-ready'),
    provider: get('data-provider'),
    sessionId: get('data-session-id'),
    hasDiagram: get('data-has-diagram'),
    nodeCount: Number(get('data-node-count')),
    edgeCount: Number(get('data-edge-count')),
    busy: get('data-busy'),
    xmlLength: Number(get('data-xml-length')),
  };
}

/** Type into the composer and press send, via the component's own handlers. */
async function submitMessage(text) {
  const input = shimDocument.querySelector('.composer__input');
  assert.ok(input, 'composer input present');
  await invokeHandler(input, 'onChange', { target: { value: text } });
  await settle(2);

  const send = shimDocument.querySelector('.composer__send');
  assert.ok(send, 'send button present');
  assert.equal(send.disabled, false, 'send button is enabled once a message is typed');

  await invokeHandler(send, 'onClick', { preventDefault() {}, stopPropagation() {} });

  // Wait for the request to start: the app guards against concurrent sends, so
  // the next submitMessage would otherwise be dropped.
  await waitFor(() => state().busy === '1', 'request in flight', 30000);
}

/** Wait until no request is in flight. */
async function waitIdle(timeoutMs = 90000) {
  await waitFor(() => state()?.busy === '0', 'app idle', timeoutMs);
}

// ---------------------------------------------------------------------------
// Tests (node:test runs these sequentially in this harness)
// ---------------------------------------------------------------------------

test('App boots: health, settings and examples are fetched and rendered', async () => {
  // First test in this file installs the DOM shim and routes fetch() at the
  // ephemeral server. Doing it here (not at import) keeps module evaluation
  // side-effect free so other test files are unaffected.
  installDomShim();
  globalThis.fetch = (input, init) => {
    const raw = typeof input === 'string' ? input : input.url;
    const url = raw.startsWith('http') ? raw : `${BASE}${raw}`;
    requestLog.push({ method: init?.method ?? 'GET', url: raw });
    return routedFetch(url, init);
  };

  await act(async () => {
    root.__adfRoot = createRoot(root);
    root.__adfRoot.render(React.createElement(App));
  });

  await waitFor(() => state() !== null, 'app-state element', 30000);
  await waitFor(() => state().provider !== 'unknown', 'provider resolution', 30000);

  const s = state();
  assert.equal(s.backendOnline, '1', 'backend health check succeeded');
  assert.ok(['deepseek', 'offline'].includes(s.provider), `provider=${s.provider}`);
  assert.equal(s.hasDiagram, '0', 'no diagram generated yet');

  const paths = requestLog.map((r) => r.url);
  assert.ok(paths.includes('/api/health'), 'GET /api/health issued');
  assert.ok(paths.includes('/api/settings'), 'GET /api/settings issued');
  assert.ok(paths.includes('/api/examples'), 'GET /api/examples issued');

  const html = shimDocument.body.innerHTML;
  assert.ok(html.includes('AutoDrawFlowchart'), 'brand rendered');
  assert.ok(html.includes('AI 绘图助手'), 'agent panel rendered');
  assert.ok(html.includes('API 已连接'), 'status bar reports the API as connected');
  assert.ok(html.includes('未命名图表') || html.includes('图表名称'), 'title input rendered');
});

test('editor iframe points at the vendored draw.io embed URL', () => {
  const iframe = shimDocument.querySelector('iframe.editor__frame');
  assert.ok(iframe, 'editor iframe rendered');
  const src = iframe.getAttribute('src');
  assert.ok(src.startsWith('/drawio/index.html?'), src);
  assert.ok(src.includes('embed=1'), 'embed mode requested');
  assert.ok(src.includes('proto=json'), 'JSON protocol requested');
  assert.ok(src.includes('ui=dark'), 'dark editor chrome requested');
});

test('the offline-mode banner explains the current provider', () => {
  const html = shimDocument.body.innerHTML;
  const provider = state().provider;
  if (provider === 'offline') {
    assert.ok(html.includes('当前为离线模式'), 'offline banner shown');
    assert.ok(html.includes('DeepSeek V4.1 Flash'), 'banner explains what enabling the key adds');
  } else {
    assert.ok(html.includes('AI 绘图助手'), 'panel rendered for online mode');
  }
});

test('submitting natural language generates a diagram and renders the reply', async () => {
  await waitIdle();
  await submitMessage('画一个用户登录流程图：输入账号密码，校验格式，查询用户是否存在，验证密码是否正确');

  await waitFor(() => state().hasDiagram === '1', 'diagram generation');

  const s = state();
  assert.ok(s.nodeCount > 2, `expected several nodes, got ${s.nodeCount}`);
  assert.ok(s.edgeCount > 1, `expected several edges, got ${s.edgeCount}`);
  assert.ok(s.xmlLength > 500, `expected XML payload, got ${s.xmlLength} chars`);
  assert.ok(s.sessionId.length > 0, 'session id established');

  const chartCalls = requestLog.filter((r) => r.url === '/api/chart');
  assert.equal(chartCalls.length, 1, 'exactly one chart request');
  assert.equal(chartCalls[0].method, 'POST');

  assert.equal(shimDocument.querySelectorAll('.msg--user').length, 1, 'user bubble rendered');
  assert.ok(shimDocument.querySelectorAll('.msg--assistant').length >= 1, 'assistant bubble rendered');

  const reply = shimDocument.querySelector('.msg--assistant .msg__bubble').textContent;
  assert.ok(reply.length > 0, 'assistant reply has text');

  // The composer is cleared for the next turn.
  assert.equal(shimDocument.querySelector('.composer__input').value, '', 'composer cleared after send');
});

test('a follow-up turn edits the same session and re-renders', async () => {
  await waitIdle();
  const before = state();

  await submitMessage('把「输入账号密码」改成「输入手机号与验证码」');
  await waitFor(
    () => state().busy === '0' && state().xmlLength !== before.xmlLength,
    'follow-up edit applied',
  );

  const after = state();
  assert.equal(after.sessionId, before.sessionId, 'session reused across turns');
  assert.equal(after.hasDiagram, '1', 'diagram still present');
  assert.notEqual(after.xmlLength, before.xmlLength, 'diagram content changed');

  const chartCalls = requestLog.filter((r) => r.url === '/api/chart');
  assert.equal(chartCalls.length, 2, 'second chart request issued');
  assert.ok(
    shimDocument.querySelectorAll('.msg--assistant').length >= 2,
    'second assistant reply rendered',
  );
});

test('an unsatisfiable request degrades gracefully instead of crashing', async () => {
  await waitIdle();
  const before = state();
  await submitMessage('删除「这个节点根本不存在」');
  await waitIdle();

  const after = state();
  assert.equal(after.hasDiagram, '1', 'diagram survives a bad request');
  assert.ok(after.xmlLength > 0, 'diagram content intact');
  assert.equal(after.sessionId, before.sessionId, 'session intact');
  assert.ok(shimDocument.querySelectorAll('.msg--assistant').length >= 3, 'a reply was still shown');
});

test('settings dialog opens and reflects provider state', async () => {
  await waitIdle();
  const button = shimDocument.querySelector('.header__actions button[aria-label="设置"]');
  assert.ok(button, 'settings button rendered');

  await invokeHandler(button, 'onClick', { preventDefault() {} });
  await settle(3);

  const modal = shimDocument.querySelector('.modal[aria-label="AI 设置"]');
  assert.ok(modal, 'settings modal opened');

  const text = modal.textContent;
  assert.ok(text.includes('DeepSeek API Key'), 'API key field present');
  assert.ok(text.includes('deepseek-flash'), 'model name shown');
  assert.ok(text.includes('运行模式'), 'mode selector present');
  assert.ok(text.includes('测试连接'), 'connection test action present');

  // Close it again so later assertions see the normal app chrome.
  const cancel = [...modal.querySelectorAll('button')].find((b) => b.textContent.includes('取消'));
  assert.ok(cancel, 'cancel button present');
  await invokeHandler(cancel, 'onClick', { preventDefault() {} });
  await settle(3);
  assert.equal(shimDocument.querySelectorAll('.modal').length, 0, 'settings modal closed');
});

test('quick-action chips render once a diagram exists', () => {
  const labels = [...shimDocument.querySelectorAll('.panel__section-label')].map((n) => n.textContent);
  assert.ok(labels.includes('快速调整'), `expected the quick-actions section, got: ${labels.join(' | ')}`);

  const chips = [...shimDocument.querySelectorAll('.chip')].map((c) => c.textContent);
  assert.ok(chips.some((t) => t.includes('横向')), `expected layout chip, got: ${chips.join(' | ')}`);
  assert.ok(chips.some((t) => t.includes('浅色')), 'expected theme chip');
});

test('the XML is exposed for download and the panel offers a preview', () => {
  const buttons = [...shimDocument.querySelectorAll('.panel__body button')].map((b) => b.textContent);
  assert.ok(
    buttons.some((t) => t.includes('draw.io XML')),
    `expected an XML preview toggle, got: ${buttons.join(' | ')}`,
  );
  const exportButton = shimDocument.querySelector('.header__actions button[aria-label="导出 XML"]');
  assert.ok(exportButton, 'XML export action rendered in the header');
  assert.equal(exportButton.disabled, false, 'export enabled once a diagram exists');
});

test('teardown restores the process globals this file shimmed', async () => {
  // Unmount first so React runs its effect cleanups (toast timers, scroll
  // listeners, the draw.io bridge) while the DOM still exists.
  await act(async () => {
    root.__adfRoot?.unmount();
  });

  await new Promise((resolve) => listener.close(resolve));
  globalThis.fetch = nativeFetch;
  rmSync(TMP, { recursive: true, force: true });

  // Let any already-scheduled timer callbacks drain before the globals vanish.
  await new Promise((r) => setTimeout(r, 50));

  // Belt and braces for the `--all` tier. The shim is installed lazily by the
  // first test above, so a DOM shim is only ever live during this file's own
  // tests — but restoring here guarantees the process is left as we found it.
  for (const key of DOM_GLOBALS) {
    const original = savedGlobals.get(key);
    if (original === undefined) delete globalThis[key];
    else globalThis[key] = original;
  }

  assert.equal(typeof globalThis.window, 'undefined', 'window removed');
  assert.equal(typeof globalThis.document, 'undefined', 'document removed');
});
