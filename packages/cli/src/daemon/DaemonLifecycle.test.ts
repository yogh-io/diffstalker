import { describe, test, expect } from 'bun:test';
import * as path from 'node:path';
import { resolveSocketPath } from './DaemonLifecycle.js';

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
