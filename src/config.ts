import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ThemeName } from './themes.js';

export interface Config {
  pager?: string;
  targetFile: string;
  watcherEnabled: boolean;
  debug: boolean;
  theme: ThemeName;
  splitRatio?: number;
}

const defaultConfig: Config = {
  targetFile: path.join(os.homedir(), '.cache', 'diffstalker', 'target'),
  watcherEnabled: false, // Watcher is opt-in via --follow
  debug: false,
  theme: 'dark',
};

const CONFIG_PATH = path.join(os.homedir(), '.config', 'diffstalker', 'config.json');

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

  // Override from environment
  if (process.env.DIFFSTALKER_PAGER) {
    config.pager = process.env.DIFFSTALKER_PAGER;
  }

  // Try to load from config file
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const fileConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      if (fileConfig.pager) config.pager = fileConfig.pager;
      if (fileConfig.targetFile) config.targetFile = fileConfig.targetFile;
      if (isValidTheme(fileConfig.theme)) config.theme = fileConfig.theme;
      if (
        typeof fileConfig.splitRatio === 'number' &&
        fileConfig.splitRatio >= 0.15 &&
        fileConfig.splitRatio <= 0.85
      ) {
        config.splitRatio = fileConfig.splitRatio;
      }
    } catch {
      // Ignore config file errors
    }
  }

  return config;
}

export function saveConfig(
  updates: Partial<Pick<Config, 'theme' | 'pager' | 'targetFile' | 'splitRatio'>>
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

export function ensureTargetDir(targetFile: string): void {
  const dir = path.dirname(targetFile);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function abbreviateHomePath(fullPath: string): string {
  const home = os.homedir();
  if (fullPath.startsWith(home)) {
    return '~' + fullPath.slice(home.length);
  }
  return fullPath;
}
