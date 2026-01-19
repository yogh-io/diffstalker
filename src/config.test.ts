import { describe, it, expect } from 'vitest';
import { isValidTheme, VALID_THEMES } from './config.js';

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
