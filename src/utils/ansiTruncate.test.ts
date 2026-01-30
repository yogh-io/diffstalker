import { describe, it, expect } from 'vitest';
import { visualLength, truncateAnsi, needsTruncation } from './ansiTruncate.js';

describe('visualLength', () => {
  it('returns length for plain strings', () => {
    expect(visualLength('hello')).toBe(5);
  });

  it('ignores ANSI codes', () => {
    expect(visualLength('\x1b[32mhello\x1b[0m')).toBe(5);
  });

  it('handles multiple ANSI codes', () => {
    expect(visualLength('\x1b[1;34mfoo\x1b[0m \x1b[31mbar\x1b[0m')).toBe(7);
  });

  it('returns 0 for empty string', () => {
    expect(visualLength('')).toBe(0);
  });

  it('returns 0 for ANSI-only string', () => {
    expect(visualLength('\x1b[32m\x1b[0m')).toBe(0);
  });
});

describe('truncateAnsi', () => {
  it('returns plain string unchanged if within limit', () => {
    expect(truncateAnsi('hello', 10)).toBe('hello');
  });

  it('truncates plain string with suffix', () => {
    const result = truncateAnsi('hello world', 6);
    expect(result).toBe('hello\u2026');
  });

  it('preserves ANSI codes when truncating', () => {
    const input = '\x1b[32mhello world\x1b[0m';
    const result = truncateAnsi(input, 6);
    // Should contain green start, truncated text, reset, and suffix
    expect(result).toContain('\x1b[32m');
    expect(result).toContain('\x1b[0m');
    expect(result).toContain('\u2026');
    expect(visualLength(result.replace(/\u2026$/, ''))).toBeLessThanOrEqual(6);
  });

  it('returns suffix for maxVisualLength <= 0', () => {
    expect(truncateAnsi('hello', 0)).toBe('\u2026');
  });

  it('uses custom suffix', () => {
    const result = truncateAnsi('hello world', 8, '...');
    expect(result).toBe('hello...');
  });

  it('returns ANSI string unchanged if within limit', () => {
    const input = '\x1b[32mhi\x1b[0m';
    expect(truncateAnsi(input, 10)).toBe(input);
  });
});

describe('needsTruncation', () => {
  it('returns false for short strings', () => {
    expect(needsTruncation('hello', 10)).toBe(false);
  });

  it('returns false for exact length', () => {
    expect(needsTruncation('hello', 5)).toBe(false);
  });

  it('returns true for long strings', () => {
    expect(needsTruncation('hello world', 5)).toBe(true);
  });

  it('ignores ANSI codes when checking', () => {
    expect(needsTruncation('\x1b[32mhi\x1b[0m', 5)).toBe(false);
  });
});
