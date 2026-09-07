import { describe, it, expect } from 'vitest';
import {
  areSimilarEnough,
  computeWordDiff,
  expandSegmentsToWords,
  type WordDiffSegment,
} from './wordDiff.js';

describe('areSimilarEnough', () => {
  it('returns true for identical strings', () => {
    expect(areSimilarEnough('hello world', 'hello world')).toBe(true);
  });

  it('returns true for similar strings', () => {
    expect(areSimilarEnough('const x = 1;', 'const x = 2;')).toBe(true);
  });

  it('returns false for completely different strings', () => {
    expect(areSimilarEnough('abc', 'xyz')).toBe(false);
  });

  it('returns false for empty old text', () => {
    expect(areSimilarEnough('', 'hello')).toBe(false);
  });

  it('returns false for empty new text', () => {
    expect(areSimilarEnough('hello', '')).toBe(false);
  });

  it('returns false for both empty', () => {
    expect(areSimilarEnough('', '')).toBe(false);
  });

  it('returns true for minor edits', () => {
    expect(areSimilarEnough('function foo() {', 'function bar() {')).toBe(true);
  });

  it('returns false for low similarity', () => {
    expect(areSimilarEnough('abcdef', 'ghijkl')).toBe(false);
  });
});

describe('computeWordDiff', () => {
  it('returns all same segments for identical strings', () => {
    const { oldSegments, newSegments } = computeWordDiff('hello', 'hello');
    expect(oldSegments).toEqual([{ text: 'hello', type: 'same' }]);
    expect(newSegments).toEqual([{ text: 'hello', type: 'same' }]);
  });

  it('marks changed portions', () => {
    const { oldSegments, newSegments } = computeWordDiff('const x = 1;', 'const x = 2;');

    // Old should have 'changed' for '1'
    const oldChanged = oldSegments.filter((s) => s.type === 'changed');
    expect(oldChanged.length).toBeGreaterThan(0);

    // New should have 'changed' for '2'
    const newChanged = newSegments.filter((s) => s.type === 'changed');
    expect(newChanged.length).toBeGreaterThan(0);
  });

  it('handles completely different strings', () => {
    const { oldSegments, newSegments } = computeWordDiff('abc', 'xyz');
    // Everything should be changed
    expect(oldSegments.some((s) => s.type === 'changed')).toBe(true);
    expect(newSegments.some((s) => s.type === 'changed')).toBe(true);
  });

  it('handles deletion (old has content not in new)', () => {
    const { oldSegments, newSegments } = computeWordDiff('hello world', 'hello');
    expect(oldSegments.some((s) => s.type === 'changed')).toBe(true);
    // Reconstructed old text should match
    expect(oldSegments.map((s) => s.text).join('')).toBe('hello world');
    expect(newSegments.map((s) => s.text).join('')).toBe('hello');
  });

  it('handles insertion (new has content not in old)', () => {
    const { oldSegments, newSegments } = computeWordDiff('hello', 'hello world');
    expect(newSegments.some((s) => s.type === 'changed')).toBe(true);
    expect(oldSegments.map((s) => s.text).join('')).toBe('hello');
    expect(newSegments.map((s) => s.text).join('')).toBe('hello world');
  });
});

describe('expandSegmentsToWords', () => {
  /** The changed text, with `|` between runs — what a reader sees highlighted. */
  const changed = (oldText: string, newText: string): [string, string] => {
    const { oldSegments, newSegments } = computeWordDiff(oldText, newText);
    const marks = (segments: WordDiffSegment[]): string =>
      expandSegmentsToWords(segments)
        .filter((segment) => segment.type === 'changed')
        .map((segment) => segment.text)
        .join('|');
    return [marks(oldSegments), marks(newSegments)];
  };

  it('grows a mid-word change out to the whole word', () => {
    // fast-diff alone marks only 'ullseye'/'ookworm' — the shared 'b'
    // stays unhighlighted and the highlight starts mid-word.
    expect(changed('FROM debian:bullseye', 'FROM debian:bookworm')).toEqual([
      'bullseye',
      'bookworm',
    ]);
  });

  it('stops at word boundaries instead of swallowing the line', () => {
    expect(
      changed(
        'id=aerius-apt-cache-debian-bullseye,mode=0755',
        'id=aerius-apt-cache-debian-bookworm,mode=0755'
      )
    ).toEqual(['bullseye', 'bookworm']);
  });

  it('grows a shared suffix into the highlight too', () => {
    expect(changed('call(foo_id)', 'call(bar_id)')).toEqual(['foo_id', 'bar_id']);
  });

  it('leaves a change that already starts at a boundary alone', () => {
    expect(changed('run --fast', 'run --fast --safe')).toEqual(['', ' --safe']);
  });

  it('merges two changes inside one word into one highlight', () => {
    expect(changed('v1_2_3', 'v4_2_5')).toEqual(['v1_2_3', 'v4_2_5']);
  });

  it('does not cross a non-word character', () => {
    expect(changed('a.b.c', 'a.x.c')).toEqual(['b', 'x']);
  });

  it('reconstructs the original text exactly', () => {
    const { oldSegments } = computeWordDiff('const value = 1;', 'const other = 2;');
    expect(
      expandSegmentsToWords(oldSegments)
        .map((segment) => segment.text)
        .join('')
    ).toBe('const value = 1;');
  });

  it('leaves an all-same line untouched', () => {
    const segments: WordDiffSegment[] = [{ text: 'unchanged', type: 'same' }];
    expect(expandSegmentsToWords(segments)).toEqual(segments);
  });

  it('handles empty input', () => {
    expect(expandSegmentsToWords([])).toEqual([]);
  });
});
