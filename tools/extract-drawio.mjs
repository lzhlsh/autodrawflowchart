// Extract the draw.io webapp (the static editor) from the downloaded tarball.
//
// We deliberately vendor the *upstream* editor rather than reimplementing it:
// jgraph/drawio ships a fully self-contained static webapp under
// src/main/webapp, so it can be served by any static host with no Java/Tomcat.
//
// Usage: node tools/extract-drawio.mjs
import { mkdir, readdir, rm, stat, cp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '..');
// fetch-drawio.mjs flattens the (CRC-corrupt but complete) gzip tarball into a
// plain .tar, because the strict gzip reader inside `tar` aborts on the footer.
const TARBALL = path.join(ROOT, 'vendor', 'drawio-dev.tar');
const STAGE = path.join(ROOT, 'vendor', 'drawio-src');
const DEST = path.join(ROOT, 'web', 'public', 'drawio');

// Directories we do not need for an embedded AI editor. `templates` alone is
// tens of megabytes of thumbnails; the template dialog is not used here.
const EXCLUDE_TOP = new Set(['templates', 'connect', 'math4']);

async function main() {
  if (!(await exists(TARBALL))) {
    throw new Error(`missing ${TARBALL} — run: node tools/fetch-drawio.mjs`);
  }

  await mkdir(STAGE, { recursive: true });
  const tar = require('tar');
  console.log('[extract-drawio] extracting src/main/webapp …');
  await tar.x({
    file: TARBALL,
    cwd: STAGE,
    // Archive paths are `drawio-dev/src/main/webapp/<rest>`; stripping 4
    // segments drops the whole prefix so <rest> lands at the staging root.
    strip: 4,
    filter: (p) => {
      const m = /^[^/]+\/src\/main\/webapp\/(.*)$/.exec(p.replace(/\\/g, '/'));
      if (!m) return false;
      const rest = m[1];
      if (!rest) return true;
      const top = rest.split('/')[0];
      return !EXCLUDE_TOP.has(top);
    },
  });

  await rm(DEST, { recursive: true, force: true });
  await mkdir(path.dirname(DEST), { recursive: true });
  console.log('[extract-drawio] copying to web/public/drawio …');
  await cp(STAGE, DEST, { recursive: true });

  // Quick sanity check: these are the files the editor cannot start without.
  for (const required of ['index.html', 'js/main.js', 'js/app.min.js', 'styles/grapheditor.css']) {
    if (!(await exists(path.join(DEST, required)))) {
      throw new Error(`extracted tree is incomplete: missing ${required}`);
    }
  }

  const size = await dirSize(DEST);
  const entries = await readdir(DEST);
  console.log(
    `[extract-drawio] ok — ${entries.length} entries, ${(size / 1048576).toFixed(1)} MB at ${DEST}`,
  );
  console.log(`[extract-drawio] top-level: ${entries.join(', ')}`);

  // The staging copy is redundant once vendored.
  await rm(STAGE, { recursive: true, force: true });
}

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function dirSize(dir) {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await dirSize(full);
    else total += (await stat(full)).size;
  }
  return total;
}

main().catch((err) => {
  console.error('[extract-drawio] ERROR:', err.message);
  process.exit(1);
});
