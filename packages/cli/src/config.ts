import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { configDir, cacheDir } from '@diffstalker/core/utils/xdg';
import { ThemeName } from './themes.js';

export interface Config {
  targetFile: string;
  watcherEnabled: boolean;
  debug: boolean;
  theme: ThemeName;
  splitRatio?: number;
  autoTabEnabled?: boolean;
  wrapMode?: boolean;
  mouseEnabled?: boolean;
  recentRepos?: string[];
  maxRecentRepos?: number;
}

export const defaultConfig: Config = {
  targetFile: path.join(cacheDir(), 'target'),
  watcherEnabled: false, // Watcher is opt-in via --follow
  debug: false,
  theme: 'dark',
};

const CONFIG_PATH = path.join(configDir(), 'config.json');

export const VALID_THEMES: ThemeName[] = [
  'dark',
  'light',
  'dark-colorblind',
  'light-colorblind',
  'dark-ansi',
  'light-ansi',
];

export function isValidTheme(theme: unknown): theme is ThemeName {
  return typeof theme === 'string' && VALID_THEMES.includes(theme as ThemeName);
}

export function loadConfig(): Config {
  const config = { ...defaultConfig };

  // Try to load from config file
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const fileConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      if (fileConfig.targetFile) config.targetFile = fileConfig.targetFile;
      // Back-compat: a pre-0.5 config persisted watcherEnabled/debug. Keep
      // honoring them so an existing config that turned follow on still does.
      if (typeof fileConfig.watcherEnabled === 'boolean') {
        config.watcherEnabled = fileConfig.watcherEnabled;
      }
      if (typeof fileConfig.debug === 'boolean') {
        config.debug = fileConfig.debug;
      }
      if (isValidTheme(fileConfig.theme)) config.theme = fileConfig.theme;
      if (
        typeof fileConfig.splitRatio === 'number' &&
        fileConfig.splitRatio >= 0.15 &&
        fileConfig.splitRatio <= 0.85
      ) {
        config.splitRatio = fileConfig.splitRatio;
      }
      if (typeof fileConfig.autoTabEnabled === 'boolean') {
        config.autoTabEnabled = fileConfig.autoTabEnabled;
      }
      if (typeof fileConfig.wrapMode === 'boolean') {
        config.wrapMode = fileConfig.wrapMode;
      }
      if (typeof fileConfig.mouseEnabled === 'boolean') {
        config.mouseEnabled = fileConfig.mouseEnabled;
      }
      if (
        Array.isArray(fileConfig.recentRepos) &&
        fileConfig.recentRepos.every((r: unknown) => typeof r === 'string')
      ) {
        config.recentRepos = fileConfig.recentRepos;
      }
      if (
        typeof fileConfig.maxRecentRepos === 'number' &&
        fileConfig.maxRecentRepos >= 1 &&
        fileConfig.maxRecentRepos <= 50
      ) {
        config.maxRecentRepos = fileConfig.maxRecentRepos;
      }
    } catch {
      // Ignore config file errors
    }
  }

  return config;
}

export function saveConfig(
  updates: Partial<
    Pick<
      Config,
      | 'theme'
      | 'targetFile'
      | 'splitRatio'
      | 'autoTabEnabled'
      | 'wrapMode'
      | 'mouseEnabled'
      | 'recentRepos'
      | 'maxRecentRepos'
    >
  >
): void {
  // Ensure config directory exists
  const configDir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  // Load existing config or start fresh
  let fileConfig: Record<string, unknown> = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    } catch {
      // Start fresh if file is corrupted
    }
  }

  // Apply updates
  Object.assign(fileConfig, updates);

  // Write back
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(fileConfig, null, 2) + '\n');
}

/**
 * Which hook file the daemon should be told to follow (--follow-file), given
 * the loaded config and an explicit --follow FILE (if any).
 *
 * - An explicit --follow FILE always wins.
 * - Otherwise, when follow is enabled (config.watcherEnabled — set by --follow
 *   or persisted from a pre-0.5 config) and the config points at a NON-default
 *   target, that target is returned so the daemon follows the user's file.
 * - A default target is left implicit (undefined) to preserve the graceful
 *   attach to an already-running daemon (no follow-file conflict on default).
 */
export function resolveFollowFile(config: Config, explicitFollowFile?: string): string | undefined {
  if (explicitFollowFile !== undefined) return explicitFollowFile;
  if (config.watcherEnabled && config.targetFile !== defaultConfig.targetFile) {
    return config.targetFile;
  }
  return undefined;
}

export function abbreviateHomePath(fullPath: string): string {
  const home = os.homedir();
  if (fullPath.startsWith(home)) {
    return '~' + fullPath.slice(home.length);
  }
  return fullPath;
}

function normalizeRepoPath(p: string): string {
  return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
}

export function addRecentRepo(repoPath: string, maxRecentRepos: number = 10): void {
  const normalized = normalizeRepoPath(repoPath);
  let existing: string[] = [];
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const fileConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      if (Array.isArray(fileConfig.recentRepos)) existing = fileConfig.recentRepos;
    } catch {
      // start fresh
    }
  }
  const filtered = existing.filter((r) => normalizeRepoPath(r) !== normalized);
  saveConfig({
    recentRepos: [normalized, ...filtered.map(normalizeRepoPath)].slice(0, maxRecentRepos),
  });
}
