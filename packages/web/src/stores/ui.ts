/**
 * useUiStore: app-level UI state — theme, active view, recent repos.
 * Everything persists through prefs (localStorage); the theme lands on
 * <html data-theme="..."> so the CSS custom-property sets select.
 *
 * The initial theme honors prefers-color-scheme when no explicit choice
 * is stored (dark unless the browser asks for light).
 */

import { shallowRef } from 'vue';
import { defineStore } from 'pinia';
import { loadPrefs, savePrefs, MAX_RECENT_REPOS } from '../prefs';
import type { ViewName } from '../prefs';
import type { ThemeName } from '../theme/themes';

/** The rail's view entries, in order. */
export const VIEWS: { name: ViewName; label: string }[] = [
  { name: 'changes', label: 'Changes' },
  { name: 'history', label: 'History' },
  { name: 'compare', label: 'Compare' },
  { name: 'explorer', label: 'Explorer' },
];

function systemTheme(): ThemeName {
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    if (window.matchMedia('(prefers-color-scheme: light)').matches) return 'light';
  }
  return 'dark';
}

function applyTheme(name: ThemeName): void {
  document.documentElement.dataset.theme = name;
}

export const useUiStore = defineStore('ui', () => {
  const stored = loadPrefs();

  const theme = shallowRef<ThemeName>(stored.theme ?? systemTheme());
  const activeView = shallowRef<ViewName>(stored.activeView);
  const recentRepos = shallowRef<string[]>(stored.recentRepos);

  /** Stamp the current theme onto <html>. Called once at app setup. */
  function init(): void {
    applyTheme(theme.value);
  }

  function setTheme(name: ThemeName): void {
    theme.value = name;
    applyTheme(name);
    savePrefs({ theme: name });
  }

  function setActiveView(view: ViewName): void {
    activeView.value = view;
    savePrefs({ activeView: view });
  }

  /** Remember an opened repo path: most recent first, deduped, capped. */
  function addRecentRepo(path: string): void {
    const next = [path, ...recentRepos.value.filter((p) => p !== path)].slice(
      0,
      MAX_RECENT_REPOS
    );
    recentRepos.value = next;
    savePrefs({ recentRepos: next });
  }

  return {
    theme,
    activeView,
    recentRepos,
    init,
    setTheme,
    setActiveView,
    addRecentRepo,
  };
});
