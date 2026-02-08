import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isValidTheme, VALID_THEMES, loadConfig, saveConfig, addRecentRepo } from './config.js';

describe('isValidTheme', () => {
  it('returns true for dark theme', () => {
    expect(isValidTheme('dark')).toBe(true);
  });

  it('returns true for light theme', () => {
    expect(isValidTheme('light')).toBe(true);
  });

  it('returns true for dark-colorblind theme', () => {
    expect(isValidTheme('dark-colorblind')).toBe(true);
  });

  it('returns true for light-colorblind theme', () => {
    expect(isValidTheme('light-colorblind')).toBe(true);
  });

  it('returns true for dark-ansi theme', () => {
    expect(isValidTheme('dark-ansi')).toBe(true);
  });

  it('returns true for light-ansi theme', () => {
    expect(isValidTheme('light-ansi')).toBe(true);
  });

  it('returns true for all themes in VALID_THEMES', () => {
    for (const theme of VALID_THEMES) {
      expect(isValidTheme(theme)).toBe(true);
    }
  });

  it('returns false for invalid theme strings', () => {
    expect(isValidTheme('invalid')).toBe(false);
    expect(isValidTheme('Dark')).toBe(false); // case sensitive
    expect(isValidTheme('DARK')).toBe(false);
    expect(isValidTheme('')).toBe(false);
    expect(isValidTheme('dark ')).toBe(false); // trailing space
    expect(isValidTheme(' dark')).toBe(false); // leading space
  });

  it('returns false for non-string inputs', () => {
    expect(isValidTheme(null)).toBe(false);
    expect(isValidTheme(undefined)).toBe(false);
    expect(isValidTheme(123)).toBe(false);
    expect(isValidTheme({})).toBe(false);
    expect(isValidTheme([])).toBe(false);
    expect(isValidTheme(true)).toBe(false);
  });
});

/**
 * Tests for loadConfig/saveConfig toggle persistence.
 * Uses a real temp directory to avoid fs mocking issues with bun test.
 */
describe('loadConfig/saveConfig toggle fields', () => {
  const configPath = path.join(os.homedir(), '.config', 'diffstalker', 'config.json');
  let originalContent: string | null = null;

  beforeEach(() => {
    // Back up existing config if present
    try {
      originalContent = fs.readFileSync(configPath, 'utf-8');
    } catch {
      originalContent = null;
    }
  });

  afterEach(() => {
    // Restore original config
    if (originalContent !== null) {
      fs.writeFileSync(configPath, originalContent);
    } else {
      // Remove config file if it didn't exist before
      try {
        fs.unlinkSync(configPath);
      } catch {
        // Ignore if already gone
      }
    }
  });

  it('reads boolean toggle values from config file', () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        autoTabEnabled: true,
        wrapMode: true,
        mouseEnabled: false,
      })
    );

    const config = loadConfig();
    expect(config.autoTabEnabled).toBe(true);
    expect(config.wrapMode).toBe(true);
    expect(config.mouseEnabled).toBe(false);
  });

  it('ignores non-boolean values for toggle fields', () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        autoTabEnabled: 'yes',
        wrapMode: 1,
        mouseEnabled: null,
      })
    );

    const config = loadConfig();
    expect(config.autoTabEnabled).toBeUndefined();
    expect(config.wrapMode).toBeUndefined();
    expect(config.mouseEnabled).toBeUndefined();
  });

  it('defaults are correct when config file has no toggle fields', () => {
    fs.writeFileSync(configPath, JSON.stringify({ theme: 'dark' }));

    const config = loadConfig();
    expect(config.autoTabEnabled).toBeUndefined();
    expect(config.wrapMode).toBeUndefined();
    expect(config.mouseEnabled).toBeUndefined();
  });

  it('saveConfig persists toggle values', () => {
    // Start with a clean config
    fs.writeFileSync(configPath, JSON.stringify({ theme: 'dark' }));

    saveConfig({ autoTabEnabled: true, wrapMode: false, mouseEnabled: false });

    const written = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(written.autoTabEnabled).toBe(true);
    expect(written.wrapMode).toBe(false);
    expect(written.mouseEnabled).toBe(false);
    expect(written.theme).toBe('dark'); // preserved existing
  });

  it('round-trip: save then load preserves values', () => {
    // Start clean
    fs.writeFileSync(configPath, JSON.stringify({}));

    saveConfig({ autoTabEnabled: true, mouseEnabled: false });

    const config = loadConfig();
    expect(config.autoTabEnabled).toBe(true);
    expect(config.mouseEnabled).toBe(false);
  });
});

describe('recentRepos config', () => {
  const configPath = path.join(os.homedir(), '.config', 'diffstalker', 'config.json');
  let originalContent: string | null = null;

  beforeEach(() => {
    try {
      originalContent = fs.readFileSync(configPath, 'utf-8');
    } catch {
      originalContent = null;
    }
  });

  afterEach(() => {
    if (originalContent !== null) {
      fs.writeFileSync(configPath, originalContent);
    } else {
      try {
        fs.unlinkSync(configPath);
      } catch {
        // Ignore if already gone
      }
    }
  });

  it('loadConfig reads recentRepos as string array', () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({ recentRepos: ['/home/user/repoA', '/home/user/repoB'] })
    );

    const config = loadConfig();
    expect(config.recentRepos).toEqual(['/home/user/repoA', '/home/user/repoB']);
  });

  it('loadConfig rejects non-array recentRepos', () => {
    fs.writeFileSync(configPath, JSON.stringify({ recentRepos: 'not-an-array' }));

    const config = loadConfig();
    expect(config.recentRepos).toBeUndefined();
  });

  it('loadConfig rejects recentRepos array with non-strings', () => {
    fs.writeFileSync(configPath, JSON.stringify({ recentRepos: ['/valid', 123, null] }));

    const config = loadConfig();
    expect(config.recentRepos).toBeUndefined();
  });

  it('loadConfig reads maxRecentRepos within valid range', () => {
    fs.writeFileSync(configPath, JSON.stringify({ maxRecentRepos: 20 }));

    const config = loadConfig();
    expect(config.maxRecentRepos).toBe(20);
  });

  it('loadConfig rejects maxRecentRepos outside range', () => {
    fs.writeFileSync(configPath, JSON.stringify({ maxRecentRepos: 0 }));
    expect(loadConfig().maxRecentRepos).toBeUndefined();

    fs.writeFileSync(configPath, JSON.stringify({ maxRecentRepos: 51 }));
    expect(loadConfig().maxRecentRepos).toBeUndefined();

    fs.writeFileSync(configPath, JSON.stringify({ maxRecentRepos: 'ten' }));
    expect(loadConfig().maxRecentRepos).toBeUndefined();
  });

  it('addRecentRepo prepends and deduplicates', () => {
    fs.writeFileSync(configPath, JSON.stringify({ recentRepos: ['/repoA', '/repoB', '/repoC'] }));

    addRecentRepo('/repoB');

    const written = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(written.recentRepos).toEqual(['/repoB', '/repoA', '/repoC']);
  });

  it('addRecentRepo caps at max', () => {
    fs.writeFileSync(configPath, JSON.stringify({ recentRepos: ['/r1', '/r2', '/r3'] }));

    addRecentRepo('/r4', 3);

    const written = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(written.recentRepos).toEqual(['/r4', '/r1', '/r2']);
  });

  it('addRecentRepo works with no existing config', () => {
    // Ensure config file doesn't exist
    try {
      fs.unlinkSync(configPath);
    } catch {
      // Ignore
    }

    addRecentRepo('/newRepo');

    const written = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(written.recentRepos).toEqual(['/newRepo']);
  });
});
