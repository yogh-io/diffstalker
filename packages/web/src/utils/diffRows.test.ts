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
  return { lines };
}

describe('buildDiffModel', () => {
  test('returns an empty model for null diff', () => {
    const model = buildDiffModel(null);
    expect(model.sections).toEqual([]);
    expect(model.rowCount).toBe(0);
    expect(model.notShown).toBe(null);
    expect(model.lineNumWidth).toBe(3);
    expect(model.latestEditedAt).toBeUndefined();
  });

  test('returns an empty model for empty diff', () => {
    const model = buildDiffModel({ lines: [] });
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

  describe('"\\ No newline at end of file"', () => {
    /**
     * Verbatim `git diff` shape for a file with no trailing newline
     * whose last line was edited: git puts a marker on each side of the
     * change run. The parser gives all three the same 'context' type,
     * with no line numbers on the markers.
     */
    const rewrittenLastLine = (): DiffLine[] => [
      { type: 'header', content: 'diff --git a/f.txt b/f.txt' },
      { type: 'hunk', content: '@@ -1,2 +1,2 @@' },
      { type: 'context', content: ' one', oldLineNum: 1, newLineNum: 1 },
      { type: 'deletion', content: '-const x = 1;', oldLineNum: 2 },
      { type: 'context', content: '\\ No newline at end of file' },
      { type: 'addition', content: '+const x = 2;', newLineNum: 2 },
      { type: 'context', content: '\\ No newline at end of file' },
    ];

    test('the marker gets its own kind and no line numbers', () => {
      const rows = buildDiffModel(makeDiff(rewrittenLastLine())).sections[0].hunks[0].rows;
      expect(rows.map((r) => r.kind)).toEqual([
        'context',
        'del',
        'no-newline',
        'add',
        'no-newline',
      ]);
      expect(rows[2].content).toBe('\\ No newline at end of file');
      expect(rows[2].oldLineNum).toBeUndefined();
      expect(rows[2].newLineNum).toBeUndefined();
    });

    test('a marker between the runs does not break the del/add pairing', () => {
      const rows = buildDiffModel(makeDiff(rewrittenLastLine())).sections[0].hunks[0].rows;
      // A similar pair, so both halves carry word-diff segments.
      // Ending the run at the marker left them unpaired.
      expect(rows[1].segments).toBeDefined();
      expect(rows[3].segments).toBeDefined();
    });

    test('a marker after a context line stands on its own', () => {
      const rows = buildDiffModel(
        makeDiff([
          { type: 'header', content: 'diff --git a/f.txt b/f.txt' },
          { type: 'hunk', content: '@@ -1,2 +1,2 @@' },
          { type: 'deletion', content: '-one', oldLineNum: 1 },
          { type: 'addition', content: '+ONE', newLineNum: 1 },
          { type: 'context', content: ' two', oldLineNum: 2, newLineNum: 2 },
          { type: 'context', content: '\\ No newline at end of file' },
        ])
      ).sections[0].hunks[0].rows;
      expect(rows.map((r) => r.kind)).toEqual(['del', 'add', 'context', 'no-newline']);
    });

    test('real content starting with a backslash stays a normal line', () => {
      // The test is on the RAW line, so a context line's leading space
      // still protects `\begin{document}` from reading as a marker.
      const rows = buildDiffModel(
        makeDiff([
          { type: 'header', content: 'diff --git a/p.tex b/p.tex' },
          { type: 'hunk', content: '@@ -1,2 +1,2 @@' },
          { type: 'context', content: ' \\begin{document}', oldLineNum: 1, newLineNum: 1 },
          { type: 'deletion', content: '-\\section{a}', oldLineNum: 2 },
          { type: 'addition', content: '+\\section{b}', newLineNum: 2 },
        ])
      ).sections[0].hunks[0].rows;
      expect(rows.map((r) => r.kind)).toEqual(['context', 'del', 'add']);
      expect(rows[0].content).toBe('\\begin{document}');
    });
  });

  test('detects binary diffs and records the header as a note', () => {
    const model = buildDiffModel(
      makeDiff([
        { type: 'header', content: 'diff --git a/img.png b/img.png' },
        { type: 'header', content: 'Binary files a/img.png and b/img.png differ' },
      ])
    );
    expect(model.notShown).toEqual({
      kind: 'binary',
      note: 'Binary file — no text diff to show.',
    });
    expect(model.sections[0].notes).toEqual(['Binary files a/img.png and b/img.png differ']);
    expect(model.rowCount).toBe(0);
  });

  test('detects an over-cap diff and shows the daemon notice verbatim', () => {
    const notice = 'Large file — diff not shown (18.3 MB, 121,285 lines)';
    const model = buildDiffModel(
      makeDiff([
        { type: 'header', content: 'diff --git a/big.gml b/big.gml' },
        { type: 'header', content: notice },
      ])
    );
    expect(model.notShown).toEqual({ kind: 'large', note: notice });
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

describe('content-stable keys', () => {
  const twoFileLines = (): DiffLine[] => [
    { type: 'header', content: 'diff --git a/a.txt b/a.txt' },
    { type: 'hunk', content: '@@ -1,2 +1,2 @@ function foo()' },
    { type: 'context', content: ' one', oldLineNum: 1, newLineNum: 1 },
    { type: 'deletion', content: '-old', oldLineNum: 2 },
    { type: 'addition', content: '+new', newLineNum: 2 },
    { type: 'header', content: 'diff --git a/b.txt b/b.txt' },
    { type: 'hunk', content: '@@ -10,1 +10,1 @@' },
    { type: 'context', content: ' ten', oldLineNum: 10, newLineNum: 10 },
  ];

  /** Every key in the model, in document order. */
  function collectKeys(lines: DiffLine[], staged = false): string[] {
    const keys: string[] = [];
    for (const section of buildDiffModel(makeDiff(lines), staged).sections) {
      keys.push(section.key);
      for (const hunk of section.hunks) {
        keys.push(hunk.key);
        for (const row of hunk.rows) keys.push(row.key);
      }
    }
    return keys;
  }

  test('same content built twice yields identical keys', () => {
    expect(collectKeys(twoFileLines())).toEqual(collectKeys(twoFileLines()));
  });

  test('section key is staged-prefix + path; row keys use old line or +new line', () => {
    const model = buildDiffModel(makeDiff(twoFileLines()));
    const section = model.sections[0];
    expect(section.key).toBe('u:a.txt');
    const hunk = section.hunks[0];
    const [ctx, del, add] = hunk.rows;
    expect(ctx.key).toBe(`${hunk.key}:1`);
    expect(del.key).toBe(`${hunk.key}:2`);
    expect(add.key).toBe(`${hunk.key}:+2`);
  });

  test('editing a hunk keeps the section and hunk keys; only affected rows change', () => {
    const before = buildDiffModel(makeDiff(twoFileLines()));
    // Edit: the addition's content changes and grows an extra added line.
    // Header context and oldStart are unchanged, so the hunk key holds.
    const edited = twoFileLines();
    edited[3] = { type: 'deletion', content: '-old', oldLineNum: 2 };
    edited[4] = { type: 'addition', content: '+newer', newLineNum: 2 };
    edited.splice(5, 0, { type: 'addition', content: '+extra', newLineNum: 3 });
    const after = buildDiffModel(makeDiff(edited));

    expect(after.sections[0].key).toBe(before.sections[0].key);
    expect(after.sections[0].hunks[0].key).toBe(before.sections[0].hunks[0].key);

    const beforeKeys = before.sections[0].hunks[0].rows.map((r) => r.key);
    const afterKeys = after.sections[0].hunks[0].rows.map((r) => r.key);
    // The pre-existing rows keep their keys; only the new row's key is new.
    expect(afterKeys.slice(0, 3)).toEqual(beforeKeys);
    expect(beforeKeys).not.toContain(afterKeys[3]);

    // The untouched second file is key-identical throughout.
    expect(after.sections[1].key).toBe(before.sections[1].key);
    expect(after.sections[1].hunks[0].key).toBe(before.sections[1].hunks[0].key);
    expect(after.sections[1].hunks[0].rows.map((r) => r.key)).toEqual(
      before.sections[1].hunks[0].rows.map((r) => r.key)
    );
  });

  test('two hunks in one file with identical header context get distinct, stable keys', () => {
    const lines = (): DiffLine[] => [
      { type: 'header', content: 'diff --git a/f.txt b/f.txt' },
      { type: 'hunk', content: '@@ -5,1 +5,1 @@ fn()' },
      { type: 'context', content: ' a', oldLineNum: 5, newLineNum: 5 },
      { type: 'hunk', content: '@@ -5,1 +9,1 @@ fn()' },
      { type: 'context', content: ' b', oldLineNum: 5, newLineNum: 9 },
    ];
    const model = buildDiffModel(makeDiff(lines()));
    const [first, second] = model.sections[0].hunks;
    expect(first.key).not.toBe(second.key);
    // Disambiguation is ordinal, so a rebuild reproduces both keys.
    const again = buildDiffModel(makeDiff(lines()));
    expect(again.sections[0].hunks.map((h) => h.key)).toEqual([first.key, second.key]);
  });

  test('staged and unstaged builds of the same path get different section keys', () => {
    const unstaged = buildDiffModel(makeDiff(twoFileLines()), false);
    const staged = buildDiffModel(makeDiff(twoFileLines()), true);
    expect(unstaged.sections[0].key).toBe('u:a.txt');
    expect(staged.sections[0].key).toBe('s:a.txt');
    expect(new Set(collectKeys(twoFileLines(), true)).size).toBe(
      collectKeys(twoFileLines(), true).length
    );
  });
});
