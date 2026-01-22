import { describe, it, expect } from 'vitest';
import { breakLine, getLineRowCount } from './lineBreaking.js';

describe('breakLine', () => {
  describe('short content', () => {
    it('returns single segment for content shorter than maxWidth', () => {
      const result = breakLine('hello', 10);
      expect(result).toEqual([{ text: 'hello', isContinuation: false }]);
    });

    it('returns single segment for content equal to maxWidth', () => {
      const result = breakLine('hello', 5);
      expect(result).toEqual([{ text: 'hello', isContinuation: false }]);
    });

    it('returns single segment for empty string', () => {
      const result = breakLine('', 10);
      expect(result).toEqual([{ text: '', isContinuation: false }]);
    });
  });

  describe('breaking at exact character boundaries', () => {
    it('breaks at exact maxWidth', () => {
      const result = breakLine('abcdefghij', 5);
      expect(result.length).toBe(2);
      expect(result[0].text).toBe('abcde');
      expect(result[1].text).toBe('fghij');
    });

    it('breaks long string into multiple segments', () => {
      const result = breakLine('abcdefghijklmnopqrstuvwxyz', 10);
      expect(result.length).toBe(3);
      expect(result[0].text).toBe('abcdefghij');
      expect(result[1].text).toBe('klmnopqrst');
      expect(result[2].text).toBe('uvwxyz');
    });

    it('handles very long strings', () => {
      const longString = 'x'.repeat(100);
      const result = breakLine(longString, 30);
      expect(result.length).toBe(4);
      expect(result[0].text.length).toBe(30);
      expect(result[1].text.length).toBe(30);
      expect(result[2].text.length).toBe(30);
      expect(result[3].text.length).toBe(10);
    });

    it('does not try to break at special characters', () => {
      // With exact breaking, dots/slashes don't matter
      const result = breakLine('com.example.package.ClassName', 15);
      expect(result[0].text).toBe('com.example.pac');
      expect(result[1].text).toBe('kage.ClassName');
    });
  });

  describe('continuation flags', () => {
    it('marks first segment as not continuation', () => {
      const result = breakLine('a'.repeat(30), 10);
      expect(result[0].isContinuation).toBe(false);
    });

    it('marks subsequent segments as continuation', () => {
      const result = breakLine('a'.repeat(30), 10);
      expect(result[1].isContinuation).toBe(true);
      expect(result[2].isContinuation).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('handles maxWidth of 0', () => {
      const result = breakLine('hello', 0);
      expect(result).toEqual([{ text: 'hello', isContinuation: false }]);
    });

    it('handles negative maxWidth', () => {
      const result = breakLine('hello', -5);
      expect(result).toEqual([{ text: 'hello', isContinuation: false }]);
    });

    it('handles maxWidth of 1', () => {
      const result = breakLine('abc', 1);
      expect(result.length).toBe(3);
      expect(result[0].text).toBe('a');
      expect(result[1].text).toBe('b');
      expect(result[2].text).toBe('c');
    });

    it('preserves trailing spaces', () => {
      const result = breakLine('hello   ', 20);
      expect(result[0].text).toBe('hello   ');
    });
  });

  describe('real-world examples', () => {
    it('handles Java import statement', () => {
      const content = 'nl.overheid.aerius.connectservice.PermitLowerBound';
      const result = breakLine(content, 30);
      // 50 chars at 30 per line = 2 segments
      expect(result.length).toBe(2);
      expect(result[0].text).toBe('nl.overheid.aerius.connectserv');
      expect(result[1].text).toBe('ice.PermitLowerBound');
      // Joined should equal original
      expect(result.map((s) => s.text).join('')).toBe(content);
    });

    it('handles method chain', () => {
      const content = 'Optional.ofNullable(option).orElse(null)';
      const result = breakLine(content, 25);
      expect(result.length).toBe(2);
      expect(result[0].text).toBe('Optional.ofNullable(optio');
      expect(result[1].text).toBe('n).orElse(null)');
      expect(result.map((s) => s.text).join('')).toBe(content);
    });
  });
});

describe('getLineRowCount', () => {
  it('returns 1 for short content', () => {
    expect(getLineRowCount('hello', 10)).toBe(1);
  });

  it('returns 1 for content equal to maxWidth', () => {
    expect(getLineRowCount('hello', 5)).toBe(1);
  });

  it('returns correct count for long content', () => {
    expect(getLineRowCount('a'.repeat(25), 10)).toBe(3);
  });

  it('returns 1 for invalid maxWidth', () => {
    expect(getLineRowCount('hello', 0)).toBe(1);
    expect(getLineRowCount('hello', -1)).toBe(1);
  });

  it('uses simple math for row count', () => {
    // 50 chars at 30 per line = ceil(50/30) = 2
    expect(getLineRowCount('x'.repeat(50), 30)).toBe(2);
    // 100 chars at 30 per line = ceil(100/30) = 4
    expect(getLineRowCount('x'.repeat(100), 30)).toBe(4);
  });
});
