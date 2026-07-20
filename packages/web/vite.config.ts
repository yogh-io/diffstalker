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

import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

const daemonUrl = process.env.DIFFSTALKER_DAEMON_URL ?? 'http://127.0.0.1:7337';

/** Everything the daemon's API answers; these must never fall through to the SPA. */
const apiPaths = ['/health', '/repos', '/events', '/follow'];

export default defineConfig({
  plugins: [vue()],
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
