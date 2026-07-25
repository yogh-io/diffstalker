#!/usr/bin/env bun
/**
 * Dev serve — the LOCAL dev UI on http://localhost:17337/, with full HMR.
 *
 * :17337 IS the Vite dev server: it serves the web UI from source (instant
 * hot-module reload — edit a .vue/.ts and the browser updates with no
 * rebuild and no refresh) and proxies the daemon's API (REST + SSE) to a
 * dev daemon running on an internal port (:17338). The dev daemon runs
 * straight from source with `bun --watch` (auto-restarts on daemon-code
 * change) with the Bun inspector attached.
 *
 * This is the DEV counterpart to :7337, which runs the RELEASED diffstalkerd
 * from npm (the stable, published build — a separate systemd service, left
 * untouched). Run both side by side: :7337 = release, :17337 = dev.
 *
 *   bun run serve                    # serve; follow the hook file
 *   bun run serve ~/proj-a ~/proj-b  # ...and pre-open these repos
 *
 * NOTE: dev serves the SPA via Vite + proxy, while prod serves it from the
 * daemon's static dist same-origin — a deliberate dev/prod divergence
 * traded for HMR. The daemon and the app code are identical either way; the
 * proxy (vite.config.ts) forwards /health, /repos (+ /repos/:id/events SSE),
 * /events, /follow to the dev daemon. @diffstalker/core is imported via its
 * dist, so a change there needs `bun run build`; daemon-only changes are
 * picked up live; web changes are HMR'd.
 */
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const UI_PORT = 17337; // Vite dev server (what you open)
const DAEMON_PORT = 17338; // dev daemon (API only; Vite proxies to it)
const DAEMON_URL = `http://127.0.0.1:${DAEMON_PORT}`;
const FOLLOW = join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'diffstalker', 'target');
const repos = process.argv.slice(2).map((p) => resolve(p));

const children: ReturnType<typeof spawn>[] = [];
function killAll(sig: NodeJS.Signals): void {
  for (const child of children) child.kill(sig);
}
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => killAll(sig));
}

/** Is something already listening on 127.0.0.1:port? (leftover dev server) */
function isPortBusy(port: number): Promise<boolean> {
  return new Promise((res) => {
    const sock = createConnection({ host: '127.0.0.1', port });
    sock.setTimeout(500);
    const done = (busy: boolean): void => {
      sock.destroy();
      res(busy);
    };
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => res(false));
  });
}

for (const [name, port] of [
  ['UI', UI_PORT],
  ['daemon', DAEMON_PORT],
] as const) {
  if (await isPortBusy(port)) {
    console.error(
      `port ${port} (${name}) is already serving — an old dev server? Stop it (Ctrl-C / kill) first.`
    );
    process.exit(1);
  }
}

// 1. dev daemon from source (API only — Vite serves the UI): watched +
//    inspectable. No --web-root: the daemon logs one API-only line and
//    serves the API; the SPA comes from Vite.
console.log(`serve: dev daemon on ${DAEMON_URL}   (Bun inspector below)`);
const daemon = spawn(
  'bun',
  ['--inspect', '--watch', 'packages/daemon/src/index.ts', '--port', String(DAEMON_PORT), '--follow-file', FOLLOW],
  { cwd: ROOT, stdio: 'inherit' }
);
children.push(daemon);
daemon.on('exit', (code) => {
  killAll('SIGTERM');
  process.exit(code ?? 0);
});

// 2. wait for the daemon to answer, then start Vite (so its first proxied
//    request has somewhere to land) and pre-open any repos.
for (let i = 0; i < 50; i++) {
  const ok = await fetch(`${DAEMON_URL}/health`)
    .then((r) => r.ok)
    .catch(() => false);
  if (ok) break;
  await new Promise((r) => setTimeout(r, 200));
}

console.log(`serve: Vite dev UI (HMR) on http://localhost:${UI_PORT}/`);
const vite = spawn('bun', ['run', 'dev', '--', '--port', String(UI_PORT), '--strictPort'], {
  cwd: join(ROOT, 'packages/web'),
  env: { ...process.env, DIFFSTALKER_DAEMON_URL: DAEMON_URL },
  stdio: 'inherit',
});
children.push(vite);
vite.on('exit', (code) => {
  killAll('SIGTERM');
  process.exit(code ?? 0);
});

// 3. pre-open any repos passed as args (POST straight to the daemon).
for (const path of repos) {
  const ok = await fetch(`${DAEMON_URL}/repos`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path }),
  })
    .then((r) => r.ok)
    .catch(() => false);
  console.log(`serve: ${ok ? 'opened' : 'FAILED to open'} ${path}`);
}
