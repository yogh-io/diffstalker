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
/** git's "\ No newline at end of file" — no line number on either side. */
function marker(key: string): DiffContentRow {
  return { key, kind: 'no-newline', content: '\\ No newline at end of file' };
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

  describe('"\\ No newline at end of file"', () => {
    test('a marker between the runs keeps the pair on one row, then annotates both sides', () => {
      // The shape git emits when a file with no trailing newline has its
      // last line edited: marker, additions, marker.
      const rows = [del('two', 2), marker('m1'), add('TWO', 2), marker('m2')];
      const split = toSplitRows(rows);
      expect(split).toHaveLength(2);
      // Was two rows (left-only, then right-only) — the pair lost its
      // alignment because the marker ended the run.
      expect(split[0].left?.content).toBe('two');
      expect(split[0].right?.content).toBe('TWO');
      expect(split[1].left?.key).toBe('m1');
      expect(split[1].right?.key).toBe('m2');
    });

    test('only the old side lost its newline: the marker is left-only', () => {
      const split = toSplitRows([del('two', 2), marker('m1'), add('TWO', 2)]);
      expect(split).toHaveLength(2);
      expect(split[1].left?.key).toBe('m1');
      expect(split[1].right).toBeNull();
    });

    test('only the new side lost its newline: the marker is right-only', () => {
      const split = toSplitRows([del('two', 2), add('TWO', 2), marker('m2')]);
      expect(split).toHaveLength(2);
      expect(split[1].left).toBeNull();
      expect(split[1].right?.key).toBe('m2');
    });

    test('a marker after a context line belongs to both sides', () => {
      const split = toSplitRows([ctx('last', 3, 3), marker('m')]);
      expect(split).toHaveLength(2);
      expect(split[1].left?.key).toBe('m');
      expect(split[1].right?.key).toBe('m');
    });

    test('markers keep the split row keys unique', () => {
      const keys = toSplitRows([del('two', 2), marker('m1'), add('TWO', 2), marker('m2')]).map(
        (r) => r.key
      );
      expect(new Set(keys).size).toBe(keys.length);
    });
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
