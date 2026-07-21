import { describe, it, expect } from 'vitest';
import { themes, themeOrder, getTheme, isThemeName } from './themes.js';
import type { DiffColors, ThemeName } from './themes.js';

const DIFF_COLOR_KEYS: (keyof DiffColors)[] = [
  'addBg',
  'delBg',
  'addHighlight',
  'delHighlight',
  'text',
  'addLineNum',
  'delLineNum',
  'contextLineNum',
  'addSymbol',
  'delSymbol',
];

describe('themeOrder', () => {
  it('lists every theme exactly once', () => {
    expect([...themeOrder].sort()).toEqual(Object.keys(themes).sort());
  });
});

describe('getTheme', () => {
  it('returns the matching theme for every themeOrder entry', () => {
    for (const name of themeOrder) {
      const theme = getTheme(name);
      expect(theme.name).toBe(name);
      expect(theme.displayName.length).toBeGreaterThan(0);
    }
  });

  it('falls back to dark for an unknown name', () => {
    expect(getTheme('solarized' as ThemeName).name).toBe('dark');
  });
});

describe('isThemeName', () => {
  it('accepts every themeOrder entry', () => {
    for (const name of themeOrder) {
      expect(isThemeName(name)).toBe(true);
    }
  });

  it('rejects anything else', () => {
    expect(isThemeName('solarized')).toBe(false);
    expect(isThemeName('')).toBe(false);
    expect(isThemeName(null)).toBe(false);
    expect(isThemeName(undefined)).toBe(false);
    expect(isThemeName(42)).toBe(false);
  });
});

describe('theme colors', () => {
  it('no theme is missing a shared color', () => {
    for (const name of themeOrder) {
      const colors = themes[name].colors;
      for (const key of DIFF_COLOR_KEYS) {
        expect(typeof colors[key]).toBe('string');
        expect(colors[key].length).toBeGreaterThan(0);
      }
    }
  });
});
