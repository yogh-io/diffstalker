/**
 * buildDiffModel tests: DiffLine fixtures drive the web row builder,
 * mirroring the CLI's displayRows tests — multi-file grouping,
 * whole-diff hunk ordinals, del/add run pairing (similar pairs get
 * word-diff segments, dissimilar pairs do not), binary detection, and
 * row count / gutter width aggregation.
 */

import { describe, test, expect } from 'vitest';
import { buildDiffModel } from './diffRows';
import type { DiffResult, DiffLine } from '@diffstalker/core/git/diff';

/** Helper to build a DiffResult from lines */
function makeDiff(lines: DiffLine[]): DiffResult {
  return { raw: lines.map((l) => l.content).join('\n'), lines };
}

describe('buildDiffModel', () => {
  test('returns an empty model for null diff', () => {
    const model = buildDiffModel(null);
    expect(model.sections).toEqual([]);
    expect(model.rowCount).toBe(0);
    expect(model.isBinary).toBe(false);
    expect(model.lineNumWidth).toBe(3);
    expect(model.latestEditedAt).toBeUndefined();
  });

  test('returns an empty model for empty diff', () => {
    const model = buildDiffModel({ raw: '', lines: [] });
    expect(model.sections).toEqual([]);
    expect(model.rowCount).toBe(0);
  });

  test('groups multiple files into sections with their paths', () => {
    const model = buildDiffModel(
      makeDiff([
        { type: 'header', content: 'diff --git a/a.txt b/a.txt' },
        { type: 'hunk', content: '@@ -1,1 +1,1 @@' },
        { type: 'context', content: ' line', oldLineNum: 1, newLineNum: 1 },
        { type: 'header', content: 'diff --git a/b.txt b/b.txt' },
        { type: 'hunk', content: '@@ -1,1 +1,1 @@' },
        { type: 'context', content: ' line', oldLineNum: 1, newLineNum: 1 },
      ])
    );
    expect(model.sections).toHaveLength(2);
    expect(model.sections[0].filePath).toBe('a.txt');
    expect(model.sections[1].filePath).toBe('b.txt');
  });

  test('filters non-displayable headers, keeps informational ones as notes', () => {
    const model = buildDiffModel(
      makeDiff([
        { type: 'header', content: 'diff --git a/f.txt b/f.txt' },
        { type: 'header', content: 'index abc..def 100644' },
        { type: 'header', content: 'new file mode 100644' },
        { type: 'header', content: '--- a/f.txt' },
        { type: 'header', content: '+++ b/f.txt' },
        { type: 'hunk', content: '@@ -0,0 +1,1 @@' },
        { type: 'addition', content: '+hello', newLineNum: 1 },
      ])
    );
    expect(model.sections).toHaveLength(1);
    expect(model.sections[0].notes).toEqual(['new file mode 100644']);
  });

  test('numbers hunks with whole-diff ordinals across file sections', () => {
    const model = buildDiffModel(
      makeDiff([
        { type: 'header', content: 'diff --git a/a.txt b/a.txt' },
        { type: 'hunk', content: '@@ -1,1 +1,1 @@' },
        { type: 'context', content: ' one', oldLineNum: 1, newLineNum: 1 },
        { type: 'hunk', content: '@@ -10,1 +10,1 @@' },
        { type: 'context', content: ' two', oldLineNum: 10, newLineNum: 10 },
        { type: 'header', content: 'diff --git a/b.txt b/b.txt' },
        { type: 'hunk', content: '@@ -1,1 +1,1 @@' },
        { type: 'context', content: ' three', oldLineNum: 1, newLineNum: 1 },
      ])
    );
    expect(model.sections[0].hunks.map((h) => h.index)).toEqual([0, 1]);
    expect(model.sections[1].hunks.map((h) => h.index)).toEqual([2]);
  });

  test('parses @@ headers into ranges and context', () => {
    const model = buildDiffModel(
      makeDiff([
        { type: 'header', content: 'diff --git a/f.txt b/f.txt' },
        { type: 'hunk', content: '@@ -10,5 +20,8 @@ function foo()' },
        { type: 'context', content: ' x', oldLineNum: 10, newLineNum: 20 },
      ])
    );
    const hunk = model.sections[0].hunks[0];
    expect(hunk.oldRange).toBe('10-14');
    expect(hunk.newRange).toBe('20-27');
    expect(hunk.context).toBe('function foo()');
    expect(hunk.raw).toBe('@@ -10,5 +20,8 @@ function foo()');
  });

  test('strips leading +/- from row content', () => {
    const model = buildDiffModel(
      makeDiff([
        { type: 'header', content: 'diff --git a/f.txt b/f.txt' },
        { type: 'hunk', content: '@@ -1,1 +1,1 @@' },
        { type: 'deletion', content: '-deleted line', oldLineNum: 1 },
        { type: 'addition', content: '+added line', newLineNum: 1 },
      ])
    );
    const rows = model.sections[0].hunks[0].rows;
    expect(rows[0].kind).toBe('del');
    expect(rows[0].content).toBe('deleted line');
    expect(rows[1].kind).toBe('add');
    expect(rows[1].content).toBe('added line');
  });

  test('a similar del/add pair gets word-diff segments on both rows', () => {
    const model = buildDiffModel(
      makeDiff([
        { type: 'header', content: 'diff --git a/f.txt b/f.txt' },
        { type: 'hunk', content: '@@ -1,1 +1,1 @@' },
        { type: 'deletion', content: '-const x = 1;', oldLineNum: 1 },
        { type: 'addition', content: '+const x = 2;', newLineNum: 1 },
      ])
    );
    const rows = model.sections[0].hunks[0].rows;
    expect(rows[0].segments).toBeDefined();
    expect(rows[1].segments).toBeDefined();
  });

  test('a dissimilar del/add pair gets no segments', () => {
    const model = buildDiffModel(
      makeDiff([
        { type: 'header', content: 'diff --git a/f.txt b/f.txt' },
        { type: 'hunk', content: '@@ -1,1 +1,1 @@' },
        { type: 'deletion', content: '-aaaa', oldLineNum: 1 },
        { type: 'addition', content: '+zzzz', newLineNum: 1 },
      ])
    );
    const rows = model.sections[0].hunks[0].rows;
    expect(rows[0].segments).toBeUndefined();
    expect(rows[1].segments).toBeUndefined();
  });

  test('detects binary diffs and records the header as a note', () => {
    const model = buildDiffModel(
      makeDiff([
        { type: 'header', content: 'diff --git a/img.png b/img.png' },
        { type: 'header', content: 'Binary files a/img.png and b/img.png differ' },
      ])
    );
    expect(model.isBinary).toBe(true);
    expect(model.sections[0].notes).toEqual(['Binary files a/img.png and b/img.png differ']);
    expect(model.rowCount).toBe(0);
  });

  test('aggregates rowCount across all hunks and sections', () => {
    const model = buildDiffModel(
      makeDiff([
        { type: 'header', content: 'diff --git a/a.txt b/a.txt' },
        { type: 'hunk', content: '@@ -1,2 +1,2 @@' },
        { type: 'context', content: ' one', oldLineNum: 1, newLineNum: 1 },
        { type: 'deletion', content: '-old', oldLineNum: 2 },
        { type: 'addition', content: '+new', newLineNum: 2 },
        { type: 'header', content: 'diff --git a/b.txt b/b.txt' },
        { type: 'hunk', content: '@@ -1,1 +1,1 @@' },
        { type: 'context', content: ' two', oldLineNum: 1, newLineNum: 1 },
      ])
    );
    // 3 rows in the first hunk + 1 in the second
    expect(model.rowCount).toBe(4);
  });

  test('widens lineNumWidth for large line numbers', () => {
    const model = buildDiffModel(
      makeDiff([
        { type: 'header', content: 'diff --git a/f.txt b/f.txt' },
        { type: 'hunk', content: '@@ -1000,1 +1000,1 @@' },
        { type: 'context', content: ' x', oldLineNum: 1000, newLineNum: 1000 },
      ])
    );
    expect(model.lineNumWidth).toBe(4);
  });
});
