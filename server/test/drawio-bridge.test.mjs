/**
 * Tests for the draw.io embed bridge — the protocol state machine that connects
 * our React UI to the vendored draw.io editor.
 *
 * This is the riskiest frontend integration (cross-document postMessage with an
 * asynchronous handshake and request/response correlation), so it is tested
 * directly against a faithful fake iframe rather than through a browser.
 *
 * Runs in-process: `node test/run.mjs`. Uses the bridge's bundled output so the
 * artifact under test is what ships.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Minimal DOM/browser shim. The bridge only needs `window` with
// addEventListener/removeEventListener/dispatchEvent and setTimeout/clearTimeout.
// ---------------------------------------------------------------------------
class FakeWindow {
  constructor() {
    this.listeners = new Map();
    this.setTimeout = globalThis.setTimeout;
    this.clearTimeout = globalThis.clearTimeout;
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) {
    this.listeners.get(type)?.delete(fn);
  }
  /** Simulate a message arriving from the editor iframe. */
  emitMessage(source, data, origin = 'http://localhost:5174') {
    const event = { source, origin, data: typeof data === 'string' ? data : JSON.stringify(data) };
    for (const fn of this.listeners.get('message') ?? []) fn(event);
  }
  listenerCount(type) {
    return this.listeners.get(type)?.size ?? 0;
  }
}

/** Fake iframe window: records everything the host posts. */
class FakeFrameWindow {
  constructor() {
    this.sent = [];
  }
  postMessage(raw) {
    this.sent.push(JSON.parse(raw));
  }
  last() {
    return this.sent[this.sent.length - 1];
  }
  byAction(action) {
    return this.sent.filter((m) => m.action === action);
  }
}

/**
 * The bridge is written in TypeScript and imported by the bundler in the app.
 * For tests we load the transpiled module from the web build's temp output when
 * present, otherwise transpile on the fly with the TypeScript compiler.
 */
async function loadBridge() {
  const { default: ts } = await import('typescript');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { pathToFileURL } = await import('node:url');

  const here = import.meta.dirname;
  const src = path.resolve(here, '..', '..', 'web', 'src', 'lib', 'drawio.ts');
  const code = fs.readFileSync(src, 'utf8');
  const out = ts.transpileModule(code, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
    },
    fileName: src,
  });

  const tmpDir = path.join(here, '.tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmpFile = path.join(tmpDir, `drawio-${Date.now()}.mjs`);
  fs.writeFileSync(tmpFile, out.outputText, 'utf8');
  const mod = await import(pathToFileURL(tmpFile).href);
  return mod;
}

const { DrawioBridge, editorUrl } = await loadBridge();

/** Wire up a bridge against a fake window + frame. */
function makeBridge(events = {}) {
  const win = new FakeWindow();
  const frameWindow = new FakeFrameWindow();
  const original = globalThis.window;
  globalThis.window = win;

  const bridge = new DrawioBridge(events);
  bridge.attach();
  bridge.setFrame({ contentWindow: frameWindow });

  return {
    bridge,
    win,
    frameWindow,
    restore: () => {
      bridge.dispose();
      globalThis.window = original;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('editorUrl builds the documented embed URL', () => {
  const url = editorUrl({ language: 'zh' });
  assert.ok(url.startsWith('/drawio/index.html?'), url);
  const params = new URLSearchParams(url.split('?')[1]);
  assert.equal(params.get('embed'), '1');
  assert.equal(params.get('proto'), 'json', 'JSON protocol is required');
  assert.equal(params.get('lang'), 'zh');
  // No save/exit chrome: the host app owns those actions.
  assert.equal(params.get('noSaveBtn'), '1');
  assert.equal(params.get('noExitBtn'), '1');
});

test('host -> editor: load is queued until the editor signals init', async () => {
  const win = new FakeWindow();
  const frameWindow = new FakeFrameWindow();
  const original = globalThis.window;
  globalThis.window = win;

  let readyCalled = false;
  const b = new DrawioBridge({ onReady: () => (readyCalled = true) });
  b.attach();
  b.setFrame({ contentWindow: frameWindow });

  try {
    // A load before init must not be lost — it should be queued.
    b.load('<mxfile>first</mxfile>').catch(() => {});
    assert.equal(frameWindow.sent.length, 0, 'nothing sent before init');

    win.emitMessage(frameWindow, { event: 'init' });
    assert.equal(readyCalled, true, 'onReady fired');
    assert.equal(b.isReady, true);

    const loads = frameWindow.byAction('load');
    assert.equal(loads.length, 1, 'queued load was flushed');
    assert.equal(loads[0].xml, '<mxfile>first</mxfile>');
    assert.equal(loads[0].autosave, 1, 'autosave keeps the host in sync');

    // Resolve the pending load promise so nothing dangles.
    win.emitMessage(frameWindow, { event: 'load', width: 100, height: 100 });
  } finally {
    b.dispose();
    globalThis.window = original;
  }
});

test('editor -> host: autosave reports real user edits only', () => {
  const seen = [];
  const { bridge, win, frameWindow, restore } = makeBridge({ onAutosave: (xml) => seen.push(xml) });
  try {
    win.emitMessage(frameWindow, { event: 'init' });
    bridge.load('<mxfile>programmatic</mxfile>');

    // The editor echoes our own programmatic load; it must be ignored.
    win.emitMessage(frameWindow, { event: 'autosave', xml: '<mxfile>programmatic</mxfile>' });
    assert.deepEqual(seen, [], 'echo of our own load is ignored');

    // A genuine user edit is reported.
    win.emitMessage(frameWindow, { event: 'autosave', xml: '<mxfile>user-edited</mxfile>' });
    assert.deepEqual(seen, ['<mxfile>user-edited</mxfile>']);
  } finally {
    restore();
  }
});

test('requestXml resolves with the XML the editor returns', async () => {
  const { bridge, win, frameWindow, restore } = makeBridge();
  try {
    win.emitMessage(frameWindow, { event: 'init' });
    const pending = bridge.requestXml();

    const sent = frameWindow.last();
    assert.equal(sent.action, 'export');
    assert.equal(sent.format, 'xml');

    win.emitMessage(frameWindow, { event: 'export', format: 'xml', xml: '<mxfile>live</mxfile>' });
    assert.equal(await pending, '<mxfile>live</mxfile>');
  } finally {
    restore();
  }
});

test('exportAs resolves with a data URI', async () => {
  const { bridge, win, frameWindow, restore } = makeBridge();
  try {
    win.emitMessage(frameWindow, { event: 'init' });
    const pending = bridge.exportAs('png', { scale: 2 });

    const sent = frameWindow.last();
    assert.equal(sent.action, 'export');
    assert.equal(sent.format, 'png');
    assert.equal(sent.scale, 2);

    const data = 'data:image/png;base64,AAAA';
    win.emitMessage(frameWindow, { event: 'export', format: 'png', data });
    assert.deepEqual(await pending, { data, xml: undefined });
  } finally {
    restore();
  }
});

test('save and export events reach their handlers', () => {
  const saves = [];
  const exports_ = [];
  const { bridge, win, frameWindow, restore } = makeBridge({
    onSave: (xml) => saves.push(xml),
    onExport: (p) => exports_.push(p),
  });
  try {
    win.emitMessage(frameWindow, { event: 'init' });
    win.emitMessage(frameWindow, { event: 'save', xml: '<mxfile>saved</mxfile>' });
    assert.deepEqual(saves, ['<mxfile>saved</mxfile>']);

    // A UI-triggered export (exportProtocol=true) also lands on onExport.
    win.emitMessage(frameWindow, { event: 'export', format: 'svg', data: 'data:image/svg+xml,x' });
    assert.equal(exports_.length, 1);
    assert.equal(exports_[0].format, 'svg');
    void bridge;
  } finally {
    restore();
  }
});

test('error and exit events are surfaced', () => {
  const errors = [];
  const exits = [];
  const { win, frameWindow, restore } = makeBridge({
    onError: (m) => errors.push(m),
    onExit: (modified) => exits.push(modified),
  });
  try {
    win.emitMessage(frameWindow, { event: 'init' });
    win.emitMessage(frameWindow, { event: 'error', message: 'boom' });
    win.emitMessage(frameWindow, { event: 'exit', modified: true });
    assert.deepEqual(errors, ['boom']);
    assert.deepEqual(exits, [true]);
  } finally {
    restore();
  }
});

test('messages from an unrelated window are ignored', () => {
  const seen = [];
  const { bridge, win, frameWindow, restore } = makeBridge({ onAutosave: (x) => seen.push(x) });
  try {
    win.emitMessage(frameWindow, { event: 'init' });
    const impostor = new FakeFrameWindow();
    win.emitMessage(impostor, { event: 'autosave', xml: '<mxfile>evil</mxfile>' });
    assert.deepEqual(seen, [], 'a different source window must not be trusted');
    void bridge;
  } finally {
    restore();
  }
});

test('malformed messages do not throw', () => {
  const { bridge, win, frameWindow, restore } = makeBridge();
  try {
    win.emitMessage(frameWindow, { event: 'init' });
    assert.doesNotThrow(() => {
      win.emitMessage(frameWindow, 'not json at all');
      win.emitMessage(frameWindow, { noEventField: true });
      win.emitMessage(frameWindow, { event: 'unknown-event', foo: 1 });
    });
    void bridge;
  } finally {
    restore();
  }
});

test('spinner / status / fit emit the documented actions', () => {
  const { bridge, win, frameWindow, restore } = makeBridge();
  try {
    win.emitMessage(frameWindow, { event: 'init' });
    bridge.spinner(true, 'working');
    bridge.status('hello', true);
    bridge.fit();

    assert.deepEqual(frameWindow.byAction('spinner').at(-1), { action: 'spinner', show: true, message: 'working' });
    assert.deepEqual(frameWindow.byAction('status').at(-1), { action: 'status', message: 'hello', modified: true });
    assert.deepEqual(frameWindow.byAction('fit').at(-1), { action: 'fit' });
  } finally {
    restore();
  }
});

test('dispose detaches the listener and rejects pending requests', async () => {
  const { bridge, win, frameWindow, restore } = makeBridge();
  try {
    win.emitMessage(frameWindow, { event: 'init' });
    assert.equal(win.listenerCount('message'), 1);

    const pending = bridge.requestXml();
    bridge.dispose();

    await assert.rejects(pending, /disposed/);
    assert.equal(win.listenerCount('message'), 0, 'listener removed');

    // After dispose, further editor messages are ignored.
    assert.doesNotThrow(() => win.emitMessage(frameWindow, { event: 'autosave', xml: '<mxfile>x</mxfile>' }));
  } finally {
    restore();
  }
});

test('load defaults to autosave enabled and requests fit', async () => {
  const { bridge, win, frameWindow, restore } = makeBridge();
  try {
    win.emitMessage(frameWindow, { event: 'init' });
    const pending = bridge.load('<mxfile>x</mxfile>');
    const sent = frameWindow.byAction('load').at(-1);

    assert.equal(sent.action, 'load');
    assert.equal(sent.autosave, 1);
    assert.equal(sent.fit, 1, 'a freshly generated diagram should be framed');
    assert.equal(sent.preserveViewState, true, 'do not persist runtime zoom into the file');

    win.emitMessage(frameWindow, { event: 'load' });
    await pending;
  } finally {
    restore();
  }
});

test('load can opt out of autosave', async () => {
  const { bridge, win, frameWindow, restore } = makeBridge();
  try {
    win.emitMessage(frameWindow, { event: 'init' });
    const pending = bridge.load('<mxfile>x</mxfile>', { autosave: false });
    assert.equal(frameWindow.byAction('load').at(-1).autosave, 0);
    win.emitMessage(frameWindow, { event: 'load' });
    await pending;
  } finally {
    restore();
  }
});
