import { describe, test, expect } from 'bun:test';
import * as path from 'node:path';
import type { DiffstalkerClient } from '@diffstalker/client';
import {
  resolveSocketPath,
  assertFollowFileMatches,
  resolveDaemonBin,
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
