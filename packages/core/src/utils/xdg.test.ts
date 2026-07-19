import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { configDir, cacheDir, runtimeDir } from './xdg.js';

const saved = {
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
  XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
};

function restore(): void {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

beforeEach(() => {
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_CACHE_HOME;
  delete process.env.XDG_RUNTIME_DIR;
});

afterAll(restore);

describe('xdg paths', () => {
  it('configDir defaults to ~/.config/diffstalker', () => {
    expect(configDir()).toBe(path.join(os.homedir(), '.config', 'diffstalker'));
  });

  it('configDir honors XDG_CONFIG_HOME', () => {
    process.env.XDG_CONFIG_HOME = '/custom/config';
    expect(configDir()).toBe('/custom/config/diffstalker');
  });

  it('cacheDir defaults to ~/.cache/diffstalker', () => {
    expect(cacheDir()).toBe(path.join(os.homedir(), '.cache', 'diffstalker'));
  });

  it('cacheDir honors XDG_CACHE_HOME', () => {
    process.env.XDG_CACHE_HOME = '/custom/cache';
    expect(cacheDir()).toBe('/custom/cache/diffstalker');
  });

  it('runtimeDir is null when XDG_RUNTIME_DIR is unset', () => {
    expect(runtimeDir()).toBeNull();
  });

  it('runtimeDir honors XDG_RUNTIME_DIR', () => {
    process.env.XDG_RUNTIME_DIR = '/run/user/1000';
    expect(runtimeDir()).toBe('/run/user/1000/diffstalker');
  });

  it('empty env vars fall back to defaults', () => {
    process.env.XDG_CONFIG_HOME = '';
    process.env.XDG_CACHE_HOME = '';
    process.env.XDG_RUNTIME_DIR = '';
    expect(configDir()).toBe(path.join(os.homedir(), '.config', 'diffstalker'));
    expect(cacheDir()).toBe(path.join(os.homedir(), '.cache', 'diffstalker'));
    expect(runtimeDir()).toBeNull();
  });
});
