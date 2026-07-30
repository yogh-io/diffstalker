/**
 * parseArgs and startup behavior of the diffstalkerd entry point.
 *
 * index.ts calls main() at module top level, so importing it from a test
 * would start a daemon. Instead these tests spawn the real entry point as
 * a subprocess and assert on exit codes and output — the same contract the
 * bin wrapper and systemd see.
 */

import { describe, test, expect } from 'bun:test';
import { execSync, spawn, spawnSync } from 'node:child_process';
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

  test('--socket and --no-socket are mutually exclusive', () => {
    const result = runDaemon(['--socket', '/nonexistent/x.sock', '--no-socket']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--socket and --no-socket are mutually exclusive');
  });

  test('--no-socket without --port leaves nothing listening', () => {
    const result = runDaemon(['--no-socket']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--no-socket requires --port');
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
    expect(result.stdout).toContain('--no-update-check');
  });
});

describe('update check', () => {
  test('--no-update-check leaves the published version unknown (no registry call)', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-version-'));
    const socket = path.join(base, 'd.sock');

    try {
      await withRunningDaemon(
        ['--socket', socket, '--no-follow', '--no-update-check'],
        {},
        async () => {
          const res = await fetch('http://localhost/version', { unix: socket } as RequestInit);
          expect(res.status).toBe(200);
          const body = (await res.json()) as { current: string; latest: null; status: string };
          expect(body.current).toMatch(/^\d+\.\d+\.\d+/);
          expect(body.latest).toBe(null);
          expect(body.status).toBe('unknown');
        }
      );
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  }, 15000);
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

describe('dual bind (unix socket + TCP port)', () => {
  test('one daemon, one state, a different API surface per transport', async () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ds-dual-')));
    const socket = path.join(base, 'd.sock');
    const repoDir = path.join(base, 'repo');
    fs.mkdirSync(repoDir);
    const git = (command: string): void => {
      execSync(`git ${command}`, { cwd: repoDir, stdio: 'ignore' });
    };
    git('init --initial-branch=main');
    git('config user.email "test@test.com"');
    git('config user.name "Test User"');
    fs.writeFileSync(path.join(repoDir, 'file.txt'), 'one\n');
    git('add file.txt');
    git('commit -m initial');

    const openRepo = async (url: string, init: RequestInit): Promise<string> => {
      const res = await fetch(url, {
        ...init,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: repoDir }),
      });
      const json = (await res.json()) as { id: string };
      return json.id;
    };

    try {
      await withRunningDaemon(
        ['--socket', socket, '--port', '0', '--no-follow', '--no-update-check'],
        {},
        async (getStderr) => {
          // --port 0 lets the kernel choose; the daemon reports what it got.
          const port = Number(/127\.0\.0\.1:(\d+)/.exec(getStderr())?.[1]);
          expect(Number.isInteger(port)).toBe(true);

          // Both transports answer.
          const viaSocketHealth = await fetch('http://localhost/health', {
            unix: socket,
          } as RequestInit);
          expect(viaSocketHealth.status).toBe(200);
          expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);

          // ...and they are ONE daemon: a repo opened over the socket is the
          // same registry entry the port sees, so the id matches.
          const socketId = await openRepo('http://localhost/repos', {
            unix: socket,
          } as RequestInit);
          const portId = await openRepo(`http://127.0.0.1:${port}/repos`, {});
          expect(portId).toBe(socketId);

          // Least privilege is per transport, not per daemon: commit is
          // routed on the owner-only socket and absent on the port.
          const commit = (url: string, init: RequestInit): Promise<Response> =>
            fetch(url, {
              ...init,
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ message: 'x' }),
            });

          const overSocket = await commit(`http://localhost/repos/${socketId}/commit`, {
            unix: socket,
          } as RequestInit);
          expect(overSocket.status).not.toBe(404);

          const overPort = await commit(`http://127.0.0.1:${port}/repos/${socketId}/commit`, {});
          expect(overPort.status).toBe(404);
        }
      );
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  }, 20000);
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
