import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  isValidTheme,
  VALID_THEMES,
  loadConfig,
  saveConfig,
  addRecentRepo,
  resolveFollowFile,
  defaultConfig,
  type Config,
} from './config.js';

const savedConfigHome = process.env.XDG_CONFIG_HOME;
let configHome: string;
let configPath: string;

beforeEach(() => {
  configHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-config-test-'));
  process.env.XDG_CONFIG_HOME = configHome;
  configPath = path.join(configHome, 'diffstalker', 'config.json');
  fs.mkdirSync(path.dirname(configPath));
});

afterEach(() => {
  fs.rmSync(configHome, { recursive: true, force: true });
  if (savedConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedConfigHome;
});

/** Real directories: recent repos that do not exist are dropped. */
function makeRepos(...names: string[]): string[] {
  return names.map((name) => {
    const dir = path.join(configHome, name);
    fs.mkdirSync(dir);
    return dir;
  });
}

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

describe('loadConfig/saveConfig toggle fields', () => {
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

describe('back-compat: pre-0.5 config load', () => {
  it('loads a full pre-0.5 config without error and honors every field', () => {
    const [repoA] = makeRepos('repoA');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        theme: 'light',
        splitRatio: 0.4,
        watcherEnabled: true,
        targetFile: '/home/user/.cache/diffstalker/target',
        autoTabEnabled: true,
        wrapMode: false,
        mouseEnabled: true,
        recentRepos: [repoA],
        maxRecentRepos: 15,
        debug: true,
      })
    );

    const config = loadConfig();
    expect(config.theme).toBe('light');
    expect(config.splitRatio).toBe(0.4);
    expect(config.watcherEnabled).toBe(true);
    expect(config.targetFile).toBe('/home/user/.cache/diffstalker/target');
    expect(config.autoTabEnabled).toBe(true);
    expect(config.wrapMode).toBe(false);
    expect(config.mouseEnabled).toBe(true);
    expect(config.recentRepos).toEqual([repoA]);
    expect(config.maxRecentRepos).toBe(15);
    expect(config.debug).toBe(true);
  });

  it('reads watcherEnabled=true from a persisted config (follow stays on)', () => {
    fs.writeFileSync(configPath, JSON.stringify({ watcherEnabled: true }));
    expect(loadConfig().watcherEnabled).toBe(true);
  });

  it('defaults watcherEnabled to false when absent', () => {
    fs.writeFileSync(configPath, JSON.stringify({ theme: 'dark' }));
    expect(loadConfig().watcherEnabled).toBe(false);
  });
});

describe('resolveFollowFile (watcherEnabled -> follow-file mapping)', () => {
  const base: Config = { ...defaultConfig };

  it('passes an explicit --follow FILE through unchanged', () => {
    expect(resolveFollowFile({ ...base, watcherEnabled: false }, '/hook')).toBe('/hook');
  });

  it('maps a persisted watcherEnabled + custom targetFile to the daemon follow-file', () => {
    const config: Config = { ...base, watcherEnabled: true, targetFile: '/custom/target' };
    expect(resolveFollowFile(config, undefined)).toBe('/custom/target');
  });

  it('leaves a default target implicit even with follow on (graceful attach)', () => {
    const config: Config = { ...base, watcherEnabled: true };
    expect(resolveFollowFile(config, undefined)).toBeUndefined();
  });

  it('returns undefined when follow is off, even with a custom target', () => {
    const config: Config = { ...base, watcherEnabled: false, targetFile: '/custom/target' };
    expect(resolveFollowFile(config, undefined)).toBeUndefined();
  });
});

describe('recentRepos config', () => {
  it('loadConfig reads recentRepos as string array', () => {
    const recentRepos = makeRepos('repoA', 'repoB');
    fs.writeFileSync(configPath, JSON.stringify({ recentRepos }));

    const config = loadConfig();
    expect(config.recentRepos).toEqual(recentRepos);
  });

  it('loadConfig drops recent repos that are gone or not absolute', () => {
    const [kept] = makeRepos('kept');
    const gone = path.join(configHome, 'gone');
    // `src` exists under the test's working directory, and is still no repo path.
    fs.writeFileSync(configPath, JSON.stringify({ recentRepos: ['link', 'src', gone, kept] }));

    expect(loadConfig().recentRepos).toEqual([kept]);
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
    const [repoA, repoB, repoC] = makeRepos('repoA', 'repoB', 'repoC');
    fs.writeFileSync(configPath, JSON.stringify({ recentRepos: [repoA, repoB, repoC] }));

    addRecentRepo(repoB);

    const written = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(written.recentRepos).toEqual([repoB, repoA, repoC]);
  });

  it('addRecentRepo caps at max', () => {
    const [r1, r2, r3, r4] = makeRepos('r1', 'r2', 'r3', 'r4');
    fs.writeFileSync(configPath, JSON.stringify({ recentRepos: [r1, r2, r3] }));

    addRecentRepo(r4, 3);

    const written = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(written.recentRepos).toEqual([r4, r1, r2]);
  });

  it('addRecentRepo removes dead entries, so they stop pushing live ones out', () => {
    const [live, opened] = makeRepos('live', 'opened');
    const gone = path.join(configHome, 'gone');
    fs.writeFileSync(configPath, JSON.stringify({ recentRepos: [gone, 'link', live] }));

    addRecentRepo(opened, 2);

    const written = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(written.recentRepos).toEqual([opened, live]);
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
