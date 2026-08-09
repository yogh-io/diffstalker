/**
 * useSettingsStore tests: the daemon-owned settings and what they
 * discover. What matters here is that a refused save changes nothing
 * locally (the panel must never list a root the daemon did not take), and
 * that discovered repos dedupe across overlapping watch directories.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useSettingsStore } from './settings';
import { makeFakeFetch } from '../testing/fakes';
import type { DiscoveredRepo } from '@diffstalker/client';

function repo(
  name: string,
  path: string,
  branch: string | null = 'main',
  lastActivity: number | null = null
): DiscoveredRepo {
  return { name, path, branch, lastActivity };
}

const ROOT = '/home/j/gitRepos';

/** A daemon that accepts every save and reports one root's scan. */
function happyDaemon(repos: DiscoveredRepo[] = [repo('alpha', `${ROOT}/alpha`)]) {
  let watchRoots: string[] = [];
  return makeFakeFetch((call) => {
    if (call.url === '/settings' && call.method === 'GET') {
      return { body: { watchRoots, persisted: true } };
    }
    if (call.url === '/settings' && call.method === 'PUT') {
      // Dedupes like the real daemon: normalizeWatchRoots drops a repeat
      // and answers 200 with the unchanged list.
      watchRoots = [...new Set((call.body as { watchRoots: string[] }).watchRoots)];
      return { body: { watchRoots, persisted: true } };
    }
    if (call.url === '/discovered') {
      return {
        body: {
          roots: watchRoots.map((path) => ({ path, repos, error: null, capped: false })),
        },
      };
    }
    return { status: 404, body: {} };
  });
}

beforeEach(() => {
  setActivePinia(createPinia());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('load', () => {
  test('pulls settings and discovery together', async () => {
    vi.stubGlobal('fetch', happyDaemon().fn);
    const settings = useSettingsStore();
    await settings.load();

    expect(settings.loaded).toBe(true);
    expect(settings.persisted).toBe(true);
    expect(settings.watchRoots).toEqual([]);
  });

  test('a dead daemon leaves the last known values and does not throw', async () => {
    vi.stubGlobal(
      'fetch',
      makeFakeFetch(() => {
        throw new Error('connection refused');
      }).fn
    );
    const settings = useSettingsStore();
    await settings.load();

    expect(settings.loaded).toBe(false);
    expect(settings.watchRoots).toEqual([]);
  });
});

describe('saving watch roots', () => {
  test('an accepted root is stored and its scan applied', async () => {
    vi.stubGlobal('fetch', happyDaemon().fn);
    const settings = useSettingsStore();

    expect(await settings.addWatchRoot(ROOT)).toBe(true);
    expect(settings.watchRoots).toEqual([ROOT]);
    expect(settings.discoveredRepos.map((r) => r.name)).toEqual(['alpha']);
    expect(settings.saveError).toBe(null);
  });

  test('adding a root that is already watched says so instead of looking like a save', async () => {
    vi.stubGlobal('fetch', happyDaemon().fn);
    const settings = useSettingsStore();

    expect(await settings.addWatchRoot(ROOT)).toBe(true);
    // Second time: the daemon dedupes silently, so without the check this
    // returns true and the panel clears the field as if something happened.
    expect(await settings.addWatchRoot(ROOT)).toBe(false);
    expect(settings.saveError).toContain('Already watching');
    expect(settings.watchRoots).toEqual([ROOT]);
  });

  test('clearSaveError drops a refusal so the panel opens clean', async () => {
    vi.stubGlobal('fetch', happyDaemon().fn);
    const settings = useSettingsStore();
    await settings.addWatchRoot(ROOT);
    await settings.addWatchRoot(ROOT);
    expect(settings.saveError).not.toBe(null);

    settings.clearSaveError();
    expect(settings.saveError).toBe(null);
  });

  test('a refused root keeps the stored list and shows the daemon reason', async () => {
    vi.stubGlobal(
      'fetch',
      makeFakeFetch((call) => {
        if (call.url === '/settings' && call.method === 'PUT') {
          return { status: 400, body: { error: 'No such directory: /nope' } };
        }
        return { body: { watchRoots: [], persisted: true, roots: [] } };
      }).fn
    );
    const settings = useSettingsStore();

    expect(await settings.addWatchRoot('/nope')).toBe(false);
    expect(settings.watchRoots).toEqual([]);
    expect(settings.saveError).toBe('No such directory: /nope');
  });

  test('removing a root sends the remaining list', async () => {
    const fake = happyDaemon();
    vi.stubGlobal('fetch', fake.fn);
    const settings = useSettingsStore();

    await settings.addWatchRoot(ROOT);
    await settings.addWatchRoot('/other');
    await settings.removeWatchRoot(ROOT);

    const lastPut = fake.callsTo('/settings').filter((call) => call.method === 'PUT').at(-1);
    expect(lastPut?.body).toEqual({ watchRoots: ['/other'] });
    expect(settings.watchRoots).toEqual(['/other']);
  });
});

describe('discoveredRepos', () => {
  test('orders by most recently touched, so stale projects sink', () => {
    const settings = useSettingsStore();
    const day = 24 * 60 * 60 * 1000;
    settings.applyDiscovery({
      roots: [
        {
          path: '/w',
          repos: [
            repo('ancient', '/w/ancient', 'main', Date.now() - 900 * day),
            repo('unknown-age', '/w/unknown-age', 'main', null),
            repo('today', '/w/today', 'main', Date.now()),
            repo('last-week', '/w/last-week', 'main', Date.now() - 7 * day),
          ],
          error: null,
          capped: false,
        },
      ],
    });

    // Unknown activity sorts LAST: it is not evidence of freshness.
    expect(settings.discoveredRepos.map((r) => r.name)).toEqual([
      'today',
      'last-week',
      'ancient',
      'unknown-age',
    ]);
  });

  test('dedupes a repo reachable from two overlapping roots, and sorts by name', () => {
    const settings = useSettingsStore();
    settings.applyDiscovery({
      roots: [
        {
          path: '/a',
          repos: [repo('zeta', '/shared/zeta'), repo('alpha', '/a/alpha')],
          error: null,
          capped: false,
        },
        {
          path: '/shared',
          repos: [repo('zeta', '/shared/zeta')],
          error: null,
          capped: false,
        },
      ],
    });

    // Same (unknown) activity, so the name decides.
    expect(settings.discoveredRepos.map((r) => r.name)).toEqual(['alpha', 'zeta']);
  });

  test('a failed root contributes no repos but is reported', () => {
    const settings = useSettingsStore();
    settings.applyDiscovery({
      roots: [{ path: '/gone', repos: [], error: 'ENOENT', capped: false }],
    });

    expect(settings.discoveredRepos).toEqual([]);
    expect(settings.failedRoots.map((root) => root.path)).toEqual(['/gone']);
  });
});
