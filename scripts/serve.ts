#!/usr/bin/env bun
/**
 * Dev serve — run diffstalkerd straight from source with `bun --watch`, so it is
 * always up to date with the daemon code (auto-restarts on change), in debug mode
 * (Bun inspector on 127.0.0.1:17337), serving the web UI same-origin at
 * http://localhost:7337/.
 *
 *   bun run serve                    # serve; follow the hook file
 *   bun run serve ~/proj-a ~/proj-b  # ...and pre-open these repos
 *
 * The web bundle is rebuilt once at startup so the served assets match current
 * source. For LIVE web HMR while iterating on the UI, run `bun run dev:web`
 * instead (Vite at http://localhost:5173, which proxies the API to :7337).
 *
 * Binds :7337 like the `diffstalkerd-web` systemd service — stop that first so the
 * port is free:  systemctl --user stop diffstalkerd-web
 *
 * (A source run resolves its web-root to src/web, which doesn't exist, so we pass
 * --web-root explicitly at dist/web. Core is imported via its dist, so a change to
 * @diffstalker/core needs `bun run build` to take effect; daemon-only changes are
 * picked up live by --watch.)
 */
import { spawn, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 7337;
const INSPECT = '127.0.0.1:17337';
const WEB_ROOT = join(ROOT, 'packages/daemon/dist/web');
const FOLLOW = join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'diffstalker', 'target');
const repos = process.argv.slice(2).map((p) => resolve(p));

// Fail fast if the port is already serving (usually the systemd service).
const portBusy = await fetch(`http://127.0.0.1:${PORT}/health`)
  .then(() => true)
  .catch(() => false);
if (portBusy) {
  console.error(
    `port ${PORT} is already serving (the systemd service?). Stop it first:\n` +
      `  systemctl --user stop diffstalkerd-web`
  );
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
console.log(`serve: http://localhost:${PORT}/   ·   Bun inspector on ${INSPECT}`);
const daemon = spawn(
  'bun',
  [
    `--inspect=${INSPECT}`,
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
