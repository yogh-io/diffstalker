import { describe, expect, test } from 'bun:test';
import {
  clampMove,
  createFinderIndex,
  cycleMove,
  toSegments,
  type Segment,
} from './finderModel.js';

const PATHS = [
  'packages/web/src/components/FinderOverlay.vue',
  'packages/cli/src/ui/modals/FileFinder.ts',
  'packages/core/src/view/finderModel.ts',
  'README.md',
];

describe('createFinderIndex', () => {
  test('empty query returns the first `limit` items in input order', () => {
    const index = createFinderIndex(PATHS, 2);
    expect(index.find('').map((m) => m.text)).toEqual([PATHS[0], PATHS[1]]);
  });

  test('empty query reports no matched positions', () => {
    const index = createFinderIndex(PATHS, 4);
    expect([...index.find('')[0].positions]).toEqual([]);
  });

  test('caps results at `limit`', () => {
    const index = createFinderIndex(PATHS, 2);
    expect(index.find('packages').length).toBeLessThanOrEqual(2);
  });

  test('reports the EXACT matched positions, not merely in-range ones', () => {
    // Pinned exactly: an in-range assertion passes with any off-by-one,
    // and an off-by-one in these offsets is what the CLI's truncation
    // rewrite existed to fix.
    const index = createFinderIndex(['README.md'], 10);
    const [match] = index.find('rme');
    expect(match.text).toBe('README.md');
    // R(0) M(4) E(5) in 'README.md' — verified against fzf, not assumed.
    expect([...match.positions].sort((a, b) => a - b)).toEqual([0, 4, 5]);
  });

  test('positions land on the queried characters', () => {
    const index = createFinderIndex(['packages/core/src/view/finderModel.ts'], 10);
    const [match] = index.find('finder');
    const picked = [...match.positions]
      .sort((a, b) => a - b)
      .map((i) => match.text[i])
      .join('');
    expect(picked.toLowerCase()).toBe('finder');
  });

  test('smart-case: a lowercase query is case-insensitive', () => {
    const index = createFinderIndex(['README.md'], 10);
    expect(index.find('readme').length).toBe(1);
  });

  test('smart-case: an uppercase query is case-sensitive', () => {
    const index = createFinderIndex(['readme.md'], 10);
    expect(index.find('README').length).toBe(0);
  });

  test('no match returns an empty list, not a throw', () => {
    const index = createFinderIndex(PATHS, 10);
    expect(index.find('zzzzzzzz')).toEqual([]);
  });

  test('an empty item list is safe for both query shapes', () => {
    const index = createFinderIndex([], 10);
    expect(index.find('')).toEqual([]);
    expect(index.find('anything')).toEqual([]);
  });
});

describe('toSegments', () => {
  const texts = (segments: Segment[]): string => segments.map((s) => s.text).join('');

  test('coalesces adjacent matched characters into one run', () => {
    expect(toSegments('abcd', new Set([1, 2]))).toEqual([
      { text: 'a', hit: false },
      { text: 'bc', hit: true },
      { text: 'd', hit: false },
    ]);
  });

  test('keeps non-adjacent matches as separate runs', () => {
    expect(toSegments('abcd', new Set([0, 2]))).toEqual([
      { text: 'a', hit: true },
      { text: 'b', hit: false },
      { text: 'c', hit: true },
      { text: 'd', hit: false },
    ]);
  });

  test('no positions yields one unmatched run', () => {
    expect(toSegments('abc', new Set())).toEqual([{ text: 'abc', hit: false }]);
  });

  test('every position matched yields one matched run', () => {
    expect(toSegments('abc', new Set([0, 1, 2]))).toEqual([{ text: 'abc', hit: true }]);
  });

  test('an empty string yields no segments', () => {
    expect(toSegments('', new Set([0]))).toEqual([]);
  });

  test('segments always reassemble into the input text', () => {
    expect(texts(toSegments('abcdef', new Set([1, 4])))).toBe('abcdef');
  });

  test('sliceFrom shifts positions onto a truncated tail', () => {
    // 'abcdef' truncated to its last three chars: position 4 ('e') is index 1.
    expect(toSegments('def', new Set([4]), 3)).toEqual([
      { text: 'd', hit: false },
      { text: 'e', hit: true },
      { text: 'f', hit: false },
    ]);
  });

  test('sliceFrom drops positions that fall before the tail', () => {
    expect(toSegments('def', new Set([0, 1]), 3)).toEqual([{ text: 'def', hit: false }]);
  });

  test('position order does not affect the result', () => {
    const forward = toSegments('abcdef', new Set([1, 2, 4]));
    const shuffled = toSegments('abcdef', new Set([4, 2, 1]));
    expect(shuffled).toEqual(forward);
  });
});

describe('clampMove', () => {
  test('moves within bounds', () => {
    expect(clampMove(1, 1, 5)).toBe(2);
    expect(clampMove(3, -2, 5)).toBe(1);
  });

  test('stops at the end', () => {
    expect(clampMove(4, 1, 5)).toBe(4);
  });

  test('stops at the start', () => {
    expect(clampMove(0, -1, 5)).toBe(0);
  });

  test('an empty list stays at 0', () => {
    expect(clampMove(0, 1, 0)).toBe(0);
    expect(clampMove(3, -1, 0)).toBe(0);
  });
});

describe('cycleMove', () => {
  test('wraps past the end to the start', () => {
    expect(cycleMove(4, 1, 5)).toBe(0);
  });

  test('wraps before the start to the end', () => {
    expect(cycleMove(0, -1, 5)).toBe(4);
  });

  test('moves within bounds like clampMove', () => {
    expect(cycleMove(1, 1, 5)).toBe(2);
  });

  test('an empty list stays at 0', () => {
    expect(cycleMove(0, 1, 0)).toBe(0);
    expect(cycleMove(0, -1, 0)).toBe(0);
  });

  test('a delta larger than the list still lands in range', () => {
    expect(cycleMove(0, 7, 5)).toBe(2);
    expect(cycleMove(0, -7, 5)).toBe(3);
  });
});
