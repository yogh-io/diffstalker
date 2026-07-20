/**
 * Client-side preferences in localStorage — the browser analog of the
 * CLI's ~/.config/diffstalker/config.json. One JSON blob under a single
 * key; every field validates on read, so absent or corrupt storage
 * degrades to the defaults instead of throwing.
 */

import { isThemeName } from './theme/themes';
import type { ThemeName } from './theme/themes';

export const PREFS_KEY = 'diffstalker:prefs';

export const VIEW_NAMES = ['changes', 'history', 'compare', 'explorer'] as const;
export type ViewName = (typeof VIEW_NAMES)[number];

export function isViewName(value: unknown): value is ViewName {
  return typeof value === 'string' && (VIEW_NAMES as readonly string[]).includes(value);
}

export interface Prefs {
  /** null = no explicit choice yet; derive from prefers-color-scheme. */
  theme: ThemeName | null;
  activeView: ViewName;
  recentRepos: string[];
}

export const MAX_RECENT_REPOS = 8;

function defaults(): Prefs {
  return { theme: null, activeView: 'changes', recentRepos: [] };
}

function sanitize(raw: unknown): Prefs {
  const prefs = defaults();
  if (typeof raw !== 'object' || raw === null) return prefs;
  const record = raw as Record<string, unknown>;
  if (isThemeName(record.theme)) prefs.theme = record.theme;
  if (isViewName(record.activeView)) prefs.activeView = record.activeView;
  if (Array.isArray(record.recentRepos)) {
    prefs.recentRepos = record.recentRepos
      .filter((entry): entry is string => typeof entry === 'string')
      .slice(0, MAX_RECENT_REPOS);
  }
  return prefs;
}

export function loadPrefs(): Prefs {
  let text: string | null = null;
  try {
    text = localStorage.getItem(PREFS_KEY);
  } catch {
    return defaults();
  }
  if (text === null) return defaults();
  try {
    return sanitize(JSON.parse(text));
  } catch {
    return defaults();
  }
}

/** Merge a partial update into the stored prefs. Quota errors are swallowed. */
export function savePrefs(patch: Partial<Prefs>): void {
  const merged = { ...loadPrefs(), ...patch };
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(merged));
  } catch {
    // Storage unavailable (private mode, quota): prefs just don't persist.
  }
}
