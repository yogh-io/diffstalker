/**
 * Version service tests: semver comparison, the running version read from
 * the daemon's own package.json, and the lookup cache (no test ever hits
 * the real npm registry — the fetcher is always injected).
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { compareVersions, createVersionService, readCurrentVersion } from './version.js';
import { UNKNOWN_INSTALL, type InstallInfo, type InstallService } from './install.js';

/** A stub install service: detection has its own tests, and no version
 *  test should shell out to pacman to get a version state. */
function stubInstall(info: InstallInfo = UNKNOWN_INSTALL): InstallService {
  return { info: () => Promise.resolve(info) };
}

describe('compareVersions', () => {
  test('equal versions are current', () => {
    expect(compareVersions('0.8.1', '0.8.1')).toBe('current');
  });

  test('a lower running version is outdated', () => {
    expect(compareVersions('0.8.1', '0.9.0')).toBe('outdated');
    expect(compareVersions('0.8.1', '0.8.2')).toBe('outdated');
    expect(compareVersions('0.9.9', '1.0.0')).toBe('outdated');
  });

  test('a higher running version is ahead (unreleased local build)', () => {
    expect(compareVersions('0.9.0', '0.8.1')).toBe('ahead');
    expect(compareVersions('1.0.0', '0.9.9')).toBe('ahead');
  });

  test('numbers compare numerically, not as strings', () => {
    expect(compareVersions('0.10.0', '0.9.0')).toBe('ahead');
    expect(compareVersions('0.9.0', '0.10.0')).toBe('outdated');
  });

  test('either side missing or unparsable is unknown', () => {
    expect(compareVersions(null, '0.8.1')).toBe('unknown');
    expect(compareVersions('0.8.1', null)).toBe('unknown');
    expect(compareVersions('nonsense', '0.8.1')).toBe('unknown');
  });
});

describe('readCurrentVersion', () => {
  test("matches the daemon package's own manifest", () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.resolve(import.meta.dirname, '../package.json'), 'utf-8')
    ) as { version: string };
    expect(readCurrentVersion()).toBe(manifest.version);
  });
});

describe('createVersionService', () => {
  test('reports the running version against the published one', async () => {
    const service = createVersionService(() => Promise.resolve('0.9.0'), '0.8.1', stubInstall());
    expect(await service.state()).toEqual({
      current: '0.8.1',
      latest: '0.9.0',
      status: 'outdated',
      install: UNKNOWN_INSTALL,
    });
  });

  test('carries the install method, so a client can offer the update command', async () => {
    const service = createVersionService(() => Promise.resolve('0.9.0'), '0.8.1', {
      info: () =>
        Promise.resolve({
          method: 'pacman' as const,
          package: 'diffstalker-git',
          command: 'yay -S diffstalker-git',
        }),
    });
    expect((await service.state()).install.command).toBe('yay -S diffstalker-git');
  });

  test('caches the lookup: repeated calls hit the registry once', async () => {
    let calls = 0;
    const service = createVersionService(() => {
      calls++;
      return Promise.resolve('0.9.0');
    }, '0.8.1', stubInstall());

    await service.state();
    await service.state();
    await service.state();
    expect(calls).toBe(1);
  });

  test('concurrent misses share one in-flight lookup', async () => {
    let calls = 0;
    const service = createVersionService(() => {
      calls++;
      return new Promise((resolve) => setTimeout(() => resolve('0.9.0'), 10));
    }, '0.8.1', stubInstall());

    const states = await Promise.all([service.state(), service.state(), service.state()]);
    expect(calls).toBe(1);
    expect(states.every((state) => state.latest === '0.9.0')).toBe(true);
  });

  test('a failed lookup leaves the latest unknown instead of throwing', async () => {
    const service = createVersionService(() => Promise.reject(new Error('offline')), '0.8.1', stubInstall());
    expect(await service.state()).toEqual({
      current: '0.8.1',
      latest: null,
      status: 'unknown',
      install: UNKNOWN_INSTALL,
    });
  });

  test('an unreadable running version is unknown, never a crash', async () => {
    const service = createVersionService(() => Promise.resolve('0.9.0'), null, stubInstall());
    expect(await service.state()).toEqual({
      current: null,
      latest: '0.9.0',
      status: 'unknown',
      install: UNKNOWN_INSTALL,
    });
  });
});
