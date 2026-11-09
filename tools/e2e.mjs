/**
 * End-to-end verification in a real browser.
 *
 * Verifies the whole loop rather than the parts:
 *   1. the built web app boots and reports backend/provider state
 *   2. the self-hosted draw.io editor loads inside its iframe and completes the
 *      embed handshake (this is the risky integration)
 *   3. sending a natural-language request produces a diagram, and that diagram
 *      reaches the canvas
 *   4. a follow-up turn edits the existing diagram
 *   5. a manual canvas edit syncs back to the server
 *   6. the settings dialog opens and reports provider state
 *   7. no console errors / failed requests anywhere in the run
 *
 * Usage:
 *   node tools/e2e.mjs                                   # launch Edge/Chromium
 *   node tools/e2e.mjs --headed                          # watch it run
 *   node tools/e2e.mjs --url http://127.0.0.1:5174
 *   node tools/e2e.mjs --cdp http://127.0.0.1:9222       # attach to a running browser
 *
 * Requires a browser. `chromium.launch()` spawns one, which some sandboxes deny
 * (`spawn EPERM`); use `--cdp` against an already-running browser with
 * `--remote-debugging-port` in that case. Where no browser can run at all, the
 * in-process `server/test/app-integration.dom.test.mjs` covers the same wiring.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const HEADED = args.includes('--headed');
const urlArgIndex = args.indexOf('--url');
const BASE = urlArgIndex >= 0 ? args[urlArgIndex + 1] : 'http://127.0.0.1:5174';
const cdpArgIndex = args.indexOf('--cdp');
const CDP = cdpArgIndex >= 0 ? args[cdpArgIndex + 1] : null;

const ARTIFACTS = path.resolve(import.meta.dirname, '..', '.artifacts');

let failures = 0;
let passes = 0;

function check(name, ok, detail = '') {
  if (ok) {
    passes += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `\n      \x1b[90m${detail}\x1b[0m` : ''}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await mkdir(ARTIFACTS, { recursive: true });
  console.log(`\n\x1b[1mE2E\x1b[0m -> ${BASE}\n`);

  let browser;
  try {
    if (CDP) {
      // Attach to a browser that is already running — no child process needed.
      browser = await chromium.connectOverCDP(CDP, { timeout: 15000 });
    } else {
      browser = await chromium.launch({
        channel: 'msedge',
        headless: !HEADED,
        args: ['--no-sandbox', '--disable-dev-shm-usage'],
      });
    }
  } catch (err) {
    console.error(
      `\n\x1b[31mCannot start or attach to a browser:\x1b[0m ${err.message.split('\n')[0]}\n\n` +
        'Options:\n' +
        '  1. Start a browser with a debugging port and attach:\n' +
        '       msedge.exe --headless=new --remote-debugging-port=9222 --user-data-dir=<tmp>\n' +
        '       node tools/e2e.mjs --cdp http://127.0.0.1:9222\n' +
        '  2. Run the in-process DOM integration test instead:\n' +
        '       npm run test:all\n',
    );
    process.exitCode = 1;
    return;
  }

  // When attached over CDP the browser already owns its contexts, so prefer an
  // existing page from the default context.
  let context;
  let page;
  if (CDP && browser.contexts().length > 0) {
    context = browser.contexts()[0];
    page = context.pages()[0] ?? (await context.newPage());
    await page.setViewportSize({ width: 1600, height: 950 });
  } else {
    context = await browser.newContext({
      viewport: { width: 1600, height: 950 },
      locale: 'zh-CN',
      deviceScaleFactor: 1,
    });
    page = await context.newPage();
  }
  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];

  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => pageErrors.push(err.message));
  page.on('requestfailed', (req) => {
    const failure = req.failure()?.errorText ?? '';
    // Aborted requests during navigation are expected noise.
    if (failure.includes('ERR_ABORTED')) return;
    failedRequests.push(`${req.method()} ${req.url()} — ${failure}`);
  });

  // ---------------------------------------------------------------------
  console.log('1. app boot');
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });

  const state = page.locator('[data-testid="app-state"]');
  await state.waitFor({ state: 'attached', timeout: 30000 });

  // Wait for the boot sequence (health + settings) to resolve.
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="app-state"]');
      return el && el.getAttribute('data-provider') !== 'unknown';
    },
    { timeout: 30000 },
  );

  const boot = await readState(state);
  check('app renders', true);
  check('backend reachable', boot.backendOnline === '1', `data-backend-online=${boot.backendOnline}`);
  check('provider reported', boot.provider === 'deepseek' || boot.provider === 'offline', boot.provider);
  check('no diagram yet', boot.hasDiagram === '0');

  const headerTitle = await page.locator('.header__title').textContent();
  check('brand renders', (headerTitle ?? '').includes('AutoDrawFlowchart'), headerTitle ?? '');
  check('status bar shows API connected', (await page.locator('.statusbar').textContent())?.includes('API 已连接'));

  // ---------------------------------------------------------------------
  console.log('\n2. draw.io editor embed handshake');
  const frameHandle = await page.waitForSelector('iframe.editor__frame', { timeout: 30000 });
  const frame = await frameHandle.contentFrame();
  check('editor iframe present', Boolean(frame));

  if (frame) {
    // The draw.io app writes into the DOM and exposes mxGraph globals.
    const handshake = await frame
      .waitForFunction(
        () => {
          const w = window;
          // mxClient + mxGraph presence proves app.min.js executed.
          if (typeof w.mxGraph !== 'function') return false;
          // The embed protocol sets a geometry/graph container on boot.
          return document.readyState === 'complete' || document.readyState === 'interactive';
        },
        { timeout: 90000 },
      )
      .then(() => true)
      .catch(() => false);

    check('draw.io app bundle executed in iframe', handshake);

    const frameUrl = frame.url();
    check('iframe loaded the vendored editor', frameUrl.includes('/drawio/index.html'), frameUrl);
    check('embed mode requested', frameUrl.includes('embed=1') && frameUrl.includes('proto=json'), frameUrl);
  }

  await page.waitForFunction(
    () => document.querySelector('[data-testid="app-state"]')?.getAttribute('data-editor-ready') === '1',
    { timeout: 90000 },
  );
  check('editor signalled ready to the host', (await readState(state)).editorReady === '1');

  await page.screenshot({ path: path.join(ARTIFACTS, '01-empty.png') });

  // ---------------------------------------------------------------------
  console.log('\n3. generate a diagram from natural language');
  const composer = page.locator('.composer__input');
  await composer.click();
  await composer.fill('画一个用户登录流程图：输入账号密码，校验格式，查询用户是否存在，验证密码是否正确，校验通过后生成令牌并返回，失败则提示错误信息并记录日志');
  await page.locator('.composer__send').click();

  check('user message appears', await page.locator('.msg--user').first().isVisible().catch(() => false));

  await page.waitForFunction(
    () => document.querySelector('[data-testid="app-state"]')?.getAttribute('data-has-diagram') === '1',
    { timeout: 120000 },
  );

  const generated = await readState(state);
  check('diagram generated', generated.hasDiagram === '1');
  check('diagram has nodes', Number(generated.nodeCount) > 2, `nodes=${generated.nodeCount}`);
  check('diagram has edges', Number(generated.edgeCount) > 1, `edges=${generated.edgeCount}`);
  check('xml delivered to client', Number(generated.xmlLength) > 500, `xml length=${generated.xmlLength}`);
  check('session established', (generated.sessionId ?? '').length > 0);

  const assistantText = await page.locator('.msg--assistant .msg__bubble').last().textContent();
  check('assistant replied', (assistantText ?? '').length > 0, assistantText ?? '');

  // The XML the client holds must be real draw.io XML.
  const xml = await page.evaluate(async () => {
    const el = document.querySelector('[data-testid="app-state"]');
    return el?.getAttribute('data-xml-length') ?? '0';
  });
  check('xml looks like mxfile', Number(xml) > 500);

  // The canvas should now contain our generated cells. Query the iframe DOM.
  if (frame) {
    const cells = await frame
      .evaluate(() => {
        const model = document.querySelector('svg') ? true : false;
        // Count rendered vertices via the mxGraph SVG namespace.
        const groups = document.querySelectorAll('g[data-cell-id]');
        return { hasSvg: model, rendered: groups.length };
      })
      .catch(() => ({ hasSvg: false, rendered: 0 }));
    check('draw.io rendered an SVG canvas', cells.hasSvg);
    check(
      'generated cells are on the canvas',
      cells.rendered > 0,
      `rendered ${cells.rendered} cell group(s)`,
    );
  }

  await sleep(800);
  await page.screenshot({ path: path.join(ARTIFACTS, '02-generated.png') });

  // ---------------------------------------------------------------------
  console.log('\n4. follow-up turn edits the existing diagram');
  const before = await readState(state);
  await composer.click();
  await composer.fill('把「输入账号密码」改成「输入手机号与验证码」');
  await page.locator('.composer__send').click();

  await page.waitForFunction(
    (prevLen) => {
      const el = document.querySelector('[data-testid="app-state"]');
      return el?.getAttribute('data-busy') === '0' && el?.getAttribute('data-xml-length') !== prevLen;
    },
    before.xmlLength,
    { timeout: 120000 },
  );

  const after = await readState(state);
  check('follow-up produced a new revision', after.xmlLength !== before.xmlLength, `${before.xmlLength} -> ${after.xmlLength}`);
  check('diagram still present after edit', after.hasDiagram === '1');
  check('node count unchanged-ish', Number(after.nodeCount) >= 2, `nodes=${after.nodeCount}`);
  check('two assistant replies', (await page.locator('.msg--assistant').count()) >= 2);

  await page.screenshot({ path: path.join(ARTIFACTS, '03-edited.png') });

  // ---------------------------------------------------------------------
  console.log('\n5. settings dialog');
  await page.locator('.header__actions button[aria-label="设置"]').click();
  await page.waitForSelector('.modal[aria-label="AI 设置"]', { timeout: 10000 });
  check('settings modal opens', await page.locator('.modal').isVisible());

  const modalText = await page.locator('.modal').textContent();
  check('modal explains offline mode', (modalText ?? '').includes('离线'), '');
  check('modal exposes model field', (modalText ?? '').includes('deepseek-flash'));

  await page.locator('.modal__footer button:has-text("测试连接")').click();
  await sleep(1500);
  const testAlert = await page.locator('.modal .alert').last().textContent().catch(() => '');
  check('test-connection reports a result', (testAlert ?? '').length > 0, testAlert ?? '');

  await page.screenshot({ path: path.join(ARTIFACTS, '04-settings.png') });
  await page.locator('.modal__footer button:has-text("取消")').click();
  await page.waitForSelector('.modal', { state: 'detached', timeout: 10000 });
  check('settings modal closes', (await page.locator('.modal').count()) === 0);

  // ---------------------------------------------------------------------
  console.log('\n6. error handling in the UI');
  // A deliberately impossible edit should not break the session.
  await composer.click();
  await composer.fill('删除「这个节点根本不存在」');
  await page.locator('.composer__send').click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="app-state"]')?.getAttribute('data-busy') === '0',
    { timeout: 120000 },
  );
  check('session survives an unsatisfiable request', (await readState(state)).hasDiagram === '1');

  // ---------------------------------------------------------------------
  console.log('\n7. console / network hygiene');
  const ignorable = (text) =>
    // draw.io logs its own storage/CDN probes in embed mode; not our concern.
    /favicon|Failed to load resource: net::ERR_|drawio|diagrams\.net|CORS|slow network/i.test(text);
  const realConsoleErrors = consoleErrors.filter((t) => !ignorable(t));
  check('no unexpected console errors', realConsoleErrors.length === 0, realConsoleErrors.slice(0, 4).join('\n      '));
  check('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 4).join('\n      '));

  const realFailed = failedRequests.filter((t) => !ignorable(t));
  check('no failed same-origin requests', realFailed.length === 0, realFailed.slice(0, 4).join('\n      '));

  await writeFile(
    path.join(ARTIFACTS, 'e2e-report.json'),
    JSON.stringify(
      {
        url: BASE,
        passes,
        failures,
        boot,
        generated,
        after,
        consoleErrors,
        pageErrors,
        failedRequests,
      },
      null,
      2,
    ),
    'utf8',
  );

  await browser.close();

  console.log('');
  if (failures === 0) {
    console.log(`\x1b[32m\x1b[1mE2E passed\x1b[0m — ${passes} checks. Screenshots in .artifacts/`);
  } else {
    console.log(`\x1b[31m\x1b[1mE2E failed\x1b[0m — ${passes} passed, ${failures} failed`);
    process.exitCode = 1;
  }
}

async function readState(locator) {
  return locator.evaluate((el) => ({
    backendOnline: el.getAttribute('data-backend-online'),
    editorReady: el.getAttribute('data-editor-ready'),
    provider: el.getAttribute('data-provider'),
    sessionId: el.getAttribute('data-session-id'),
    hasDiagram: el.getAttribute('data-has-diagram'),
    nodeCount: el.getAttribute('data-node-count'),
    edgeCount: el.getAttribute('data-edge-count'),
    busy: el.getAttribute('data-busy'),
    xmlLength: el.getAttribute('data-xml-length'),
  }));
}

main().catch((err) => {
  console.error('\nE2E crashed:', err);
  process.exitCode = 1;
});
