#!/usr/bin/env bun
/**
 * Dev serve — the LOCAL, always-current diffstalkerd, on http://localhost:17337/.
 *
 * Runs the daemon straight from source with `bun --watch`, so it is always up to date
 * with the daemon code (auto-restarts on change), with the Bun inspector attached
 * (debug URL printed on startup). Serves the freshly-built web UI same-origin.
 *
 * This is the DEV counterpart to :7337, which runs the RELEASED diffstalkerd from npm
 * (the stable, published build — a separate systemd service, left untouched). Run both
 * side by side: :7337 = release, :17337 = dev.
 *
 *   bun run serve                    # serve; follow the hook file
 *   bun run serve ~/proj-a ~/proj-b  # ...and pre-open these repos
 *
 * The web bundle is rebuilt once at startup so the served assets match current source.
 * For LIVE web HMR while iterating on the UI, run `bun run dev:web` instead
 * (Vite at http://localhost:5173, which proxies the API to :17337 — set its target
 * with DIFFSTALKER_DAEMON_URL=http://127.0.0.1:17337).
 *
 * (A source run resolves its web-root to src/web, which doesn't exist, so we pass
 * --web-root explicitly at dist/web. @diffstalker/core is imported via its dist, so a
 * change there needs `bun run build`; daemon-only changes are picked up live.)
 */
import { spawn, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 17337;
const WEB_ROOT = join(ROOT, 'packages/daemon/dist/web');
const FOLLOW = join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'diffstalker', 'target');
const repos = process.argv.slice(2).map((p) => resolve(p));

// Fail fast if the dev port is already serving (a leftover dev server).
const portBusy = await fetch(`http://127.0.0.1:${PORT}/health`)
  .then(() => true)
  .catch(() => false);
if (portBusy) {
  console.error(`port ${PORT} is already serving — an old dev server? Stop it (Ctrl-C / kill) first.`);
  process.exit(1);
}

// 1. rebuild the web UI so the served assets match current source.
console.log('serve: building web UI…');
const build = spawnSync('bun', ['run', 'build:web'], {
  cwd: join(ROOT, 'packages/daemon'),
  stdio: 'inherit',
});
if (build.status !== 0) process.exit(build.status ?? 1);

// 2. run the daemon from source: watched (auto-restart) + inspectable.
console.log(`serve: dev daemon on http://localhost:${PORT}/   (Bun inspector below)`);
const daemon = spawn(
  'bun',
  [
    '--inspect',
    '--watch',
    'packages/daemon/src/index.ts',
    '--port',
    String(PORT),
    '--web-root',
    WEB_ROOT,
    '--follow-file',
    FOLLOW,
  ],
  { cwd: ROOT, stdio: 'inherit' }
);
daemon.on('exit', (code) => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => daemon.kill(sig));
}

// 3. pre-open any repos passed as args, once the daemon answers.
if (repos.length > 0) {
  for (let i = 0; i < 50; i++) {
    const ok = await fetch(`http://127.0.0.1:${PORT}/health`)
      .then((r) => r.ok)
      .catch(() => false);
    if (ok) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  for (const path of repos) {
    const ok = await fetch(`http://127.0.0.1:${PORT}/repos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path }),
    })
      .then((r) => r.ok)
      .catch(() => false);
    console.log(`serve: ${ok ? 'opened' : 'FAILED to open'} ${path}`);
  }
}
