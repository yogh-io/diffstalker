/// <reference types="vitest/config" />
/**
 * Vite config for the diffstalker web UI.
 *
 * Dev: `vite dev` proxies the daemon's API paths (REST + SSE) to a locally
 * running `diffstalkerd --port N`. Default target is
 * http://127.0.0.1:7337 — start the daemon with `diffstalkerd --port 7337`,
 * or point DIFFSTALKER_DAEMON_URL at another host:port.
 *
 * Prod: `vite build` emits a static dist/ (index.html + hashed assets)
 * that the daemon serves same-origin at GET / (no proxy involved).
 */

import { isBuiltin } from 'node:module';
import { defineConfig, type Plugin } from 'vite';
import vue from '@vitejs/plugin-vue';

/**
 * Fail the build when anything in the web bundle imports a Node builtin.
 *
 * Left alone, Vite swaps the builtin for an empty stub and only warns: the
 * build passes and the page dies on load the moment the module runs Node
 * code at import time. That shipped once: a web store imported a VALUE
 * from core's Node-only git/diff, and a later change made that module call
 * util.promisify when loaded. The tests run in Node, where the builtin
 * exists, so only the build can catch it.
 */
function noNodeBuiltins(): Plugin {
  return {
    name: 'diffstalker-no-node-builtins',
    enforce: 'pre',
    apply: 'build',
    resolveId(source, importer) {
      if (isBuiltin(source)) {
        this.error(`Node builtin "${source}" imported by ${importer ?? 'the entry'}: Node-only code reached the web bundle`);
      }
      return null;
    },
  };
}

const daemonUrl = process.env.DIFFSTALKER_DAEMON_URL ?? 'http://127.0.0.1:7337';

/**
 * Every TOP-LEVEL path the daemon's API answers; these must never fall
 * through to the SPA. Only dev uses this — in prod the daemon serves the
 * SPA itself and its router claims these paths first — which is exactly
 * what makes a miss here so easy to ship: a new top-level route works in
 * prod and silently returns index.html in dev, so the client sees HTML
 * where it expected JSON. `devProxy.test.ts` derives the real set from
 * the daemon's route registrations and fails if this list drifts.
 */
export const apiPaths = [
  '/health',
  '/version',
  '/repos',
  '/events',
  '/follow',
  '/worktrees',
  '/resolve',
  '/settings',
  '/discovered',
  '/browse',
];

export default defineConfig({
  plugins: [vue(), noNodeBuiltins()],
  base: '/',
  build: {
    outDir: 'dist',
  },
  server: {
    proxy: Object.fromEntries(
      apiPaths.map((path) => [
        path,
        // SSE (/events, /repos/:id/events) streams through the same proxy.
        { target: daemonUrl, changeOrigin: true },
      ])
    ),
  },
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.ts'],
  },
});
