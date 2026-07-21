/**
 * useUiStore: app-level UI state — theme, active view, recent repos,
 * the auto-mode toggle (+ its row flash), and the active overlay
 * (fuzzy finder / hotkeys help). Theme, view, recents and auto mode
 * persist through prefs (localStorage); the theme lands on
 * <html data-theme="..."> so the CSS custom-property sets select.
 * Overlay and flash state are session-only — never persisted.
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

/** The app's modal overlays. At most one is open at a time. */
export type OverlayName = 'finder' | 'help';

/** How long the auto-selected file's row stays flashed (CLI parity). */
export const FLASH_MS = 900;

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
  const activeOverlay = shallowRef<OverlayName | null>(null);
  /** Auto mode: pure viewing — auto-select/auto-switch, no mutations. */
  const autoModeEnabled = shallowRef<boolean>(stored.autoMode);
  /** Path of the file row currently flashed by auto mode, null when none. */
  const flashedFile = shallowRef<string | null>(null);
  let flashTimer: ReturnType<typeof setTimeout> | null = null;

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

  // --- Auto mode ---

  function toggleAutoMode(): void {
    autoModeEnabled.value = !autoModeEnabled.value;
    savePrefs({ autoMode: autoModeEnabled.value });
  }

  /** Briefly highlight a file row (auto-selected), then clear. */
  function flashFile(path: string): void {
    flashedFile.value = path;
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      flashedFile.value = null;
      flashTimer = null;
    }, FLASH_MS);
  }

  // --- Overlays (finder / help) ---

  function openOverlay(name: OverlayName): void {
    activeOverlay.value = name;
  }

  /** Open when closed or another overlay is up; close when it's the one open. */
  function toggleOverlay(name: OverlayName): void {
    activeOverlay.value = activeOverlay.value === name ? null : name;
  }

  function closeOverlay(): void {
    activeOverlay.value = null;
  }

  return {
    theme,
    activeView,
    recentRepos,
    activeOverlay,
    autoModeEnabled,
    flashedFile,
    init,
    setTheme,
    setActiveView,
    addRecentRepo,
    toggleAutoMode,
    flashFile,
    openOverlay,
    toggleOverlay,
    closeOverlay,
  };
});
