/**
 * parseArgs and startup behavior of the diffstalkerd entry point.
 *
 * index.ts calls main() at module top level, so importing it from a test
 * would start a daemon. Instead these tests spawn the real entry point as
 * a subprocess and assert on exit codes and output — the same contract the
 * bin wrapper and systemd see.
 */

import { describe, test, expect } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ENTRY = path.resolve(import.meta.dirname, 'index.ts');

/** Env without systemd-activation or XDG vars leaking in from the runner. */
function cleanEnv(overrides: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key === 'LISTEN_FDS' || key === 'LISTEN_PID' || key === 'XDG_RUNTIME_DIR') continue;
    env[key] = value;
  }
  return { ...env, ...overrides };
}

function runDaemon(
  args: string[],
  overrides: Record<string, string> = {}
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [ENTRY, ...args], {
    encoding: 'utf-8',
    env: cleanEnv(overrides),
    timeout: 15000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('parseArgs error branches (exit 2 + message + usage)', () => {
  test('non-numeric --port', () => {
    const result = runDaemon(['--port', 'abc']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--port requires a non-negative integer');
    expect(result.stderr).toContain('Usage: diffstalkerd');
  });

  test('negative --port', () => {
    const result = runDaemon(['--port', '-1']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--port requires a non-negative integer');
  });

  test('--socket and --port are mutually exclusive', () => {
    // Never bound: parseArgs rejects the combination before any listen.
    const result = runDaemon(['--socket', '/nonexistent/x.sock', '--port', '8080']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--socket and --port are mutually exclusive');
  });

  test('unknown argument', () => {
    const result = runDaemon(['--bogus']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Unknown argument: --bogus');
  });

  test('flag missing its value at end of argv', () => {
    const result = runDaemon(['--socket']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--socket requires a value');
  });

  test('flag whose "value" is the next flag', () => {
    const result = runDaemon(['--follow-file', '--port']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--follow-file requires a value');
  });

  test('--host is no longer accepted (loopback-only, no routable bind)', () => {
    const result = runDaemon(['--host', '0.0.0.0']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Unknown argument: --host');
  });

  test('--follow-file missing its value', () => {
    const result = runDaemon(['--follow-file']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--follow-file requires a value');
  });

  test('--follow-file and --no-follow are mutually exclusive', () => {
    const result = runDaemon(['--follow-file', path.join(os.tmpdir(), 'x'), '--no-follow']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--follow-file and --no-follow are mutually exclusive');
  });

  test('--web-root missing its value', () => {
    const result = runDaemon(['--web-root']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--web-root requires a value');
  });

  test('--help prints usage on stdout and exits 0', () => {
    const result = runDaemon(['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage: diffstalkerd');
    expect(result.stdout).toContain('--socket PATH');
    expect(result.stdout).toContain('--follow-file PATH');
    expect(result.stdout).toContain('--no-follow');
    expect(result.stdout).toContain('--web-root PATH');
  });
});

describe('web root wiring', () => {
  test('missing web root is non-fatal: one API-only line, daemon still serves', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-web-'));
    const socket = path.join(base, 'd.sock');
    const missingRoot = path.join(base, 'no-such-web');

    try {
      await withRunningDaemon(
        ['--socket', socket, '--no-follow', '--web-root', missingRoot],
        {},
        async (getStderr) => {
          expect(getStderr()).toContain(
            `web UI assets not found at ${missingRoot}; serving API only`
          );

          const res = await fetch('http://localhost/health', { unix: socket } as RequestInit);
          expect(res.status).toBe(200);
        }
      );
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  }, 15000);

  test('an existing --web-root is announced and served', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-web-'));
    const socket = path.join(base, 'd.sock');
    const webRoot = path.join(base, 'web');
    fs.mkdirSync(webRoot, { recursive: true });
    fs.writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html>fixture');

    try {
      await withRunningDaemon(
        ['--socket', socket, '--no-follow', '--web-root', webRoot],
        {},
        async (getStderr) => {
          expect(getStderr()).toContain(`serving web UI from ${webRoot}`);

          const res = await fetch('http://localhost/', { unix: socket } as RequestInit);
          expect(res.status).toBe(200);
          expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
          expect(await res.text()).toContain('fixture');
        }
      );
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  }, 15000);
});

/** Spawn the daemon, wait for the listening line, hand control to `run`. */
async function withRunningDaemon(
  args: string[],
  env: Record<string, string>,
  run: (getStderr: () => string) => Promise<void>
): Promise<void> {
  const child = spawn(process.execPath, [ENTRY, ...args], {
    env: cleanEnv(env),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf-8');
  });

  try {
    const deadline = Date.now() + 10000;
    while (!stderr.includes('listening') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(stderr).toContain('listening');
    await run(() => stderr);
  } finally {
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill('SIGTERM');
    await exited;
  }
}

describe('follow flags wiring', () => {
  test('follow defaults to the cache-dir hook file (via XDG_CACHE_HOME)', async () => {
    const cacheBase = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-cache-'));
    const socket = path.join(cacheBase, 'd.sock');
    const expectedTarget = path.join(cacheBase, 'diffstalker', 'target');

    try {
      await withRunningDaemon(
        ['--socket', socket],
        { XDG_CACHE_HOME: cacheBase },
        async (getStderr) => {
          expect(getStderr()).toContain(`following ${expectedTarget}`);
          // The watcher created the hook file.
          expect(fs.existsSync(expectedTarget)).toBe(true);

          const res = await fetch('http://localhost/follow', { unix: socket } as RequestInit);
          expect(res.status).toBe(200);
          const follow = (await res.json()) as { enabled: boolean; targetFile: string };
          expect(follow.enabled).toBe(true);
          expect(follow.targetFile).toBe(expectedTarget);
        }
      );
    } finally {
      fs.rmSync(cacheBase, { recursive: true, force: true });
    }
  }, 15000);

  test('--no-follow: GET /follow reports enabled:false and no hook file appears', async () => {
    const cacheBase = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-cache-'));
    const socket = path.join(cacheBase, 'd.sock');

    try {
      await withRunningDaemon(
        ['--socket', socket, '--no-follow'],
        { XDG_CACHE_HOME: cacheBase },
        async (getStderr) => {
          expect(getStderr()).not.toContain('following');

          const res = await fetch('http://localhost/follow', { unix: socket } as RequestInit);
          expect(res.status).toBe(200);
          const follow = (await res.json()) as { enabled: boolean; targetFile: string | null };
          expect(follow.enabled).toBe(false);
          expect(follow.targetFile).toBeNull();
          // No watcher was created: the default hook file does not exist.
          expect(fs.existsSync(path.join(cacheBase, 'diffstalker', 'target'))).toBe(false);
        }
      );
    } finally {
      fs.rmSync(cacheBase, { recursive: true, force: true });
    }
  }, 15000);
});

describe('default socket resolution', () => {
  test('refuses to start without XDG_RUNTIME_DIR and without --socket/--port', () => {
    const result = runDaemon([]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('XDG_RUNTIME_DIR is not set');
  });

  test('derives $XDG_RUNTIME_DIR/diffstalker/diffstalkerd.sock, dir 0700, socket 0600', async () => {
    const runtimeBase = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-xdg-'));
    const expectedDir = path.join(runtimeBase, 'diffstalker');
    const expectedSocket = path.join(expectedDir, 'diffstalkerd.sock');

    const child = spawn(process.execPath, [ENTRY], {
      env: cleanEnv({ XDG_RUNTIME_DIR: runtimeBase }),
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });

    try {
      const deadline = Date.now() + 10000;
      while (!stderr.includes('listening') && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(stderr).toContain(`listening on unix socket ${expectedSocket}`);
      expect(fs.existsSync(expectedSocket)).toBe(true);
      expect(fs.statSync(expectedDir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(expectedSocket).mode & 0o777).toBe(0o600);
    } finally {
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill('SIGTERM');
      await exited;
      fs.rmSync(runtimeBase, { recursive: true, force: true });
    }
  }, 15000);
});
