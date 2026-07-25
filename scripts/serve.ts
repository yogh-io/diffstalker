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
 * The web UI is rebuilt on EVERY change: a `vite build --watch` runs alongside the
 * daemon, writing packages/web/dist, which is what we serve (--web-root). So a UI
 * edit shows up on the next browser reload — no manual rebuild. (This is a full
 * production rebuild each save, ~0.5s; the daemon serves the files per request, so
 * no daemon restart is needed for a web change.)
 *
 * For a NO-reload loop (true HMR), run `bun run dev:web` instead (Vite at
 * http://localhost:5173, which proxies the API to :17337 — set its target with
 * DIFFSTALKER_DAEMON_URL=http://127.0.0.1:17337).
 *
 * (A source run resolves its web-root to src/web, which doesn't exist, so we pass
 * --web-root explicitly. @diffstalker/core is imported via its dist, so a change
 * there needs `bun run build`; daemon-only changes are picked up live.)
 */
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 17337;
// Serve straight from Vite's output; the watcher below keeps it current.
const WEB_ROOT = join(ROOT, 'packages/web/dist');
const FOLLOW = join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'diffstalker', 'target');
const repos = process.argv.slice(2).map((p) => resolve(p));

const children: ReturnType<typeof spawn>[] = [];
function killAll(sig: NodeJS.Signals): void {
  for (const child of children) child.kill(sig);
}
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => killAll(sig));
}

// Fail fast if the dev port is already serving (a leftover dev server).
const portBusy = await fetch(`http://127.0.0.1:${PORT}/health`)
  .then(() => true)
  .catch(() => false);
if (portBusy) {
  console.error(`port ${PORT} is already serving — an old dev server? Stop it (Ctrl-C / kill) first.`);
  process.exit(1);
}

// 1. start the web watch-build and wait for the FIRST build, so the daemon never
//    serves a missing/half-written dist. Later builds just rewrite dist in place.
console.log('serve: building web UI (watch)…');
const web = spawn('bun', ['run', 'build:watch'], { cwd: join(ROOT, 'packages/web') });
children.push(web);
web.on('exit', (code) => {
  if (code) {
    console.error(`serve: web watch-build exited with code ${code}`);
    killAll('SIGTERM');
    process.exit(code);
  }
});
await new Promise<void>((resolveFirst, rejectFirst) => {
  const onData = (buf: Buffer): void => {
    process.stdout.write(buf); // forward vite output to the user
    if (/built in /i.test(buf.toString())) {
      web.stdout?.off('data', onData);
      resolveFirst();
    }
  };
  web.stdout?.on('data', onData);
  web.stderr?.on('data', (b: Buffer) => process.stderr.write(b));
  // Don't hang forever if the marker never lands (e.g. a build error prints elsewhere).
  setTimeout(() => rejectFirst(new Error('web build did not complete within 60s')), 60_000).unref();
}).catch((err: Error) => {
  console.error(`serve: ${err.message}`);
  killAll('SIGTERM');
  process.exit(1);
});
// Keep forwarding rebuild output for the rest of the run.
web.stdout?.on('data', (b: Buffer) => process.stdout.write(b));

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
children.push(daemon);
// The daemon exiting ends the whole dev serve — tear down the web watcher too.
daemon.on('exit', (code) => {
  killAll('SIGTERM');
  process.exit(code ?? 0);
});

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
