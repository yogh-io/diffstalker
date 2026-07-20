/**
 * useUiStore tests: theme defaulting (prefers-color-scheme), theme
 * application + persistence, view routing persistence, recent repos,
 * and the overlay state (finder/help, session-only).
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useUiStore } from './ui';
import { PREFS_KEY } from '../prefs';

function stubColorScheme(scheme: 'light' | 'dark'): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: scheme === 'light' && query.includes('light'),
      media: query,
    }))
  );
}

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  setActivePinia(createPinia());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('theme', () => {
  test('defaults to dark when the browser prefers dark', () => {
    stubColorScheme('dark');
    expect(useUiStore().theme).toBe('dark');
  });

  test('defaults to light when the browser prefers light', () => {
    stubColorScheme('light');
    expect(useUiStore().theme).toBe('light');
  });

  test('a stored choice wins over prefers-color-scheme', () => {
    stubColorScheme('light');
    localStorage.setItem(PREFS_KEY, JSON.stringify({ theme: 'dark-ansi' }));
    expect(useUiStore().theme).toBe('dark-ansi');
  });

  test('init stamps data-theme on <html>', () => {
    stubColorScheme('dark');
    useUiStore().init();
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  test('setTheme applies data-theme and persists to localStorage', () => {
    stubColorScheme('dark');
    const store = useUiStore();
    store.setTheme('light-colorblind');
    expect(store.theme).toBe('light-colorblind');
    expect(document.documentElement.dataset.theme).toBe('light-colorblind');
    expect(JSON.parse(localStorage.getItem(PREFS_KEY)!).theme).toBe('light-colorblind');
  });
});

describe('active view', () => {
  test('defaults to changes; setActiveView switches and persists', () => {
    const store = useUiStore();
    expect(store.activeView).toBe('changes');
    store.setActiveView('compare');
    expect(store.activeView).toBe('compare');
    expect(JSON.parse(localStorage.getItem(PREFS_KEY)!).activeView).toBe('compare');
  });

  test('restores the stored view', () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ activeView: 'explorer' }));
    expect(useUiStore().activeView).toBe('explorer');
  });
});

describe('overlays', () => {
  test('opens, toggles, and closes; at most one overlay at a time', () => {
    const store = useUiStore();
    expect(store.activeOverlay).toBeNull();

    store.openOverlay('finder');
    expect(store.activeOverlay).toBe('finder');

    // Toggling another overlay replaces the open one.
    store.toggleOverlay('help');
    expect(store.activeOverlay).toBe('help');

    // Toggling the open overlay closes it.
    store.toggleOverlay('help');
    expect(store.activeOverlay).toBeNull();

    store.openOverlay('help');
    store.closeOverlay();
    expect(store.activeOverlay).toBeNull();
  });

  test('overlay state is never persisted', () => {
    const store = useUiStore();
    store.openOverlay('finder');
    expect(localStorage.getItem(PREFS_KEY)).toBeNull();
  });
});

describe('recent repos', () => {
  test('adds most-recent-first, dedupes, caps at 8, persists', () => {
    const store = useUiStore();
    for (let i = 0; i < 10; i++) store.addRecentRepo(`/repo-${i}`);
    store.addRecentRepo('/repo-5');

    expect(store.recentRepos[0]).toBe('/repo-5');
    expect(store.recentRepos).toHaveLength(8);
    expect(new Set(store.recentRepos).size).toBe(8);
    expect(JSON.parse(localStorage.getItem(PREFS_KEY)!).recentRepos).toEqual(store.recentRepos);
  });
});
