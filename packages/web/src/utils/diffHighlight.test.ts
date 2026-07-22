/**
 * diffHighlight tests: language resolution, the enable/language gates
 * (returning null so the caller keeps its plain path), text-preserving
 * tokenization, and the merge that layers word-diff "changed" flags over
 * syntax runs on the same characters.
 */

import { describe, test, expect } from 'vitest';
import { diffLanguage, syntaxPieces } from './diffHighlight';
import type { DiffContentRow } from './diffRows';
import type { WordDiffSegment } from '@diffstalker/core/view/wordDiff';

function row(content: string, segments?: WordDiffSegment[]): DiffContentRow {
  return { key: 'k', kind: 'context', content, ...(segments && { segments }) };
}

describe('diffLanguage', () => {
  test('maps a known extension to its hljs language', () => {
    expect(diffLanguage('src/a.ts')).toBe('typescript');
  });

  test('unknown extension, no path, and plaintext resolve to null', () => {
    expect(diffLanguage('notes.unknownext')).toBeNull();
    expect(diffLanguage(null)).toBeNull();
    expect(diffLanguage(undefined)).toBeNull();
  });
});

describe('syntaxPieces', () => {
  test('disabled returns null (caller keeps the plain / word-hl path)', () => {
    expect(syntaxPieces(row('const x = 1;'), 'typescript', false)).toBeNull();
  });

  test('null language returns null even when enabled', () => {
    expect(syntaxPieces(row('const x = 1;'), null, true)).toBeNull();
  });

  test('an over-long line returns null (hljs is ~quadratic on one huge token)', () => {
    const huge = 'a'.repeat(2001);
    expect(syntaxPieces(row(huge), 'typescript', true)).toBeNull();
  });

  test('enabled tokenizes: exact text preserved, at least one hljs class', () => {
    const pieces = syntaxPieces(row('const x = 1;'), 'typescript', true);
    expect(pieces).not.toBeNull();
    expect(pieces!.map((p) => p.text).join('')).toBe('const x = 1;');
    expect(pieces!.some((p) => p.cls.includes('hljs-'))).toBe(true);
    // No word-diff segments here, so nothing is flagged changed.
    expect(pieces!.every((p) => p.changed === false)).toBe(true);
  });

  test('word-diff segments mark exactly the overlapping pieces as changed', () => {
    const content = 'const x = 1;';
    // Segments partition the SAME text; only "1" is the changed word.
    const segments: WordDiffSegment[] = [
      { text: 'const x = ', type: 'same' },
      { text: '1', type: 'changed' },
      { text: ';', type: 'same' },
    ];
    const pieces = syntaxPieces(row(content, segments), 'typescript', true);
    expect(pieces).not.toBeNull();
    expect(pieces!.map((p) => p.text).join('')).toBe(content);
    const changedText = pieces!
      .filter((p) => p.changed)
      .map((p) => p.text)
      .join('');
    expect(changedText).toBe('1');
  });

  test('a changed segment spanning several tokens keeps every piece flagged', () => {
    const content = 'let a = foo();';
    // The whole "foo()" call changed.
    const segments: WordDiffSegment[] = [
      { text: 'let a = ', type: 'same' },
      { text: 'foo()', type: 'changed' },
      { text: ';', type: 'same' },
    ];
    const pieces = syntaxPieces(row(content, segments), 'typescript', true);
    expect(pieces).not.toBeNull();
    const changedText = pieces!
      .filter((p) => p.changed)
      .map((p) => p.text)
      .join('');
    expect(changedText).toBe('foo()');
  });

  test('memoizes per row + mode: a re-toggle recomputes to the right answer', () => {
    const r = row('const x = 1;');
    expect(syntaxPieces(r, 'typescript', false)).toBeNull();
    const on = syntaxPieces(r, 'typescript', true);
    expect(on).not.toBeNull();
    // Same object again, same signature -> same reference (cache hit).
    expect(syntaxPieces(r, 'typescript', true)).toBe(on);
    // Back off -> null again.
    expect(syntaxPieces(r, 'typescript', false)).toBeNull();
  });
});
