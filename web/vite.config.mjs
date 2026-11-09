import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Vite config (plain ESM).
 *
 * Kept as `.mjs` rather than `.ts` on purpose: Vite bundles a TypeScript config
 * through esbuild, which spawns a helper process. Plain ESM is imported
 * directly, so the build works in restricted/sandboxed environments where
 * spawning a child process is not permitted.
 *
 * The self-hosted draw.io editor lives in `public/drawio` (vendored from
 * jgraph/drawio by `npm run setup`) and is copied verbatim into the build — the
 * ~140 MB editor tree is never processed by the bundler.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      // Keeps the browser same-origin with the API, so no CORS in dev.
      '/api': {
        target: 'http://127.0.0.1:5174',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsInlineLimit: 4096,
    chunkSizeWarningLimit: 1200,
    sourcemap: false,
  },
});
