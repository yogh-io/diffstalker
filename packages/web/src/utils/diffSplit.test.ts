/**
 * diffSplit tests: the side-by-side projection and its row count — the
 * single source of truth shared by DiffView and DiffStack. Covers
 * context-on-both-sides, balanced and unbalanced del/add runs (short
 * side padded), pairing order (deletion j opposite addition j), and
 * memoization by rows-array identity.
 */

import { describe, test, expect } from 'vitest';
import { toSplitRows, splitRows, splitRowCount } from './diffSplit';
import type { DiffContentRow } from './diffRows';

function ctx(text: string, oldNum: number, newNum: number): DiffContentRow {
  return { key: `c${oldNum}`, kind: 'context', oldLineNum: oldNum, newLineNum: newNum, content: text };
}
function del(text: string, oldNum: number): DiffContentRow {
  return { key: `d${oldNum}`, kind: 'del', oldLineNum: oldNum, content: text };
}
function add(text: string, newNum: number): DiffContentRow {
  return { key: `a${newNum}`, kind: 'add', newLineNum: newNum, content: text };
}

describe('toSplitRows', () => {
  test('a context line occupies both sides (same row object)', () => {
    const rows = [ctx('keep', 1, 1)];
    const split = toSplitRows(rows);
    expect(split).toHaveLength(1);
    expect(split[0].left).toBe(rows[0]);
    expect(split[0].right).toBe(rows[0]);
  });

  test('a balanced del/add run pairs position-for-position on one row each', () => {
    const rows = [del('old a', 1), del('old b', 2), add('new a', 1), add('new b', 2)];
    const split = toSplitRows(rows);
    expect(split).toHaveLength(2);
    expect(split[0].left?.content).toBe('old a');
    expect(split[0].right?.content).toBe('new a');
    expect(split[1].left?.content).toBe('old b');
    expect(split[1].right?.content).toBe('new b');
  });

  test('more deletions than additions pads the right side', () => {
    const rows = [del('old a', 1), del('old b', 2), del('old c', 3), add('new a', 1)];
    const split = toSplitRows(rows);
    expect(split).toHaveLength(3);
    expect(split[0].right?.content).toBe('new a');
    expect(split[1].right).toBeNull();
    expect(split[2].right).toBeNull();
    expect(split.map((r) => r.left?.content)).toEqual(['old a', 'old b', 'old c']);
  });

  test('more additions than deletions pads the left side', () => {
    const rows = [del('old a', 1), add('new a', 1), add('new b', 2), add('new c', 3)];
    const split = toSplitRows(rows);
    expect(split).toHaveLength(3);
    expect(split[0].left?.content).toBe('old a');
    expect(split[1].left).toBeNull();
    expect(split[2].left).toBeNull();
    expect(split.map((r) => r.right?.content)).toEqual(['new a', 'new b', 'new c']);
  });

  test('a pure-addition run (created lines) is all right side', () => {
    const rows = [add('new a', 1), add('new b', 2)];
    const split = toSplitRows(rows);
    expect(split).toHaveLength(2);
    expect(split.every((r) => r.left === null)).toBe(true);
  });

  test('interleaved context and change runs keep order', () => {
    const rows = [ctx('h', 1, 1), del('x', 2), add('y', 2), ctx('t', 3, 3)];
    const split = toSplitRows(rows);
    expect(split).toHaveLength(3);
    expect(split[0].left?.content).toBe('h');
    expect(split[1].left?.content).toBe('x');
    expect(split[1].right?.content).toBe('y');
    expect(split[2].right?.content).toBe('t');
  });

  test('keys are unique per row (padding side uses a placeholder)', () => {
    const rows = [del('old a', 1), del('old b', 2), add('new a', 1)];
    const keys = toSplitRows(rows).map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('splitRows (memoized) and splitRowCount', () => {
  test('splitRowCount matches the projection length', () => {
    const rows = [del('a', 1), del('b', 2), del('c', 3), add('a', 1)];
    expect(splitRowCount(rows)).toBe(3);
    expect(splitRowCount(rows)).toBe(toSplitRows(rows).length);
  });

  test('splitRows returns the same reference for the same rows array', () => {
    const rows = [del('a', 1), add('a', 1)];
    expect(splitRows(rows)).toBe(splitRows(rows));
  });
});
