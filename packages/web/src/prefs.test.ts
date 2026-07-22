/** prefs tests: typed localStorage with graceful degradation. */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadPrefs, savePrefs, PREFS_KEY, MAX_RECENT_REPOS, TOP_MIN, TOP_MAX } from './prefs';

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('loadPrefs', () => {
  test('defaults with empty storage', () => {
    expect(loadPrefs()).toEqual({
      theme: null,
      activeView: 'changes',
      recentRepos: [],
      autoMode: false,
      diffSyntax: false,
      changesSplit: null,
      changesTop: null,
      historyTop: null,
      compareTop: null,
      explorerTop: null,
    });
  });

  test('defaults on corrupt JSON', () => {
    localStorage.setItem(PREFS_KEY, '{not json');
    expect(loadPrefs()).toEqual({
      theme: null,
      activeView: 'changes',
      recentRepos: [],
      autoMode: false,
      diffSyntax: false,
      changesSplit: null,
      changesTop: null,
      historyTop: null,
      compareTop: null,
      explorerTop: null,
    });
  });

  test('defaults on a non-object payload', () => {
    localStorage.setItem(PREFS_KEY, '"dark"');
    expect(loadPrefs()).toEqual({
      theme: null,
      activeView: 'changes',
      recentRepos: [],
      autoMode: false,
      diffSyntax: false,
      changesSplit: null,
      changesTop: null,
      historyTop: null,
      compareTop: null,
      explorerTop: null,
    });
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
      autoMode: false,
      diffSyntax: false,
      changesSplit: null,
      changesTop: null,
      historyTop: null,
      compareTop: null,
      explorerTop: null,
    });
  });

  test('caps recentRepos on read', () => {
    const paths = Array.from({ length: 20 }, (_, i) => `/repo-${i}`);
    localStorage.setItem(PREFS_KEY, JSON.stringify({ recentRepos: paths }));
    expect(loadPrefs().recentRepos).toHaveLength(MAX_RECENT_REPOS);
  });

  test('changesSplit: keeps a sane fraction, drops out-of-band or non-numeric values', () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ changesSplit: 0.4 }));
    expect(loadPrefs().changesSplit).toBe(0.4);

    localStorage.setItem(PREFS_KEY, JSON.stringify({ changesSplit: 0.95 }));
    expect(loadPrefs().changesSplit).toBeNull();

    localStorage.setItem(PREFS_KEY, JSON.stringify({ changesSplit: 'wide' }));
    expect(loadPrefs().changesSplit).toBeNull();
  });

  test('autoMode: persists a stored boolean, drops anything else', () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ autoMode: true }));
    expect(loadPrefs().autoMode).toBe(true);

    localStorage.setItem(PREFS_KEY, JSON.stringify({ autoMode: 'yes' }));
    expect(loadPrefs().autoMode).toBe(false);

    localStorage.setItem(PREFS_KEY, JSON.stringify({ autoMode: 1 }));
    expect(loadPrefs().autoMode).toBe(false);
  });

  test('diffSyntax: persists a stored boolean, drops anything else', () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ diffSyntax: true }));
    expect(loadPrefs().diffSyntax).toBe(true);

    localStorage.setItem(PREFS_KEY, JSON.stringify({ diffSyntax: 'on' }));
    expect(loadPrefs().diffSyntax).toBe(false);
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

    expect(loadPrefs()).toEqual({
      theme: null,
      activeView: 'changes',
      recentRepos: [],
      autoMode: false,
      diffSyntax: false,
      changesSplit: null,
      changesTop: null,
      historyTop: null,
      compareTop: null,
      explorerTop: null,
    });
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
      autoMode: false,
      diffSyntax: false,
      changesSplit: null,
      changesTop: null,
      historyTop: null,
      compareTop: null,
      explorerTop: null,
    });
  });

  test('roundtrips recent repos', () => {
    savePrefs({ recentRepos: ['/x', '/y'] });
    expect(loadPrefs().recentRepos).toEqual(['/x', '/y']);
  });

  test('roundtrips autoMode', () => {
    savePrefs({ autoMode: true });
    expect(loadPrefs().autoMode).toBe(true);
    savePrefs({ autoMode: false });
    expect(loadPrefs().autoMode).toBe(false);
  });
});

describe('portrait top fractions', () => {
  const KEYS = ['changesTop', 'historyTop', 'compareTop', 'explorerTop'] as const;

  test('keeps a sane fraction for every view field', () => {
    localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({ changesTop: 0.3, historyTop: TOP_MIN, compareTop: TOP_MAX, explorerTop: 0.34 })
    );
    const prefs = loadPrefs();
    expect(prefs.changesTop).toBe(0.3);
    expect(prefs.historyTop).toBe(TOP_MIN);
    expect(prefs.compareTop).toBe(TOP_MAX);
    expect(prefs.explorerTop).toBe(0.34);
  });

  test('drops out-of-band values (validated on read, per field)', () => {
    localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({ changesTop: 0.05, historyTop: 0.9, compareTop: -1, explorerTop: 0.25 })
    );
    const prefs = loadPrefs();
    expect(prefs.changesTop).toBeNull();
    expect(prefs.historyTop).toBeNull();
    expect(prefs.compareTop).toBeNull();
    expect(prefs.explorerTop).toBe(0.25);
  });

  test('drops non-numeric and non-finite values', () => {
    // Raw JSON: 1e999 parses to Infinity — a non-finite number on read.
    localStorage.setItem(
      PREFS_KEY,
      '{"changesTop":"tall","historyTop":null,"compareTop":{},"explorerTop":1e999}'
    );
    const prefs = loadPrefs();
    for (const key of KEYS) expect(prefs[key]).toBeNull();
  });

  test('roundtrips through savePrefs', () => {
    savePrefs({ historyTop: 0.4 });
    savePrefs({ explorerTop: 0.5 });
    const prefs = loadPrefs();
    expect(prefs.historyTop).toBe(0.4);
    expect(prefs.explorerTop).toBe(0.5);
    expect(prefs.changesTop).toBeNull();
  });
});
