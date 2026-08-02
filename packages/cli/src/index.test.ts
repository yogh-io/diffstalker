/**
 * Command-line surface of the TUI entry point.
 *
 * index.ts runs the app on import, so these drive the real binary in a child
 * process instead. Every case here exits during argument parsing or on the
 * first failed daemon probe — no test may spawn or reach a real diffstalkerd
 * (DIFFSTALKER_SOCKET points at a path that cannot exist, DIFFSTALKERD_BIN at
 * a binary that cannot start).
 */

import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import manifest from '../package.json' with { type: 'json' };

const ENTRY = fileURLToPath(new URL('./index.ts', import.meta.url));

function run(args: string[], extraEnv: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [ENTRY, ...args], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      // Nothing here may find a live daemon: a socket that does not exist,
      // and a daemon binary that cannot be spawned.
      DIFFSTALKER_SOCKET: '/nonexistent/diffstalker-test/daemon.sock',
      DIFFSTALKERD_BIN: '/nonexistent/diffstalker-test/diffstalkerd',
      ...extraEnv,
    },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Drop the terminal-reset escapes index.ts writes on startup and on exit. */
function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[?0-9;]*[a-zA-Z]/g, '');
}

describe('--version', () => {
  test('prints the version and exits 0', () => {
    const { status, stdout } = run(['--version']);
    expect(status).toBe(0);
    expect(stdout.split('\n')[0]).toBe(`diffstalker ${manifest.version}`);
  });

  test('-v is the same answer', () => {
    expect(run(['-v']).stdout).toBe(run(['--version']).stdout);
  });

  test('names the binaries behind this install', () => {
    const { stdout } = run(['--version']);
    // The whole point: which of the shadowing installs is running.
    expect(stdout).toContain(`cli:     ${ENTRY}`);
    expect(stdout).toMatch(/\n {2}daemon: {2}\S/);
    expect(stdout).toContain(`runtime: ${process.execPath}`);
  });

  test('writes no terminal escape codes to stdout', () => {
    // A pipe must get plain text: the terminal reset runs on startup, so the
    // version answer has to come first.
    expect(run(['--version']).stdout).not.toContain('\x1b');
  });

  test('answers even when no daemon can be found', () => {
    const { status, stdout } = run(['--version'], { PATH: '/nonexistent' });
    expect(status).toBe(0);
    expect(stdout).toContain(`diffstalker ${manifest.version}`);
  });
});

describe('unknown options', () => {
  test('--port is an error, not a repo path', () => {
    const { status, stderr } = run(['--port', '7337']);
    expect(status).toBe(2);
    expect(stderr).toContain('--port');
    expect(stderr).toContain('diffstalkerd --port N');
  });

  test('an unknown long flag names itself and exits 2', () => {
    const { status, stdout, stderr } = run(['--bogus']);
    expect(status).toBe(2);
    expect(stderr).toContain('unknown option --bogus');
    // Usage errors go to stderr; stdout carries only the terminal reset.
    expect(stripAnsi(stdout)).toBe('');
  });

  test('an unknown short flag names itself and exits 2', () => {
    const { status, stderr } = run(['-x']);
    expect(status).toBe(2);
    expect(stderr).toContain('unknown option -x');
  });

  test('a flag-shaped value for --socket is an error, not a silent skip', () => {
    const { status, stderr } = run(['--socket']);
    expect(status).toBe(2);
    expect(stderr).toContain('--socket requires a path');
  });

  test('--instance without a name exits 2', () => {
    const { status, stderr } = run(['--instance']);
    expect(status).toBe(2);
    expect(stderr).toContain('--instance requires a name');
  });

  test('a second repo path is an error, not a silently dropped one', () => {
    const { status, stderr } = run(['/tmp', '/var']);
    expect(status).toBe(2);
    expect(stderr).toContain('unexpected extra argument /var');
  });
});

describe('accepted arguments', () => {
  test('--help exits 0 and documents --version', () => {
    const { status, stdout } = run(['--help']);
    expect(status).toBe(0);
    expect(stdout).toContain('-v, --version');
  });

  test('a single path is still a repo path, and reaches the daemon step', () => {
    // Proof the stricter parser did not start rejecting positionals: this
    // gets past parsing and dies on the unreachable daemon instead.
    const { status, stderr } = run(['/tmp']);
    expect(status).toBe(1);
    expect(stderr).toContain('Failed to reach diffstalkerd');
  });
});
