import { describe, it, expect } from 'vitest';
import {
  parseHunkHeader,
  extractDiffFilePath,
  getLineNumColumnWidth,
  pairChangeRuns,
  WORD_DIFF_CHAR_CAP,
} from './diffPrimitives.js';
import { getLineContent } from './diffRowCalculations.js';
import type { DiffLine } from '../git/diff.js';

describe('parseHunkHeader', () => {
  it('parses full ranges and trailing context', () => {
    expect(parseHunkHeader('@@ -10,5 +12,6 @@ function foo()')).toEqual({
      oldStart: 10,
      oldCount: 5,
      newStart: 12,
      newCount: 6,
      context: 'function foo()',
    });
  });

  it('defaults omitted counts to 1', () => {
    expect(parseHunkHeader('@@ -3 +4 @@')).toEqual({
      oldStart: 3,
      oldCount: 1,
      newStart: 4,
      newCount: 1,
      context: '',
    });
  });

  it('returns null for a non-hunk line', () => {
    expect(parseHunkHeader('+added line')).toBeNull();
    expect(parseHunkHeader('@@ malformed @@')).toBeNull();
  });
});

describe('extractDiffFilePath', () => {
  it('pulls the b/ path from a git header', () => {
    expect(extractDiffFilePath('diff --git a/src/foo.ts b/src/foo.ts')).toBe('src/foo.ts');
  });

  it('handles paths containing spaces', () => {
    expect(extractDiffFilePath('diff --git a/my dir/f.ts b/my dir/f.ts')).toBe('my dir/f.ts');
  });

  it('returns null for a non-git-header line', () => {
    expect(extractDiffFilePath('@@ -1 +1 @@')).toBeNull();
    expect(extractDiffFilePath('+++ b/src/foo.ts')).toBeNull();
  });
});

describe('getLineNumColumnWidth', () => {
  it('is the digit count of the largest line number', () => {
    expect(getLineNumColumnWidth(12345)).toBe(5);
  });

  it('has a floor of 3', () => {
    expect(getLineNumColumnWidth(7)).toBe(3);
    expect(getLineNumColumnWidth(0)).toBe(3);
  });
});

describe('pairChangeRuns', () => {
  const del = (content: string): DiffLine => ({ type: 'deletion', content });
  const add = (content: string): DiffLine => ({ type: 'addition', content });

  it('gives word-level segments to similar del/add pairs', () => {
    const { delSegments, addSegments } = pairChangeRuns(
      [del('-const x = 1;')],
      [add('+const x = 2;')],
      getLineContent
    );
    expect(delSegments.has(0)).toBe(true);
    expect(addSegments.has(0)).toBe(true);
    // the differing token is marked changed; shared text is not
    expect(addSegments.get(0)!.some((s) => s.type === 'changed')).toBe(true);
  });

  it('leaves dissimilar pairs without segments', () => {
    const { delSegments, addSegments } = pairChangeRuns(
      [del('-completely different old text')],
      [add('+nothing alike here whatsoever')],
      getLineContent
    );
    expect(delSegments.size).toBe(0);
    expect(addSegments.size).toBe(0);
  });

  it('pairs only up to the shorter run length', () => {
    const { delSegments, addSegments } = pairChangeRuns(
      [del('-a = 1'), del('-b = 1')],
      [add('+a = 2')],
      getLineContent
    );
    // index 1 has no counterpart in the shorter additions run
    expect(delSegments.has(1)).toBe(false);
    expect(addSegments.has(1)).toBe(false);
  });

  it('skips word-diffing when either side exceeds the char cap', () => {
    // A minified-asset-sized single line: nearly identical on both sides,
    // so the similarity gate alone would have let fast-diff run.
    const huge = 'var a=1;'.repeat(9000); // 72KB
    const start = performance.now();
    const { delSegments, addSegments } = pairChangeRuns(
      [del('-' + huge + 'x')],
      [add('+' + huge + 'y')],
      getLineContent
    );
    const elapsed = performance.now() - start;

    // No per-token segments: the pair stays a whole-line change.
    expect(delSegments.size).toBe(0);
    expect(addSegments.size).toBe(0);
    // Uncapped, this pair took seconds (~quadratic). Capped it is instant;
    // the generous bound keeps the test stable on slow CI.
    expect(elapsed).toBeLessThan(500);
  });

  it('skips when only one side exceeds the cap', () => {
    const huge = 'x'.repeat(WORD_DIFF_CHAR_CAP + 1);
    const { delSegments, addSegments } = pairChangeRuns(
      [del('-' + huge)],
      [add('+short')],
      getLineContent
    );
    expect(delSegments.size).toBe(0);
    expect(addSegments.size).toBe(0);
  });

  it('still word-diffs lines at exactly the cap', () => {
    const base = 'a'.repeat(WORD_DIFF_CHAR_CAP - 1);
    const { delSegments, addSegments } = pairChangeRuns(
      [del('-' + base + 'b')],
      [add('+' + base + 'c')],
      getLineContent
    );
    expect(delSegments.has(0)).toBe(true);
    expect(addSegments.has(0)).toBe(true);
    expect(addSegments.get(0)!.some((s) => s.type === 'changed')).toBe(true);
  });

  it('leaves empty-content pairs without segments', () => {
    const { delSegments, addSegments } = pairChangeRuns(
      [del('-')],
      [add('+something')],
      getLineContent
    );
    expect(delSegments.size).toBe(0);
    expect(addSegments.size).toBe(0);
  });
});
