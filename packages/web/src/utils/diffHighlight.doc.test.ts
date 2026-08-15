/**
 * Document-level highlighting: the whole-file path, where each SIDE of the
 * diff is a complete file and can be tokenized in one pass.
 *
 * The defect it fixes: per-line highlighting loses state at every row
 * boundary, so a block comment renders as if it were code. Over a hunk
 * that is a blemish; over a whole file it is twenty visibly wrong lines.
 */

import { describe, test, expect } from 'vitest';
import { documentRuns, syntaxPieces } from './diffHighlight';
import type { DiffContentRow } from './diffRows';

function row(
  kind: DiffContentRow['kind'],
  content: string,
  i: number
): DiffContentRow {
  return { key: `k${i}`, kind, content };
}

/** A file whose comment block only reads as a comment in document context. */
const LINES = [
  '/**',
  ' * const notCode = 1;',
  ' * function alsoNotCode() {}',
  ' */',
  'const real = 1;',
];

function wholeFileRows(): DiffContentRow[] {
  return LINES.map((line, i) => row('context', line, i));
}

describe('documentRuns', () => {
  test('a block comment stays a comment on every one of its lines', () => {
    const rows = wholeFileRows();
    const docs = documentRuns(rows, 'typescript');
    expect(docs).not.toBeNull();

    // The interior lines are the point: on their own hljs sees
    // `* const notCode = 1;` as code and colours the keyword.
    for (const r of rows.slice(0, 4)) {
      const pieces = syntaxPieces(r, 'typescript', true, docs);
      expect(pieces).not.toBeNull();
      expect(pieces!.every((p) => p.cls.includes('comment'))).toBe(true);
    }
  });

  test('per-line highlighting gets those same lines wrong', () => {
    // The contrast that justifies the feature. Not an aspiration: this is
    // what the hunk path does, and must keep doing, since a hunk has no
    // single valid document to feed the highlighter.
    const rows = wholeFileRows();
    const interior = rows[1];
    const perLine = syntaxPieces(interior, 'typescript', true);
    expect(perLine).not.toBeNull();
    expect(perLine!.every((p) => p.cls.includes('comment'))).toBe(false);
  });

  test('code after the comment is still code', () => {
    const rows = wholeFileRows();
    const docs = documentRuns(rows, 'typescript');
    const pieces = syntaxPieces(rows[4], 'typescript', true, docs);
    expect(pieces!.some((p) => p.cls.includes('keyword'))).toBe(true);
  });

  test('the two sides are reconstructed independently', () => {
    // A deletion belongs to the OLD document only and an addition to the
    // NEW one; mixing them would tokenize a file that never existed.
    const rows = [
      row('context', 'const a = 1;', 0),
      row('del', 'const b = 2;', 1),
      row('add', 'const b = 3;', 2),
      row('context', 'const c = 4;', 3),
    ];
    const docs = documentRuns(rows, 'typescript');
    expect(docs).not.toBeNull();
    for (const r of rows) {
      const pieces = syntaxPieces(r, 'typescript', true, docs);
      expect(pieces).not.toBeNull();
      // Every line here is ordinary code and must keep its keyword.
      expect(pieces!.some((p) => p.cls.includes('keyword'))).toBe(true);
    }
  });

  test('a no-newline marker is skipped, not counted as a line', () => {
    // It is git's prose about the row before it. Counting it would shift
    // every following line onto the wrong tokens.
    const rows = [
      row('context', 'const a = 1;', 0),
      row('no-newline', '\\ No newline at end of file', 1),
      row('context', 'const b = 2;', 2),
    ];
    const docs = documentRuns(rows, 'typescript');
    expect(docs!.get(rows[1])).toBeUndefined();
    expect(syntaxPieces(rows[2], 'typescript', true, docs)!.some((p) =>
      p.cls.includes('keyword')
    )).toBe(true);
  });

  test('no language means no document runs', () => {
    expect(documentRuns(wholeFileRows(), null)).toBeNull();
  });

  test('a line over the per-line cap falls back rather than mis-slicing', () => {
    const rows = [row('context', 'x'.repeat(5000), 0)];
    expect(documentRuns(rows, 'typescript')).toBeNull();
  });
});
