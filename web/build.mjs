/**
 * Frontend build with a portable fallback.
 *
 * Primary path: `vite build`.
 * Fallback:     Rollup + the TypeScript compiler API.
 *
 * Why the fallback exists: Vite delegates to esbuild, which runs a helper
 * process over stdio pipes. In restricted/sandboxed environments that spawn is
 * denied (`spawn EPERM`), so Vite cannot start at all — even to build. The
 * fallback uses only pure-JavaScript tooling (rollup + tsc) that runs in-process,
 * so the project builds everywhere Node does.
 *
 * Usage:
 *   node build.mjs            # try Vite, fall back automatically
 *   node build.mjs --rollup   # force the portable path
 *   node build.mjs --vite     # force Vite (fail loudly if unavailable)
 */
import { existsSync } from 'node:fs';
import { cp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const HERE = import.meta.dirname;
const DIST = path.join(HERE, 'dist');
const PUBLIC = path.join(HERE, 'public');

const forceRollup = process.argv.includes('--rollup');
const forceVite = process.argv.includes('--vite');

async function dirSize(dir) {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? await dirSize(full) : (await stat(full)).size;
  }
  return total;
}

/** Can esbuild actually run here? Vite needs it for config + transforms. */
function esbuildUsable() {
  // `spawnSync` is used deliberately: the probe must observe a real spawn
  // failure rather than crash the build process.
  const probe = spawnSync(
    process.execPath,
    [
      '-e',
      "require('esbuild').transformSync('const a=1',{loader:'ts'});console.log('ESBUILD_OK')",
    ],
    { cwd: HERE, encoding: 'utf8', timeout: 30000 },
  );
  return probe.status === 0 && (probe.stdout ?? '').includes('ESBUILD_OK');
}

async function buildWithVite() {
  console.log('[build] using vite');
  const { build } = await import('vite');
  await build({ configFile: path.join(HERE, 'vite.config.mjs'), logLevel: 'info' });
}

/**
 * Portable build: transpile TS/TSX in-process with the TypeScript compiler API,
 * then bundle with Rollup.
 */
async function buildWithRollup() {
  console.log('[build] using rollup + typescript (portable path)');
  const ts = (await import('typescript')).default;
  const { rollup } = await import('rollup');
  const { nodeResolve } = await import('@rollup/plugin-node-resolve');
  const commonjs = await import('@rollup/plugin-commonjs');

  // --- 1. transpile every source file into a temp tree ------------------
  const tmp = path.join(HERE, '.build-tmp');
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });

  const configFile = ts.readConfigFile(path.join(HERE, 'tsconfig.json'), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, HERE);
  const compilerOptions = {
    ...parsed.options,
    // Rollup resolves modules; emit ESM and keep JSX as React.createElement via
    // the classic runtime so no import is injected behind Rollup's back.
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.ReactJSX,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    isolatedModules: true,
    sourceMap: false,
    inlineSourceMap: false,
    declaration: false,
    noEmit: false,
    outDir: tmp,
    rootDir: path.join(HERE, 'src'),
  };

  const files = await collect(path.join(HERE, 'src'));
  console.log(`[build] transpiling ${files.length} modules`);

  for (const file of files) {
    const source = await import('node:fs').then((fs) => fs.readFileSync(file, 'utf8'));
    const out = ts.transpileModule(source, {
      compilerOptions,
      fileName: file,
      reportDiagnostics: true,
    });
    const errors = (out.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error);
    if (errors.length > 0) {
      const text = errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' ')).join('; ');
      throw new Error(`transpile failed for ${path.relative(HERE, file)}: ${text}`);
    }
    const rel = path.relative(path.join(HERE, 'src'), file).replace(/\.tsx?$/, '.js');
    const dest = path.join(tmp, rel);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, out.outputText, 'utf8');
  }

  // --- 2. bundle --------------------------------------------------------
  const entry = path.join(tmp, 'main.js');
  if (!existsSync(entry)) throw new Error('transpiled entry not found: ' + entry);

  const bundle = await rollup({
    input: entry,
    // React and friends are resolved from node_modules; nothing is external
    // because the browser cannot resolve bare specifiers.
    plugins: [
      cssPlugin(),
      nodeResolve({ browser: true, extensions: ['.mjs', '.js', '.json'] }),
      commonjs.default ? commonjs.default({ transformMixedEsModules: true }) : commonjs({ transformMixedEsModules: true }),
    ],
    onwarn(warning, warn) {
      // React's CJS build and "use client" directives produce noisy warnings
      // that do not affect correctness.
      if (warning.code === 'CIRCULAR_DEPENDENCY') return;
      if (warning.code === 'MODULE_LEVEL_DIRECTIVE') return;
      warn(warning);
    },
  });

  await rm(DIST, { recursive: true, force: true });
  await mkdir(path.join(DIST, 'assets'), { recursive: true });

  const { output } = await bundle.generate({
    format: 'es',
    entryFileNames: 'assets/[name]-[hash].js',
    chunkFileNames: 'assets/[name]-[hash].js',
    assetFileNames: 'assets/[name]-[hash][extname]',
    sourcemap: false,
    // React reads process.env.NODE_ENV at import time.
    intro: 'var process=globalThis.process||{env:{NODE_ENV:"production"}};',
  });

  let jsFile = '';
  let cssFile = '';
  for (const chunk of output) {
    if (chunk.type === 'chunk') {
      const name = chunk.fileName;
      await writeFile(path.join(DIST, name), chunk.code, 'utf8');
      if (chunk.isEntry) jsFile = name;
    } else if (chunk.type === 'asset') {
      const name = chunk.fileName;
      if (name.endsWith('.css')) {
        await writeFile(path.join(DIST, name), String(chunk.source), 'utf8');
        cssFile = name;
      }
    }
  }
  await bundle.close();

  if (!jsFile) throw new Error('bundle produced no entry chunk');

  // --- 3. index.html ----------------------------------------------------
  // Read the source html so the app shell stays identical to the Vite path.
  const fs = await import('node:fs');
  let html = fs.readFileSync(path.join(HERE, 'index.html'), 'utf8');
  if (cssFile) {
    html = html.replace(
      '</head>',
      `    <link rel="stylesheet" href="/${cssFile}" />\n  </head>`,
    );
  }
  html = html.replace(
    /<script type="module" src="\/src\/main\.tsx"><\/script>/,
    `<script type="module" src="/${jsFile}"></script>`,
  );
  await writeFile(path.join(DIST, 'index.html'), html, 'utf8');

  await rm(tmp, { recursive: true, force: true });

  const size = await dirSize(DIST);
  console.log(`[build] dist ready (${(size / 1048576).toFixed(1)} MB)`);
  console.log(`[build] entry: /${jsFile}${cssFile ? `  css: /${cssFile}` : ''}`);
}

/**
 * Minimal CSS handling for the Rollup path.
 *
 * Only the source `src/` tree is transpiled into `.build-tmp`, so stylesheets are
 * not on disk where Rollup can resolve them. We intercept CSS specifiers and
 * resolve them against the real source directory instead, then emit one bundled
 * stylesheet that index.html links to.
 */
function cssPlugin() {
  const SRC = path.join(HERE, 'src');
  const VIRTUAL = '\0adf-css:';
  const sheets = new Map(); // virtual id -> css text
  const order = [];

  return {
    name: 'adf-css',

    resolveId(source, importer) {
      if (!source.endsWith('.css')) return null;
      // The importer path points at the transpiled copy under `.build-tmp`;
      // map it back to the real `src/` tree so stylesheets resolve on disk.
      const base = importer
        ? importer.replace(/[\\/]\.build-tmp[\\/]/, `${path.sep}src${path.sep}`)
        : path.join(SRC, 'main.tsx');
      const resolved = source.startsWith('.')
        ? path.resolve(path.dirname(base), source)
        : path.resolve(SRC, source);
      return VIRTUAL + resolved;
    },

    async load(id) {
      if (!id.startsWith(VIRTUAL)) return null;
      const file = id.slice(VIRTUAL.length);
      const fs = await import('node:fs');
      if (!sheets.has(file)) {
        sheets.set(file, fs.readFileSync(file, 'utf8'));
        order.push(file);
      }
      // The stylesheet is emitted separately; the import becomes a no-op.
      return 'export default undefined;';
    },

    generateBundle() {
      if (order.length === 0) return;
      const css = order.map((file) => sheets.get(file)).join('\n');
      this.emitFile({ type: 'asset', fileName: 'assets/app.css', source: css });
    },
  };
}

async function collect(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await collect(full)));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out.sort();
}

/**
 * Copy `public/` into `dist/`. Vite does this itself; the Rollup path must do it
 * explicitly so the vendored draw.io editor ships with the build.
 */
async function copyPublic() {
  if (!existsSync(PUBLIC)) return;
  console.log('[build] copying public/ (includes the self-hosted draw.io editor)');
  await cp(PUBLIC, DIST, { recursive: true, force: true });
}

async function main() {
  if (forceRollup) {
    await buildWithRollup();
    await copyPublic();
    return;
  }
  if (forceVite) {
    await buildWithVite();
    return;
  }
  if (esbuildUsable()) {
    try {
      await buildWithVite();
      return;
    } catch (err) {
      console.warn(`[build] vite failed (${err.message}); falling back to rollup`);
    }
  } else {
    console.warn('[build] esbuild is unavailable in this environment (spawn EPERM) — using the portable rollup path');
  }
  await buildWithRollup();
  await copyPublic();
}

main().catch((err) => {
  console.error('[build] ERROR:', err);
  process.exit(1);
});
