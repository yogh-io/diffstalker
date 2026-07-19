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
    const result = runDaemon(['--host', '--port']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--host requires a value');
  });

  test('--help prints usage on stdout and exits 0', () => {
    const result = runDaemon(['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage: diffstalkerd');
    expect(result.stdout).toContain('--socket PATH');
  });
});

describe('default socket resolution', () => {
  test('refuses to start without XDG_RUNTIME_DIR and without --socket/--port', () => {
    const result = runDaemon([]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('XDG_RUNTIME_DIR is not set');
  });

  test(
    'derives $XDG_RUNTIME_DIR/diffstalker/diffstalkerd.sock, dir 0700, socket 0600',
    async () => {
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
    },
    15000
  );
});
