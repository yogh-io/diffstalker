/**
 * useUiStore: app-level UI state — theme, active view, recent repos,
 * the auto-mode toggle (+ its row flash), the diff syntax-highlighting
 * toggle, the diff layout mode (unified/split), the image-diff compare
 * mode (side by side / swipe / onion), the Changes stack's active
 * section key, and the active overlay (fuzzy finder / hotkeys help).
 * Theme, view, recents, auto mode, diff syntax, diff mode and image-diff
 * mode persist through prefs (localStorage); the theme lands on
 * <html data-theme="..."> so the CSS custom-property sets select.
 * Overlay, flash, and stack-key state are session-only — never persisted.
 *
 * The initial theme honors prefers-color-scheme when no explicit choice
 * is stored (dark unless the browser asks for light).
 */

import { shallowRef } from 'vue';
import { defineStore } from 'pinia';
import { loadPrefs, savePrefs, MAX_RECENT_REPOS } from '../prefs';
import type { ViewName, DiffMode, ImageDiffMode } from '../prefs';
import type { ThemeName } from '../theme/themes';

/** The rail's view entries, in order. */
export const VIEWS: { name: ViewName; label: string }[] = [
  { name: 'changes', label: 'Changes' },
  { name: 'journal', label: 'Journal' },
  { name: 'history', label: 'History' },
  { name: 'compare', label: 'Compare' },
  { name: 'explorer', label: 'Explorer' },
];

/** The app's modal overlays. At most one is open at a time. */
export type OverlayName = 'finder' | 'search' | 'help';

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
  /** Diff syntax highlighting: app-wide, applied by every DiffView. */
  const diffSyntaxEnabled = shallowRef<boolean>(stored.diffSyntax);
  /** Diff layout: 'unified' or 'split' — app-wide, every DiffView. */
  const diffMode = shallowRef<DiffMode>(stored.diffMode);
  /**
   * How image diffs compare their two sides — app-wide, like diffMode.
   * The picker lives on the image card itself (there is no room for it
   * in the header, and it means nothing when no image is on screen).
   */
  const imageDiffMode = shallowRef<ImageDiffMode>(stored.imageDiffMode);
  /** Wrap long lines instead of horizontal scroll — diffs and the
   * Explorer file viewer, app-wide. */
  const wrapEnabled = shallowRef<boolean>(stored.wrapEnabled);
  /** Path of the file row currently flashed by auto mode, null when none. */
  const flashedFile = shallowRef<string | null>(null);
  let flashTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * The Changes stack's active section key (`s:`/`u:` + path): written
   * optimistically by list clicks/auto jumps and confirmed by the
   * stack's scroll-spy; the file list styles its active row from it.
   */
  const activeStackKey = shallowRef<string | null>(null);

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

  function toggleDiffSyntax(): void {
    diffSyntaxEnabled.value = !diffSyntaxEnabled.value;
    savePrefs({ diffSyntax: diffSyntaxEnabled.value });
  }

  function toggleDiffMode(): void {
    diffMode.value = diffMode.value === 'split' ? 'unified' : 'split';
    savePrefs({ diffMode: diffMode.value });
  }

  /** Set (not toggle): the picker is a radiogroup of three. */
  function setImageDiffMode(mode: ImageDiffMode): void {
    imageDiffMode.value = mode;
    savePrefs({ imageDiffMode: mode });
  }

  function toggleWrap(): void {
    wrapEnabled.value = !wrapEnabled.value;
    savePrefs({ wrapEnabled: wrapEnabled.value });
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

  function setActiveStackKey(key: string | null): void {
    activeStackKey.value = key;
  }

  /**
   * A one-shot "put this anchor on screen" request, for the URL layer:
   * restoring a link's file selects it in the store, but the stacked diff
   * only scrolls when the view is TOLD to. It cannot be a watcher on
   * activeStackKey — the scroll-spy writes that key back as the user
   * scrolls, so a view scrolling on every change would fight them. The
   * seq makes a repeat request for the same key distinct.
   */
  const stackScrollRequest = shallowRef<{ key: string; seq: number } | null>(null);
  let stackScrollSeq = 0;

  function requestStackScroll(key: string): void {
    stackScrollSeq += 1;
    stackScrollRequest.value = { key, seq: stackScrollSeq };
  }

  /**
   * A one-shot "mount every diff body the size gate is holding back".
   * Same seq trick as stackScrollRequest, and for the same reason: a
   * plain counter would be inert the second time it is asked for.
   *
   * This exists so browser find-in-page can reach the whole changeset.
   * Windowed virtualization was rejected to keep Ctrl+F working; the
   * "Load diff" gate is the one remaining hole, and this closes it.
   */
  const expandGatedRequest = shallowRef<number>(0);

  function requestExpandGated(): void {
    expandGatedRequest.value += 1;
  }

  /**
   * A one-shot "show the outline" request. Seq-stamped like the others: a
   * second `o` press must be a distinct request, not an inert repeat.
   */
  const outlineRequest = shallowRef<number>(0);

  function requestOutline(): void {
    outlineRequest.value += 1;
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
    diffSyntaxEnabled,
    diffMode,
    imageDiffMode,
    wrapEnabled,
    flashedFile,
    activeStackKey,
    stackScrollRequest,
    expandGatedRequest,
    outlineRequest,
    init,
    setTheme,
    setActiveView,
    addRecentRepo,
    toggleAutoMode,
    toggleDiffSyntax,
    toggleDiffMode,
    setImageDiffMode,
    toggleWrap,
    flashFile,
    setActiveStackKey,
    requestStackScroll,
    requestExpandGated,
    requestOutline,
    openOverlay,
    toggleOverlay,
    closeOverlay,
  };
});
