/**
 * Daemon lifecycle for the TUI: find the diffstalkerd socket, attach to a
 * running daemon, or spawn one and wait for it to come up.
 *
 * Socket discovery: --socket flag, then $DIFFSTALKER_SOCKET, then
 * $XDG_RUNTIME_DIR/diffstalker/diffstalkerd.sock. No /tmp fallback — a
 * world-writable default would hide the problem instead of surfacing it.
 *
 * The CLI NEVER stops the daemon — spawned or attached, it outlives the
 * TUI; sessions release their repos (DELETE /repos refcount) on exit and
 * that is the whole cleanup.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DiffstalkerClient } from '@diffstalker/client';

const SOCKET_NAME = 'diffstalkerd.sock';

/** How long one /health probe may take before it counts as down. */
const HEALTH_TIMEOUT_MS = 250;

/** Spawn readiness: poll cadence and overall deadline. */
const READY_POLL_MS = 50;
const READY_DEADLINE_MS = 3000;

export interface EnsureDaemonResult {
  client: DiffstalkerClient;
  socketPath: string;
  /** True when this call spawned the daemon (vs attaching to a live one). */
  spawned: boolean;
}

/**
 * Resolve the daemon socket path: explicit flag, then the
 * DIFFSTALKER_SOCKET env var, then the XDG runtime dir. Throws when none
 * applies — never a /tmp guess.
 */
export function resolveSocketPath(
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (explicit) return explicit;
  const fromEnv = env.DIFFSTALKER_SOCKET;
  if (fromEnv) return fromEnv;
  // Same rule as core's runtimeDir(), against an injectable env (tests).
  const dir = env.XDG_RUNTIME_DIR ? path.join(env.XDG_RUNTIME_DIR, 'diffstalker') : null;
  if (!dir) {
    throw new Error(
      'Cannot locate the diffstalkerd socket: XDG_RUNTIME_DIR is not set.\n' +
        'Pass --socket PATH or set DIFFSTALKER_SOCKET.'
    );
  }
  return path.join(dir, SOCKET_NAME);
}

/** One bounded /health probe: true only for a live, ready daemon. */
async function isHealthy(client: DiffstalkerClient, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  // The probe must carry its own catch: if the timeout wins the race, a
  // later rejection from the health call would otherwise float unhandled
  // (and the CLI's unhandledRejection handler exits the process).
  const probe = client.health().then(
    (health) => health.ok === true,
    () => false
  );
  try {
    return (await Promise.race([probe, timeout])) === true;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** True when `candidate` exists and is executable. */
function isExecutable(candidate: string): boolean {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/** Find an executable by name on $PATH. */
function findOnPath(name: string): string | null {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

/**
 * Locate the diffstalkerd executable: $DIFFSTALKERD_BIN, then $PATH, then
 * the workspace copy (development checkout).
 */
export function resolveDaemonBin(): string {
  const fromEnv = process.env.DIFFSTALKERD_BIN;
  if (fromEnv) return fromEnv;

  const onPath = findOnPath('diffstalkerd');
  if (onPath) return onPath;

  // packages/cli/{src,dist}/daemon/ -> packages/daemon/bin/diffstalkerd
  const workspace = fileURLToPath(new URL('../../../daemon/bin/diffstalkerd', import.meta.url));
  if (isExecutable(workspace)) return workspace;

  throw new Error(
    'diffstalkerd not found: set DIFFSTALKERD_BIN, or install diffstalkerd on your PATH.'
  );
}

/**
 * Refuse an explicit --follow FILE that disagrees with the hook file the
 * already-running daemon watches: a silently-ignored explicit flag is a
 * hidden divergence, so surface it. A daemon running --no-follow reports a
 * null targetFile — that conflicts with any explicit FILE too.
 */
export async function assertFollowFileMatches(
  client: DiffstalkerClient,
  followFile: string
): Promise<void> {
  const follow = await client.getFollow();
  if (follow.targetFile === followFile) return;
  const running =
    follow.targetFile === null ? 'has follow mode disabled' : `follows ${follow.targetFile}`;
  throw new Error(
    `--follow ${followFile} conflicts with the already-running diffstalkerd, which ${running}.\n` +
      `Omit the path to use the daemon's target, or restart the daemon with --follow-file ${followFile}.`
  );
}

/**
 * Attach to a running daemon on the resolved socket, or spawn one
 * (detached, unref'd — it survives this process) and wait for /health.
 *
 * `followFile` (from an explicit --follow FILE) is passed through as
 * --follow-file when we spawn, and validated against the daemon's target
 * when we attach.
 */
export async function ensureDaemon(options: {
  socketPath?: string;
  followFile?: string;
}): Promise<EnsureDaemonResult> {
  const socketPath = resolveSocketPath(options.socketPath);
  const client = new DiffstalkerClient({ socketPath });

  if (await isHealthy(client, HEALTH_TIMEOUT_MS)) {
    if (options.followFile !== undefined) {
      await assertFollowFileMatches(client, options.followFile);
    }
    return { client, socketPath, spawned: false };
  }

  const bin = resolveDaemonBin();
  fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });

  const spawnArgs = ['--socket', socketPath];
  if (options.followFile !== undefined) {
    spawnArgs.push('--follow-file', options.followFile);
  }

  let spawnError: Error | null = null;
  const child = spawn(bin, spawnArgs, {
    detached: true,
    stdio: 'ignore',
  });
  child.on('error', (err) => {
    spawnError = err;
  });
  child.unref();

  const deadline = Date.now() + READY_DEADLINE_MS;
  while (Date.now() < deadline) {
    if (spawnError !== null) {
      throw new Error(`Failed to spawn diffstalkerd (${bin}): ${(spawnError as Error).message}`);
    }
    if (await isHealthy(client, HEALTH_TIMEOUT_MS)) {
      return { client, socketPath, spawned: true };
    }
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
  }
  throw new Error(`diffstalkerd did not become ready at ${socketPath}`);
}
