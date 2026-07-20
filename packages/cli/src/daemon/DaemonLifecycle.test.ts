import { describe, test, expect } from 'bun:test';
import * as path from 'node:path';
import type { DiffstalkerClient } from '@diffstalker/client';
import { resolveSocketPath, assertFollowFileMatches } from './DaemonLifecycle.js';

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
