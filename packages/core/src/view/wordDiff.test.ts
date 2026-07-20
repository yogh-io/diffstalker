import { describe, it, expect } from 'vitest';
import { areSimilarEnough, computeWordDiff } from './wordDiff.js';

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
