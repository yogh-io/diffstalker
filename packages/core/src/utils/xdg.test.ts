import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { configDir, cacheDir, runtimeDir, stateDir } from './xdg.js';

const saved = {
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
  XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
  XDG_STATE_HOME: process.env.XDG_STATE_HOME,
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
  delete process.env.XDG_STATE_HOME;
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

  it('stateDir defaults to ~/.local/state/diffstalker', () => {
    expect(stateDir()).toBe(path.join(os.homedir(), '.local', 'state', 'diffstalker'));
  });

  it('stateDir honors XDG_STATE_HOME', () => {
    process.env.XDG_STATE_HOME = '/custom/state';
    expect(stateDir()).toBe('/custom/state/diffstalker');
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
    process.env.XDG_STATE_HOME = '';
    expect(configDir()).toBe(path.join(os.homedir(), '.config', 'diffstalker'));
    expect(cacheDir()).toBe(path.join(os.homedir(), '.cache', 'diffstalker'));
    expect(stateDir()).toBe(path.join(os.homedir(), '.local', 'state', 'diffstalker'));
    expect(runtimeDir()).toBeNull();
  });
});
