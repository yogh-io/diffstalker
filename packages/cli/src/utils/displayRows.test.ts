import { describe, it, expect } from 'vitest';
import {
  buildDiffDisplayRows,
  getDisplayRowsLineNumWidth,
  wrapDisplayRows,
  getWrappedRowCount,
} from './displayRows.js';
import type { DiffResult, DiffLine } from '../git/diff.js';

/** Helper to build a DiffResult from lines */
function makeDiff(lines: DiffLine[]): DiffResult {
  return { raw: lines.map((l) => l.content).join('\n'), lines };
}

describe('buildDiffDisplayRows', () => {
  it('returns empty array for null diff', () => {
    expect(buildDiffDisplayRows(null)).toEqual([]);
  });

  it('returns empty array for empty diff', () => {
    expect(buildDiffDisplayRows({ raw: '', lines: [] })).toEqual([]);
  });

  it('filters non-displayable headers', () => {
    const diff = makeDiff([
      { type: 'header', content: 'diff --git a/f.txt b/f.txt' },
      { type: 'header', content: 'index abc..def 100644' },
      { type: 'header', content: '--- a/f.txt' },
      { type: 'header', content: '+++ b/f.txt' },
      { type: 'hunk', content: '@@ -1,2 +1,2 @@' },
      { type: 'context', content: ' line1', oldLineNum: 1, newLineNum: 1 },
    ]);
    const rows = buildDiffDisplayRows(diff);
    // Only diff --git header and hunk should remain (index/---/+++ filtered)
    expect(rows.filter((r) => r.type === 'diff-header').length).toBe(1);
    expect(rows.some((r) => r.type === 'diff-header' && r.content.startsWith('diff --git'))).toBe(
      true
    );
  });

  it('converts additions and deletions', () => {
    const diff = makeDiff([
      { type: 'header', content: 'diff --git a/f.txt b/f.txt' },
      { type: 'hunk', content: '@@ -1,2 +1,2 @@' },
      { type: 'deletion', content: '-old', oldLineNum: 1 },
      { type: 'addition', content: '+new', newLineNum: 1 },
    ]);
    const rows = buildDiffDisplayRows(diff);
    expect(rows.some((r) => r.type === 'diff-del')).toBe(true);
    expect(rows.some((r) => r.type === 'diff-add')).toBe(true);
  });

  it('strips leading +/- from content', () => {
    const diff = makeDiff([
      { type: 'header', content: 'diff --git a/f.txt b/f.txt' },
      { type: 'hunk', content: '@@ -1,1 +1,1 @@' },
      { type: 'addition', content: '+added line', newLineNum: 1 },
      { type: 'deletion', content: '-deleted line', oldLineNum: 1 },
    ]);
    const rows = buildDiffDisplayRows(diff);
    const addRow = rows.find((r) => r.type === 'diff-add');
    const delRow = rows.find((r) => r.type === 'diff-del');
    expect(addRow && 'content' in addRow && addRow.content).toBe('added line');
    expect(delRow && 'content' in delRow && delRow.content).toBe('deleted line');
  });

  it('computes word-level diffs for similar consecutive del/add pairs', () => {
    const diff = makeDiff([
      { type: 'header', content: 'diff --git a/f.txt b/f.txt' },
      { type: 'hunk', content: '@@ -1,1 +1,1 @@' },
      { type: 'deletion', content: '-const x = 1;', oldLineNum: 1 },
      { type: 'addition', content: '+const x = 2;', newLineNum: 1 },
    ]);
    const rows = buildDiffDisplayRows(diff);
    const delRow = rows.find((r) => r.type === 'diff-del');
    const addRow = rows.find((r) => r.type === 'diff-add');
    // Should have wordDiffSegments since lines are similar
    expect(delRow && 'wordDiffSegments' in delRow && delRow.wordDiffSegments).toBeDefined();
    expect(addRow && 'wordDiffSegments' in addRow && addRow.wordDiffSegments).toBeDefined();
  });

  it('adds spacer between file sections', () => {
    const diff = makeDiff([
      { type: 'header', content: 'diff --git a/a.txt b/a.txt' },
      { type: 'hunk', content: '@@ -1,1 +1,1 @@' },
      { type: 'context', content: ' line', oldLineNum: 1, newLineNum: 1 },
      { type: 'header', content: 'diff --git a/b.txt b/b.txt' },
      { type: 'hunk', content: '@@ -1,1 +1,1 @@' },
      { type: 'context', content: ' line', oldLineNum: 1, newLineNum: 1 },
    ]);
    const rows = buildDiffDisplayRows(diff);
    expect(rows.some((r) => r.type === 'spacer')).toBe(true);
  });
});

describe('getDisplayRowsLineNumWidth', () => {
  it('returns minimum of 3', () => {
    const rows = buildDiffDisplayRows(
      makeDiff([
        { type: 'header', content: 'diff --git a/f.txt b/f.txt' },
        { type: 'hunk', content: '@@ -1,1 +1,1 @@' },
        { type: 'context', content: ' x', oldLineNum: 1, newLineNum: 1 },
      ])
    );
    expect(getDisplayRowsLineNumWidth(rows)).toBe(3);
  });

  it('returns wider for large line numbers', () => {
    const rows = buildDiffDisplayRows(
      makeDiff([
        { type: 'header', content: 'diff --git a/f.txt b/f.txt' },
        { type: 'hunk', content: '@@ -1000,1 +1000,1 @@' },
        { type: 'context', content: ' x', oldLineNum: 1000, newLineNum: 1000 },
      ])
    );
    expect(getDisplayRowsLineNumWidth(rows)).toBe(4);
  });

  it('handles rows without line numbers', () => {
    const rows = buildDiffDisplayRows(
      makeDiff([
        { type: 'header', content: 'diff --git a/f.txt b/f.txt' },
        { type: 'hunk', content: '@@ -1,1 +1,1 @@' },
      ])
    );
    expect(getDisplayRowsLineNumWidth(rows)).toBe(3);
  });
});

describe('wrapDisplayRows', () => {
  it('returns rows unchanged when wrapping disabled', () => {
    const diff = makeDiff([
      { type: 'header', content: 'diff --git a/f.txt b/f.txt' },
      { type: 'hunk', content: '@@ -1,1 +1,1 @@' },
      { type: 'context', content: ' short', oldLineNum: 1, newLineNum: 1 },
    ]);
    const rows = buildDiffDisplayRows(diff);
    expect(wrapDisplayRows(rows, 20, false)).toEqual(rows);
  });

  it('wraps long content lines', () => {
    const longContent = ' ' + 'x'.repeat(50);
    const diff = makeDiff([
      { type: 'header', content: 'diff --git a/f.txt b/f.txt' },
      { type: 'hunk', content: '@@ -1,1 +1,1 @@' },
      { type: 'context', content: longContent, oldLineNum: 1, newLineNum: 1 },
    ]);
    const rows = buildDiffDisplayRows(diff);
    const wrapped = wrapDisplayRows(rows, 20, true);
    // Header + hunk + wrapped context segments
    expect(wrapped.length).toBeGreaterThan(rows.length);
  });

  it('does not wrap headers or hunks', () => {
    const longHeader = 'diff --git a/' + 'x'.repeat(100) + ' b/' + 'x'.repeat(100);
    const diff = makeDiff([{ type: 'header', content: longHeader }]);
    const rows = buildDiffDisplayRows(diff);
    const wrapped = wrapDisplayRows(rows, 20, true);
    expect(wrapped.length).toBe(rows.length);
  });

  it('marks continuation rows', () => {
    const diff = makeDiff([
      { type: 'header', content: 'diff --git a/f.txt b/f.txt' },
      { type: 'hunk', content: '@@ -1,1 +1,1 @@' },
      { type: 'addition', content: '+' + 'x'.repeat(50), newLineNum: 1 },
    ]);
    const rows = buildDiffDisplayRows(diff);
    const wrapped = wrapDisplayRows(rows, 20, true);
    const addRows = wrapped.filter((r) => r.type === 'diff-add');
    expect(addRows.length).toBeGreaterThan(1);
    expect(addRows[0].isContinuation).toBeFalsy();
    expect(addRows[1].isContinuation).toBe(true);
  });
});

describe('getWrappedRowCount', () => {
  it('returns row count without wrapping', () => {
    const diff = makeDiff([
      { type: 'header', content: 'diff --git a/f.txt b/f.txt' },
      { type: 'hunk', content: '@@ -1,2 +1,2 @@' },
      { type: 'context', content: ' a', oldLineNum: 1, newLineNum: 1 },
      { type: 'context', content: ' b', oldLineNum: 2, newLineNum: 2 },
    ]);
    const rows = buildDiffDisplayRows(diff);
    expect(getWrappedRowCount(rows, 20, false)).toBe(rows.length);
  });

  it('matches wrapDisplayRows length', () => {
    const diff = makeDiff([
      { type: 'header', content: 'diff --git a/f.txt b/f.txt' },
      { type: 'hunk', content: '@@ -1,2 +1,2 @@' },
      { type: 'context', content: ' short', oldLineNum: 1, newLineNum: 1 },
      { type: 'addition', content: '+' + 'x'.repeat(50), newLineNum: 2 },
    ]);
    const rows = buildDiffDisplayRows(diff);
    const wrapped = wrapDisplayRows(rows, 20, true);
    const count = getWrappedRowCount(rows, 20, true);
    expect(count).toBe(wrapped.length);
  });
});
