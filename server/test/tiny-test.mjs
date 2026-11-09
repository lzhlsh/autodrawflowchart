/**
 * Minimal in-process test library.
 *
 * Provides the subset of `node:test` this project uses (`test(name, fn)` plus
 * `describe`/`it` aliases) with an explicit registry, so `test/run.mjs` can run
 * tests, filter by name, apply per-test timeouts and report accurate counts.
 *
 * Node's own programmatic runner executes test files in spawned child processes,
 * which is unavailable in sandboxes that deny `child_process.spawn`. Rather than
 * depend on that, the runner redirects `node:test` imports here via a module
 * customization hook.
 */

/** @type {Array<{name: string, fn: Function|null, file: string, skip?: boolean, todo?: boolean, only?: boolean, timeout?: number}>} */
const registry = [];

let currentSuite = '';
/** Source file currently being imported, set by the runner. */
let currentFile = '';

/** Register a test. Mirrors `test(name, fn)` and `test(name, options, fn)`. */
export function test(name, options, fn) {
  const actualFn = typeof options === 'function' ? options : fn;
  const actualOptions = typeof options === 'function' ? {} : (options ?? {});
  if (typeof actualFn !== 'function') {
    throw new TypeError(`test("${name}") requires a function`);
  }
  const fullName = currentSuite ? `${currentSuite} › ${name}` : name;

  if (actualOptions.skip) {
    registry.push({ name: fullName, fn: null, file: currentFile, skip: true, timeout: actualOptions.timeout });
    return;
  }

  // `only` acts as a filter: if any test is marked only, run just those.
  registry.push({
    name: fullName,
    fn: actualFn,
    file: currentFile,
    skip: false,
    only: Boolean(actualOptions.only),
    timeout: actualOptions.timeout,
  });
}

/** Alias used by some test styles. */
export const it = test;

/**
 * Group tests under a name. Suites are flattened into the test name, which keeps
 * the registry a flat list and makes filtering predictable.
 */
export function describe(name, options, fn) {
  const actualFn = typeof options === 'function' ? options : fn;
  if (typeof actualFn !== 'function') {
    throw new TypeError(`describe("${name}") requires a function`);
  }
  const previous = currentSuite;
  currentSuite = previous ? `${previous} › ${name}` : name;
  try {
    actualFn();
  } finally {
    currentSuite = previous;
  }
}

describe.skip = (name, fn) => {
  void name;
  void fn;
};
// `import test from 'node:test'` must also work, so the default export is the
// `test` function itself (with the named helpers attached as properties).
test.skip = (name, options, fn) => {
  const actualOptions = typeof options === 'function' ? {} : (options ?? {});
  test(name, { ...actualOptions, skip: true }, typeof options === 'function' ? options : fn);
};
test.todo = (name) => {
  registry.push({ name, fn: null, skip: true, todo: true });
};
test.describe = describe;
test.it = it;

/** Hooks are accepted for API compatibility; this harness has no nested scopes. */
export const before = () => {};
export const after = () => {};
export const beforeEach = () => {};
export const afterEach = () => {};

export default test;

// ---------------------------------------------------------------------------
// Runner-facing API (not part of the node:test surface)
// ---------------------------------------------------------------------------

export function __getRegistry() {
  return registry;
}

/** Tell the registry which file the tests being registered came from. */
export function __setFile(file) {
  currentFile = file;
}

export function __resetRegistry() {
  registry.length = 0;
  currentSuite = '';
  currentFile = '';
}
