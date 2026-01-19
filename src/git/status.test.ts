import { describe, it, expect } from 'vitest';
import { parseStatusCode, parseNumstat } from './status.js';

describe('parseStatusCode', () => {
  it('parses M as modified', () => {
    expect(parseStatusCode('M')).toBe('modified');
  });

  it('parses A as added', () => {
    expect(parseStatusCode('A')).toBe('added');
  });

  it('parses D as deleted', () => {
    expect(parseStatusCode('D')).toBe('deleted');
  });

  it('parses ? as untracked', () => {
    expect(parseStatusCode('?')).toBe('untracked');
  });

  it('parses R as renamed', () => {
    expect(parseStatusCode('R')).toBe('renamed');
  });

  it('parses C as copied', () => {
    expect(parseStatusCode('C')).toBe('copied');
  });

  it('returns modified for unknown codes', () => {
    expect(parseStatusCode('U')).toBe('modified');
    expect(parseStatusCode('X')).toBe('modified');
    expect(parseStatusCode('')).toBe('modified');
  });
});

describe('parseNumstat', () => {
  it('parses single file numstat', () => {
    const result = parseNumstat('10\t5\tfile.ts');
    expect(result.get('file.ts')).toEqual({ insertions: 10, deletions: 5 });
  });

  it('parses multiple files', () => {
    const output = `10\t5\tfile1.ts
20\t3\tfile2.ts
1\t0\tfile3.ts`;
    const result = parseNumstat(output);

    expect(result.size).toBe(3);
    expect(result.get('file1.ts')).toEqual({ insertions: 10, deletions: 5 });
    expect(result.get('file2.ts')).toEqual({ insertions: 20, deletions: 3 });
    expect(result.get('file3.ts')).toEqual({ insertions: 1, deletions: 0 });
  });

  it('handles binary files (marked with -)', () => {
    const result = parseNumstat('-\t-\timage.png');
    expect(result.get('image.png')).toEqual({ insertions: 0, deletions: 0 });
  });

  it('handles empty output', () => {
    const result = parseNumstat('');
    expect(result.size).toBe(0);
  });

  it('handles output with only whitespace', () => {
    const result = parseNumstat('  \n  \n  ');
    expect(result.size).toBe(0);
  });

  it('handles paths with tabs', () => {
    const result = parseNumstat('5\t3\tpath\twith\ttabs.ts');
    expect(result.get('path\twith\ttabs.ts')).toEqual({ insertions: 5, deletions: 3 });
  });

  it('handles zero insertions and deletions', () => {
    const result = parseNumstat('0\t0\tfile.ts');
    expect(result.get('file.ts')).toEqual({ insertions: 0, deletions: 0 });
  });

  it('handles large numbers', () => {
    const result = parseNumstat('1000\t500\tlarge.ts');
    expect(result.get('large.ts')).toEqual({ insertions: 1000, deletions: 500 });
  });

  it('skips malformed lines', () => {
    const output = `10\t5\tvalid.ts
malformed line
20\t3\talso-valid.ts`;
    const result = parseNumstat(output);

    expect(result.size).toBe(2);
    expect(result.has('valid.ts')).toBe(true);
    expect(result.has('also-valid.ts')).toBe(true);
  });
});
