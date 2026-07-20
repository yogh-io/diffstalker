import { describe, it, expect } from 'vitest';
import { highlightLine, highlightBlock } from './syntaxHighlight.js';

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

describe('highlightBlock', () => {
  it('returns original lines for empty language', () => {
    const lines = ['line1', 'line2'];
    expect(highlightBlock(lines, '')).toEqual(lines);
  });

  it('returns empty array for empty input', () => {
    expect(highlightBlock([], 'typescript')).toEqual([]);
  });

  it('highlights multiple lines preserving count', () => {
    const lines = ['const a = 1;', 'const b = 2;', 'const c = 3;'];
    const result = highlightBlock(lines, 'typescript');
    expect(result.length).toBe(3);
    // At least some lines should have highlighting
    expect(result.some((l) => l.includes('\x1b['))).toBe(true);
  });
});
