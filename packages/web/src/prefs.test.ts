/** prefs tests: typed localStorage with graceful degradation. */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadPrefs, savePrefs, PREFS_KEY, MAX_RECENT_REPOS } from './prefs';

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('loadPrefs', () => {
  test('defaults with empty storage', () => {
    expect(loadPrefs()).toEqual({ theme: null, activeView: 'changes', recentRepos: [] });
  });

  test('defaults on corrupt JSON', () => {
    localStorage.setItem(PREFS_KEY, '{not json');
    expect(loadPrefs()).toEqual({ theme: null, activeView: 'changes', recentRepos: [] });
  });

  test('defaults on a non-object payload', () => {
    localStorage.setItem(PREFS_KEY, '"dark"');
    expect(loadPrefs()).toEqual({ theme: null, activeView: 'changes', recentRepos: [] });
  });

  test('drops invalid field values, keeps valid ones', () => {
    localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({
        theme: 'solarized',
        activeView: 'history',
        recentRepos: ['/a', 42, '/b', null],
      })
    );
    expect(loadPrefs()).toEqual({
      theme: null,
      activeView: 'history',
      recentRepos: ['/a', '/b'],
    });
  });

  test('caps recentRepos on read', () => {
    const paths = Array.from({ length: 20 }, (_, i) => `/repo-${i}`);
    localStorage.setItem(PREFS_KEY, JSON.stringify({ recentRepos: paths }));
    expect(loadPrefs().recentRepos).toHaveLength(MAX_RECENT_REPOS);
  });

  test('degrades to defaults when localStorage throws (private mode / quota)', () => {
    vi.stubGlobal('localStorage', {
      getItem(): string | null {
        throw new Error('SecurityError: storage denied');
      },
      setItem(): void {
        throw new Error('QuotaExceededError');
      },
    });

    expect(loadPrefs()).toEqual({ theme: null, activeView: 'changes', recentRepos: [] });
    // Writes are swallowed too — prefs just don't persist.
    expect(() => savePrefs({ activeView: 'history' })).not.toThrow();
  });
});

describe('savePrefs', () => {
  test('merges a partial patch into stored prefs', () => {
    savePrefs({ theme: 'light-ansi' });
    savePrefs({ activeView: 'explorer' });
    expect(loadPrefs()).toEqual({
      theme: 'light-ansi',
      activeView: 'explorer',
      recentRepos: [],
    });
  });

  test('roundtrips recent repos', () => {
    savePrefs({ recentRepos: ['/x', '/y'] });
    expect(loadPrefs().recentRepos).toEqual(['/x', '/y']);
  });
});
