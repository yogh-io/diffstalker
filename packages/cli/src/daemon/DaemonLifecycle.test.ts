import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DiffstalkerClient } from '@diffstalker/client';
import {
  resolveSocketPath,
  assertFollowFileMatches,
  resolveDaemonBin,
  openDaemonLog,
  daemonLogPath,
  type DaemonBinDeps,
} from './DaemonLifecycle.js';

/** Default injected deps: nothing resolvable anywhere. Override per test. */
function binDeps(overrides: Partial<DaemonBinDeps> = {}): Partial<DaemonBinDeps> {
  return {
    env: {},
    isExecutable: () => false,
    findOnPath: () => null,
    resolveInstalled: () => null,
    workspaceBin: '/workspace/packages/daemon/bin/diffstalkerd',
    ...overrides,
  };
}

describe('resolveDaemonBin', () => {
  test('$DIFFSTALKERD_BIN wins over everything', () => {
    expect(
      resolveDaemonBin(
        binDeps({
          env: { DIFFSTALKERD_BIN: '/env/diffstalkerd' },
          resolveInstalled: () => '/node_modules/diffstalkerd/bin/diffstalkerd',
          isExecutable: () => true,
          findOnPath: () => '/usr/bin/diffstalkerd',
        })
      )
    ).toBe('/env/diffstalkerd');
  });

  test('prefers the installed dependency over a diffstalkerd on PATH', () => {
    const installed = '/node_modules/diffstalkerd/bin/diffstalkerd';
    expect(
      resolveDaemonBin(
        binDeps({
          resolveInstalled: () => installed,
          isExecutable: (c) => c === installed,
          // A stray daemon on PATH must NOT be chosen when the dep resolves.
          findOnPath: () => '/usr/bin/diffstalkerd',
        })
      )
    ).toBe(installed);
  });

  test('falls back to PATH when the dependency is not resolvable', () => {
    expect(
      resolveDaemonBin(
        binDeps({
          resolveInstalled: () => null,
          findOnPath: () => '/usr/bin/diffstalkerd',
        })
      )
    ).toBe('/usr/bin/diffstalkerd');
  });

  test('falls back to the workspace bin (dev checkout) when nothing else resolves', () => {
    const workspaceBin = '/workspace/packages/daemon/bin/diffstalkerd';
    expect(
      resolveDaemonBin(
        binDeps({
          workspaceBin,
          isExecutable: (c) => c === workspaceBin,
        })
      )
    ).toBe(workspaceBin);
  });

  test('throws a reinstall hint when the daemon cannot be found anywhere', () => {
    expect(() => resolveDaemonBin(binDeps())).toThrow(/reinstall diffstalker.*DIFFSTALKERD_BIN/s);
  });

  test('ignores a resolved-but-non-executable installed path, uses PATH next', () => {
    // resolveInstalled returns a path, but it is not executable -> skip to PATH.
    expect(
      resolveDaemonBin(
        binDeps({
          resolveInstalled: () => '/node_modules/diffstalkerd/bin/diffstalkerd',
          isExecutable: () => false,
          findOnPath: () => '/usr/bin/diffstalkerd',
        })
      )
    ).toBe('/usr/bin/diffstalkerd');
  });
});

describe('resolveSocketPath', () => {
  test('an explicit path always wins', () => {
    const env = { DIFFSTALKER_SOCKET: '/env/sock', XDG_RUNTIME_DIR: '/run/user/1000' };
    expect(resolveSocketPath('/explicit/sock', env)).toBe('/explicit/sock');
  });

  test('falls back to DIFFSTALKER_SOCKET', () => {
    const env = { DIFFSTALKER_SOCKET: '/env/sock', XDG_RUNTIME_DIR: '/run/user/1000' };
    expect(resolveSocketPath(undefined, env)).toBe('/env/sock');
  });

  test('falls back to the XDG runtime dir', () => {
    const env = { XDG_RUNTIME_DIR: '/run/user/1000' };
    expect(resolveSocketPath(undefined, env)).toBe(
      path.join('/run/user/1000', 'diffstalker', 'diffstalkerd.sock')
    );
  });

  test('refuses to guess without XDG_RUNTIME_DIR (no /tmp fallback)', () => {
    expect(() => resolveSocketPath(undefined, {})).toThrow(/XDG_RUNTIME_DIR/);
  });

  test('resolves a named instance to <name>.sock in the runtime dir', () => {
    const env = { XDG_RUNTIME_DIR: '/run/user/1000' };
    expect(resolveSocketPath(undefined, env, 'work')).toBe(
      '/run/user/1000/diffstalker/work.sock'
    );
  });

  test('reads the instance from $DIFFSTALKER_INSTANCE', () => {
    const env = { XDG_RUNTIME_DIR: '/run/user/1000', DIFFSTALKER_INSTANCE: 'envwork' };
    expect(resolveSocketPath(undefined, env)).toBe('/run/user/1000/diffstalker/envwork.sock');
  });

  test('prefers the explicit instance over $DIFFSTALKER_INSTANCE', () => {
    const env = { XDG_RUNTIME_DIR: '/run/user/1000', DIFFSTALKER_INSTANCE: 'envwork' };
    expect(resolveSocketPath(undefined, env, 'flagwork')).toBe(
      '/run/user/1000/diffstalker/flagwork.sock'
    );
  });

  /**
   * A path is already unambiguous, so both path forms outrank both name
   * forms — the name only ever picks a file inside the runtime dir.
   */
  test('prefers an explicit path over an instance name', () => {
    const env = { XDG_RUNTIME_DIR: '/run/user/1000' };
    expect(resolveSocketPath('/custom/explicit.sock', env, 'work')).toBe('/custom/explicit.sock');
  });

  test('prefers $DIFFSTALKER_SOCKET over an instance name', () => {
    const env = { XDG_RUNTIME_DIR: '/run/user/1000', DIFFSTALKER_SOCKET: '/custom/envpath.sock' };
    expect(resolveSocketPath(undefined, env, 'work')).toBe('/custom/envpath.sock');
  });

  test('falls back to the shared socket for an empty instance name', () => {
    const env = { XDG_RUNTIME_DIR: '/run/user/1000' };
    expect(resolveSocketPath(undefined, env, '')).toBe(
      '/run/user/1000/diffstalker/diffstalkerd.sock'
    );
  });
});

describe('spawned daemon log', () => {
  let dir: string;
  let logPath: string;
  const savedStateHome = process.env.XDG_STATE_HOME;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diffstalker-log-'));
    logPath = path.join(dir, 'nested', 'diffstalkerd.log');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (savedStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = savedStateHome;
  });

  test('the log lives under the XDG state dir', () => {
    process.env.XDG_STATE_HOME = '/custom/state';
    expect(daemonLogPath()).toBe('/custom/state/diffstalker/diffstalkerd.log');
  });

  test('creates the directory and the file, and appends', () => {
    const fd = openDaemonLog(logPath, 100);
    fs.writeSync(fd, 'first\n');
    fs.closeSync(fd);
    const again = openDaemonLog(logPath, 100);
    fs.writeSync(again, 'second\n');
    fs.closeSync(again);

    expect(fs.readFileSync(logPath, 'utf-8')).toBe('first\nsecond\n');
    expect(fs.existsSync(`${logPath}.1`)).toBe(false);
  });

  test('rotates a file over the limit to .log.1 and starts a fresh one', () => {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, 'x'.repeat(101));
    fs.writeFileSync(`${logPath}.1`, 'older');

    const fd = openDaemonLog(logPath, 100);
    fs.writeSync(fd, 'new\n');
    fs.closeSync(fd);

    expect(fs.readFileSync(logPath, 'utf-8')).toBe('new\n');
    // One old file only: the previous .1 is gone.
    expect(fs.readFileSync(`${logPath}.1`, 'utf-8')).toBe('x'.repeat(101));
    expect(fs.existsSync(`${logPath}.2`)).toBe(false);
  });

  test('a file exactly at the limit is not rotated', () => {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, 'x'.repeat(100));

    fs.closeSync(openDaemonLog(logPath, 100));

    expect(fs.existsSync(`${logPath}.1`)).toBe(false);
    expect(fs.readFileSync(logPath, 'utf-8')).toBe('x'.repeat(100));
  });

  test('an unwritable log dir is an error, not a silent spawn without logs', () => {
    fs.writeFileSync(path.join(dir, 'nested'), 'a file where the dir should be');
    expect(() => openDaemonLog(logPath, 100)).toThrow();
  });
});

/** A client whose GET /follow reports the given target file. */
function clientFollowing(targetFile: string | null): DiffstalkerClient {
  return {
    getFollow: () =>
      Promise.resolve({
        targetFile,
        enabled: targetFile !== null,
        followedRepoId: null,
        followedPath: null,
      }),
  } as unknown as DiffstalkerClient;
}

describe('assertFollowFileMatches', () => {
  test('resolves when the running daemon already follows the same file', async () => {
    await expect(
      assertFollowFileMatches(clientFollowing('/hook'), '/hook')
    ).resolves.toBeUndefined();
  });

  test('rejects when the running daemon follows a different file', async () => {
    await expect(assertFollowFileMatches(clientFollowing('/other'), '/hook')).rejects.toThrow(
      /follows \/other/
    );
  });

  test('rejects when the running daemon has follow disabled', async () => {
    await expect(assertFollowFileMatches(clientFollowing(null), '/hook')).rejects.toThrow(
      /follow mode disabled/
    );
  });
});
