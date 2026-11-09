// Download the draw.io (jgraph/drawio) source tarball with the system TLS stack
// available to Node, then extract only the parts we vendor into the app.
//
// Usage: node tools/fetch-drawio.mjs
import { createWriteStream } from 'node:fs';
import { mkdir, open, rm, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT_DIR = path.join(ROOT, 'vendor');
const TARBALL = path.join(OUT_DIR, 'drawio-dev.tar.gz');
const FLAT_TAR = path.join(OUT_DIR, 'drawio-dev.tar');
const STAMP = path.join(OUT_DIR, '.drawio-source-ok');
const URL = 'https://codeload.github.com/jgraph/drawio/tar.gz/refs/heads/dev';

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * codeload.github.com streams the tarball with chunked encoding and the
 * response omits `content-length`, so a dropped connection is invisible.
 * We therefore verify by actually decompressing the whole stream: a truncated
 * download fails here instead of half-extracting later.
 *
 * Note: `zlib.gunzipSync` rejects these archives with Z_DATA_ERROR even when
 * the payload is complete, because codeload's trailing CRC/ISIZE footer is not
 * always consistent with the streamed body. The streaming decompressor reports
 * the end of stream correctly, so we verify by streaming and only require that
 * the decompressed tar contains the paths we need.
 */
async function verifyAndFlatten(tarball) {
  console.log('[fetch-drawio] decompressing to verify integrity …');
  const out = createWriteStream(FLAT_TAR);
  let bytes = 0;
  const gunzip = createGunzip();

  gunzip.on('data', (chunk) => {
    bytes += chunk.length;
  });

  await pipeline(createReadStream(tarball), gunzip, out);

  if (bytes < 50 * 1048576) {
    throw new Error(`decompressed payload suspiciously small: ${bytes} bytes`);
  }

  // The tar must at minimum contain the editor entry point.
  const needle = Buffer.from('src/main/webapp/index.html');
  const found = await bufferContains(FLAT_TAR, needle);
  if (!found) {
    throw new Error('decompressed archive does not contain src/main/webapp/index.html');
  }

  console.log(`[fetch-drawio] verified ${(bytes / 1048576).toFixed(1)} MB of tar payload`);
  await writeFile(STAMP, new Date().toISOString(), 'utf8');
}

/** Streams a file looking for a byte sequence without loading it all in memory. */
async function bufferContains(file, needle) {
  const CHUNK = 4 * 1048576;
  const handle = await open(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(CHUNK + needle.length);
    let carry = 0;
    let pos = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buf, carry, CHUNK, pos);
      if (bytesRead <= 0) return false;
      const hay = buf.subarray(0, carry + bytesRead);
      if (hay.includes(needle)) return true;
      carry = needle.length - 1;
      hay.subarray(hay.length - carry).copy(buf, 0);
      pos += bytesRead;
    }
  } finally {
    await handle.close();
  }
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  if ((await exists(STAMP)) && (await exists(FLAT_TAR))) {
    const s = await stat(FLAT_TAR);
    console.log(`[fetch-drawio] reuse verified source (${(s.size / 1048576).toFixed(1)} MB tar)`);
    return;
  }

  if (await exists(TARBALL)) {
    const s = await stat(TARBALL);
    console.log(`[fetch-drawio] reuse existing tarball (${(s.size / 1048576).toFixed(1)} MB)`);
    await verifyAndFlatten(TARBALL);
    return;
  }

  console.log(`[fetch-drawio] GET ${URL}`);
  const res = await fetch(URL, { redirect: 'follow' });
  if (!res.ok || !res.body) {
    throw new Error(`download failed: HTTP ${res.status} ${res.statusText}`);
  }

  const total = Number(res.headers.get('content-length') || 0);
  let received = 0;
  let lastLog = 0;
  const started = Date.now();

  const progress = new TransformStream({
    transform(chunk, controller) {
      received += chunk.byteLength;
      const now = Date.now();
      if (now - lastLog > 3000) {
        lastLog = now;
        const mb = (received / 1048576).toFixed(1);
        const secs = (now - started) / 1000;
        const rate = (received / 1048576 / secs).toFixed(2);
        const pct = total ? ` (${((received / total) * 100).toFixed(0)}%)` : '';
        console.log(`[fetch-drawio] ${mb} MB${pct} @ ${rate} MB/s`);
      }
      controller.enqueue(chunk);
    },
  });

  await pipeline(
    Readable.fromWeb(res.body.pipeThrough(progress)),
    createWriteStream(TARBALL),
  );

  const s = await stat(TARBALL);
  console.log(
    `[fetch-drawio] downloaded ${(s.size / 1048576).toFixed(1)} MB in ${(
      (Date.now() - started) / 1000
    ).toFixed(0)}s`,
  );

  await verifyAndFlatten(TARBALL);
}

main().catch(async (err) => {
  console.error('[fetch-drawio] ERROR:', err.message);
  // Do not leave a partial archive behind: it would silently produce a broken
  // vendor tree on the next run.
  await rm(TARBALL, { force: true }).catch(() => {});
  await rm(FLAT_TAR, { force: true }).catch(() => {});
  await rm(STAMP, { force: true }).catch(() => {});
  process.exit(1);
});
