import { describe, it, expect } from 'vitest';
import { highlightLine } from './syntaxHighlight.js';

describe('highlightLine', () => {
  it('returns original content if language is empty', () => {
    expect(highlightLine('const x = 1;', '')).toBe('const x = 1;');
  });

  it('returns original content if content is empty', () => {
    expect(highlightLine('', 'typescript')).toBe('');
  });

  it('applies highlighting to TypeScript code', () => {
    const result = highlightLine('const x = 1;', 'typescript');
    // Should contain ANSI escape codes
    expect(result).toContain('\x1b[');
  });

  it('returns original on invalid language', () => {
    const input = 'some code';
    expect(highlightLine(input, 'not-a-language')).toBe(input);
  });
});
