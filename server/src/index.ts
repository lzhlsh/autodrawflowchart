/**
 * AutoDrawFlowchart server.
 *
 * Serves the REST API and, when the web app has been built, the static frontend
 * (including the vendored self-hosted draw.io editor at /drawio).
 */
import express from 'express';
import compression from 'compression';
import cors from 'cors';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, providerMode, effectiveDeepSeek } from './config.js';
import { api } from './routes/api.js';
import { logger } from './util/logger.js';

const log = logger('server');

const app = express();
app.disable('x-powered-by');
// The draw.io editor is an iframe of our own origin, but keep this permissive
// for embedding into other tools during development.
app.use(cors({ origin: config.corsOrigins, credentials: true }));

// draw.io resources are ~140 MB of shapes/stencils; compression matters a lot.
app.use(
  compression({
    // Pre-compressed .svgz style assets and images are already small.
    filter: (req, res) => {
      const type = res.getHeader('Content-Type');
      if (typeof type === 'string' && /image\/(png|jpeg|gif|webp)|font/.test(type)) return false;
      return compression.filter(req, res);
    },
  }),
);

app.use(express.json({ limit: '12mb' }));

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
app.use('/api', api);

// ---------------------------------------------------------------------------
// Static frontend + vendored draw.io editor
// ---------------------------------------------------------------------------
const webDist = config.webDistDir;
const hasWebDist = existsSync(path.join(webDist, 'index.html'));

if (config.serveStatic && hasWebDist) {
  log.info(`serving built web app from ${webDist}`);

  // draw.io ships .js as text/javascript and asks for a few MIME types browsers
  // are picky about; express.static already handles these correctly.
  app.use(
    express.static(webDist, {
      index: false,
      setHeaders: (res, filePath) => {
        // The editor bundle is content-addressed by version, so it is safe to
        // cache aggressively; index.html must always revalidate.
        if (/\/drawio\//.test(filePath)) {
          res.setHeader('Cache-Control', 'public, max-age=86400');
        } else if (filePath.endsWith('index.html')) {
          res.setHeader('Cache-Control', 'no-cache');
        }
      },
    }),
  );

  // SPA fallback for client-side routes, but never for /api or asset paths.
  app.get(/^\/(?!api\/|drawio\/|assets\/).*/, (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(webDist, 'index.html'));
  });
} else {
  log.warn(
    `web build not found at ${webDist} — running API-only. ` +
      'Run `npm run build --workspace web` (or use `npm run dev` for the Vite dev server).',
  );
  app.get('/', (_req, res) => {
    res.json({
      service: 'AutoDrawFlowchart API',
      hint: 'Web app is not built. Use `npm run dev` (Vite on :5173) or `npm run build`.',
      api: '/api/health',
    });
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

/**
 * Start listening. Exported separately from module evaluation so that importing
 * this module (tests, tooling) does not open a socket on the configured port.
 */
export function start(): ReturnType<typeof app.listen> {
  const server = app.listen(config.port, config.host, () => {
    const { mode, reason } = providerMode();
    const ds = effectiveDeepSeek();

    log.info(`API listening on http://${config.host}:${config.port}`);
    log.info(`AI provider: ${mode} (${reason})`);
    if (mode === 'deepseek') {
      log.info(`  model   : ${ds.model}`);
      log.info(`  baseUrl : ${ds.baseUrl}`);
    } else {
      log.info('  Using the built-in offline rules engine. Set DEEPSEEK_API_KEY or use the in-app settings panel.');
    }
    log.info(
      `Web app : ${
        hasWebDist && config.serveStatic ? `http://${config.host}:${config.port}/` : 'not built — run `npm run build --workspace web`'
      }`,
    );
  });

  server.on('error', (err) => {
    log.error(`failed to bind ${config.host}:${config.port}`, err);
    process.exitCode = 1;
  });

  function shutdown(signal: string): void {
    log.info(`${signal} received, shutting down`);
    server.close(() => {
      log.info('closed');
      process.exit(0);
    });
    // Do not hang forever on a stuck connection.
    setTimeout(() => process.exit(1), 5000).unref();
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return server;
}

/**
 * True when this module is the process entry point (`node dist/index.js`) rather
 * than an import from a test or another module.
 */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    const here = fileURLToPath(import.meta.url);
    return path.resolve(entry) === path.resolve(here);
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  process.on('unhandledRejection', (reason) => log.error('unhandledRejection', reason));
  process.on('uncaughtException', (err) => {
    log.error('uncaughtException', err);
    process.exit(1);
  });
  start();
}

export { app };
