import { describe, it, expect } from 'vitest';
import {
  buildExplorerContentRows,
  wrapExplorerContentRows,
  getExplorerContentRowCount,
  applyMiddleDots,
} from './explorerDisplayRows.js';

describe('buildExplorerContentRows', () => {
  it('returns empty array for null content', () => {
    expect(buildExplorerContentRows(null, null)).toEqual([]);
  });

  it('returns empty array for empty string', () => {
    expect(buildExplorerContentRows('', null)).toEqual([]);
  });

  it('creates one row per line', () => {
    const rows = buildExplorerContentRows('line1\nline2\nline3', null);
    expect(rows.length).toBe(3);
    expect(rows[0]).toEqual({ type: 'code', lineNum: 1, content: 'line1', highlighted: undefined });
    expect(rows[1]).toEqual({ type: 'code', lineNum: 2, content: 'line2', highlighted: undefined });
    expect(rows[2]).toEqual({ type: 'code', lineNum: 3, content: 'line3', highlighted: undefined });
  });

  it('adds truncation indicator when truncated', () => {
    const rows = buildExplorerContentRows('line1', null, true);
    expect(rows.length).toBe(2);
    expect(rows[1]).toEqual({ type: 'truncation', content: '(file truncated)' });
  });

  it('applies syntax highlighting when file path is provided', () => {
    const rows = buildExplorerContentRows('const x = 1;', 'file.ts');
    expect(rows[0].type).toBe('code');
    if (rows[0].type === 'code') {
      expect(rows[0].highlighted).toBeDefined();
      expect(rows[0].highlighted).toContain('\x1b[');
    }
  });

  it('skips highlighting for unknown file types', () => {
    const rows = buildExplorerContentRows('some content', 'file.xyz');
    expect(rows[0].type).toBe('code');
    if (rows[0].type === 'code') {
      expect(rows[0].highlighted).toBeUndefined();
    }
  });
});

describe('wrapExplorerContentRows', () => {
  it('returns rows unchanged when wrapping disabled', () => {
    const rows = buildExplorerContentRows('short', null);
    const result = wrapExplorerContentRows(rows, 20, false);
    expect(result).toEqual(rows);
  });

  it('does not wrap short lines', () => {
    const rows = buildExplorerContentRows('short', null);
    const result = wrapExplorerContentRows(rows, 20, true);
    expect(result.length).toBe(1);
  });

  it('wraps long lines into segments', () => {
    const longLine = 'a'.repeat(50);
    const rows = buildExplorerContentRows(longLine, null);
    const result = wrapExplorerContentRows(rows, 20, true);
    expect(result.length).toBe(3); // 50 chars / 20 = 3 segments
    // First segment: real lineNum, not continuation
    expect(result[0].isContinuation).toBe(false);
    if (result[0].type === 'code') {
      expect(result[0].lineNum).toBe(1);
    }
    // Second segment: continuation
    expect(result[1].isContinuation).toBe(true);
    if (result[1].type === 'code') {
      expect(result[1].lineNum).toBe(0);
    }
  });

  it('does not wrap truncation rows', () => {
    const rows = buildExplorerContentRows('line', null, true);
    const truncRow = rows.find((r) => r.type === 'truncation');
    const result = wrapExplorerContentRows(rows, 5, true);
    expect(result.filter((r) => r.type === 'truncation').length).toBe(1);
    expect(result.find((r) => r.type === 'truncation')).toEqual(truncRow);
  });

  it('enforces minimum width of 10', () => {
    const rows = buildExplorerContentRows('a'.repeat(25), null);
    const result = wrapExplorerContentRows(rows, 3, true);
    // Should use effective width of 10, so 25/10 = 3 segments
    expect(result.length).toBe(3);
  });
});

describe('getExplorerContentRowCount', () => {
  it('returns row count without wrapping', () => {
    const rows = buildExplorerContentRows('a\nb\nc', null);
    expect(getExplorerContentRowCount(rows, 20, false)).toBe(3);
  });

  it('returns expanded count with wrapping', () => {
    const longLine = 'a'.repeat(50);
    const rows = buildExplorerContentRows(longLine, null);
    expect(getExplorerContentRowCount(rows, 20, true)).toBe(3);
  });

  it('matches wrapExplorerContentRows length', () => {
    const content = 'short\n' + 'a'.repeat(50) + '\nmedium';
    const rows = buildExplorerContentRows(content, null);
    const wrapped = wrapExplorerContentRows(rows, 20, true);
    const count = getExplorerContentRowCount(rows, 20, true);
    expect(count).toBe(wrapped.length);
  });
});

describe('applyMiddleDots', () => {
  it('returns content unchanged when disabled', () => {
    expect(applyMiddleDots('  hello', false)).toBe('  hello');
  });

  it('returns empty/falsy content unchanged', () => {
    expect(applyMiddleDots('', true)).toBe('');
  });

  it('replaces leading spaces with dots', () => {
    expect(applyMiddleDots('  hello', true)).toBe('\u00b7\u00b7hello');
  });

  it('does not affect trailing spaces', () => {
    expect(applyMiddleDots('hello  ', true)).toBe('hello  ');
  });

  it('converts tabs to 2 dots (note: slices by dot count, not char count)', () => {
    // Tab counts as 2 in leadingSpaces, so slice(2) on '\thello' = 'ello'
    expect(applyMiddleDots('\thello', true)).toBe('\u00b7\u00b7ello');
  });

  it('handles mixed leading whitespace', () => {
    // '  \t' = 2 spaces + 1 tab = 4 leadingSpaces, slice(4) skips 3 chars + 1 extra
    expect(applyMiddleDots('  \thello', true)).toBe('\u00b7\u00b7\u00b7\u00b7ello');
  });

  it('does not change content without leading spaces', () => {
    expect(applyMiddleDots('hello', true)).toBe('hello');
  });
});
