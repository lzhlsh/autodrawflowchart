/**
 * Test harness.
 *
 * Node's CLI test runner (`node --test`) executes every test file in a spawned
 * child process, which fails in sandboxes that deny `child_process.spawn`
 * (`spawn EPERM`). Node's programmatic `run()` API works in-process but does not
 * expose per-test pass/fail events or apply `testNamePatterns` reliably, so this
 * runner supplies its own tiny registry instead:
 *
 *   - `test/*.test.mjs` import `node:test`, which the module hook below redirects
 *     to `test/tiny-test.mjs`;
 *   - the registry collects tests as the files are imported;
 *   - the runner executes them with a per-test timeout and reports counts.
 *
 * Test tiers:
 *   - default   fast unit/protocol tests
 *   - `--all`   also `<name>.dom.test.mjs` files (slower; need a DOM shim)
 *
 * Usage:
 *   node test/run.mjs                 # fast tier
 *   node test/run.mjs --all           # everything
 *   node test/run.mjs --all App       # name filter (regex), any tier
 *   TEST_TIMEOUT_MS=120000 node test/run.mjs
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { register } from 'node:module';

const HERE = import.meta.dirname;
const TEST_FILE_RE = /\.test\.mjs$/;
/** Files matching this need a DOM and are slower. */
const DOM_FILE_RE = /\.dom\.test\.mjs$/;

const DEFAULT_TIMEOUT = Number(process.env.TEST_TIMEOUT_MS ?? 30_000);
const DOM_TEST_TIMEOUT = Number(process.env.APP_TEST_TIMEOUT_MS ?? 180_000);

const argv = process.argv.slice(2);
const INCLUDE_DOM = argv.includes('--all');
const FILTER = argv.find((a) => !a.startsWith('-'));

const COLOR = {
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  gray: '\x1b[90m',
  bold: '\x1b[1m',
  reset: '\x1b[0m',
};

// ---------------------------------------------------------------------------
// Redirect `node:test` to the local registry before any test file is imported.
// The hook file lives in the OS temp dir so the test collector never sees it.
// ---------------------------------------------------------------------------
const TINY = pathToFileURL(path.join(HERE, 'tiny-test.mjs')).href;
const { writeFileSync, rmSync } = await import('node:fs');
const { tmpdir } = await import('node:os');

const HOOK_FILE = path.join(tmpdir(), `adf-test-hook-${process.pid}.mjs`);
writeFileSync(
  HOOK_FILE,
  `export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'node:test') return { url: ${JSON.stringify(TINY)}, shortCircuit: true };
  return nextResolve(specifier, context);
}
`,
  'utf8',
);

register(pathToFileURL(HOOK_FILE).href, import.meta.url);

const { __getRegistry, __setFile } = await import(TINY);

async function collect(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await collect(full)));
    else if (TEST_FILE_RE.test(entry.name)) out.push(full);
  }
  return out.sort();
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms (${label})`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function main() {
  const dir = HERE;
  const all = await collect(dir);
  const files = INCLUDE_DOM ? all : all.filter((f) => !DOM_FILE_RE.test(f));

  if (files.length === 0) {
    console.error('no matching test files found under', dir);
    process.exitCode = 1;
    return;
  }

  const hasDomTest = files.some((f) => DOM_FILE_RE.test(f));
  const domSkipped = !INCLUDE_DOM && all.some((f) => DOM_FILE_RE.test(f));

  console.log(
    `${COLOR.bold}AutoDrawFlowchart tests${COLOR.reset} — ${files.length} file(s)` +
      `${FILTER ? `, filter /${FILTER}/i` : ''}` +
      `${hasDomTest ? ', DOM tier' : ''}\n`,
  );

  // Register all tests by importing the files.
  //
  // Ordering matters: DOM tests install process-wide shims (notably replacing
  // `globalThis.fetch` to route the app's HTTP at their own ephemeral server),
  // and the OpenAI SDK reads `globalThis.fetch` per request. Importing and
  // running non-DOM files first keeps the provider-compatibility tests on the
  // real transport. (We deliberately do NOT restore those globals afterwards:
  // the DOM test's own tests depend on its shims.)
  const ordered = [...files].sort((a, b) => Number(DOM_FILE_RE.test(a)) - Number(DOM_FILE_RE.test(b)));

  const importErrors = [];
  for (const file of ordered) {
    __setFile(path.relative(dir, file));
    try {
      await import(pathToFileURL(file).href);
    } catch (err) {
      importErrors.push({ file: path.relative(dir, file), message: err.message });
    }
  }
  __setFile('');

  let tests = __getRegistry();
  const filterRe = FILTER ? new RegExp(FILTER, 'i') : null;
  // Match against the test name OR its source file, so `run.mjs mxgraph` and
  // `run.mjs "layout"` both do what you would expect.
  if (filterRe) tests = tests.filter((t) => filterRe.test(t.name) || filterRe.test(t.file));

  // A `test.only` anywhere narrows the run, matching node:test semantics.
  const onlyTests = tests.filter((t) => t.only);
  if (onlyTests.length > 0) tests = onlyTests;

  if (importErrors.length > 0) {
    for (const e of importErrors) {
      console.log(`  ${COLOR.red}✗ import failed: ${e.file}${COLOR.reset}`);
      console.log(`      ${e.message}`);
    }
    console.log('');
  }

  if (tests.length === 0) {
    console.log(
      importErrors.length > 0
        ? `${COLOR.red}${COLOR.bold}✗ test files failed to import${COLOR.reset}`
        : `${COLOR.yellow}no tests matched${FILTER ? ` /${FILTER}/i` : ''}${COLOR.reset}`,
    );
    process.exitCode = 1;
    return;
  }

  const budget = hasDomTest ? DOM_TEST_TIMEOUT : DEFAULT_TIMEOUT;
  let pass = 0;
  let fail = 0;
  let skipped = 0;
  const failures = [];
  const started = Date.now();

  for (const t of tests) {
    if (t.skip) {
      skipped += 1;
      console.log(`  ${COLOR.gray}− ${t.name} (skipped)${COLOR.reset}`);
      continue;
    }
    const t0 = Date.now();
    try {
      await withTimeout(Promise.resolve().then(() => t.fn()), t.timeout ?? budget, t.name);
      pass += 1;
      console.log(`  ${COLOR.green}✓${COLOR.reset} ${t.name} ${COLOR.gray}(${Date.now() - t0}ms)${COLOR.reset}`);
    } catch (err) {
      fail += 1;
      failures.push({ name: t.name, err });
      console.log(`  ${COLOR.red}✗${COLOR.reset} ${t.name}`);
    }
  }

  console.log('');
  for (const { name, err } of failures) {
    console.log(`${COLOR.red}✗ ${name}${COLOR.reset}`);
    console.log(`  ${String(err?.message ?? err).split('\n').join('\n  ')}`);
    if (err?.expected !== undefined) {
      console.log(`  ${COLOR.gray}expected:${COLOR.reset} ${JSON.stringify(err.expected)}`);
      console.log(`  ${COLOR.gray}actual:  ${COLOR.reset} ${JSON.stringify(err.actual)}`);
    }
    const frame = String(err?.stack ?? '')
      .split('\n')
      .find((l) => l.includes('test/') || l.includes('test\\'));
    if (frame) console.log(`  ${COLOR.gray}${frame.trim()}${COLOR.reset}`);
    console.log('');
  }

  if (fail === 0 && importErrors.length === 0) {
    console.log(
      `${COLOR.green}${COLOR.bold}✓ ${pass} passed${COLOR.reset}` +
        `${skipped ? `, ${skipped} skipped` : ''} ${COLOR.gray}(${Date.now() - started}ms)${COLOR.reset}`,
    );
  } else {
    console.log(
      `${COLOR.red}${COLOR.bold}✗ ${fail} failed${COLOR.reset}, ${pass} passed` +
        `${skipped ? `, ${skipped} skipped` : ''}` +
        `${importErrors.length ? `, ${importErrors.length} import error(s)` : ''}`,
    );
    process.exitCode = 1;
  }

  if (domSkipped) {
    console.log(`${COLOR.gray}(DOM integration tests skipped — run with --all)${COLOR.reset}`);
  }

  rmSync(HOOK_FILE, { force: true });
}

main().catch((err) => {
  console.error('runner crashed:', err);
  process.exitCode = 1;
});
