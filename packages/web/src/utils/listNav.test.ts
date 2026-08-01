import { describe, expect, it } from 'vitest';
import { nextIndex } from './listNav';

describe('nextIndex', () => {
  it('returns -1 for an empty list, whatever the delta', () => {
    expect(nextIndex(-1, 1, 0)).toBe(-1);
    expect(nextIndex(-1, -1, 0)).toBe(-1);
    expect(nextIndex(3, 1, 0)).toBe(-1);
  });

  it('enters from the near end when nothing is selected', () => {
    expect(nextIndex(-1, 1, 5)).toBe(0);
    expect(nextIndex(-1, -1, 5)).toBe(4);
  });

  it('steps by delta from the current index', () => {
    expect(nextIndex(2, 1, 5)).toBe(3);
    expect(nextIndex(2, -1, 5)).toBe(1);
  });

  it('clamps instead of wrapping — running off an end holds there', () => {
    expect(nextIndex(4, 1, 5)).toBe(4);
    expect(nextIndex(0, -1, 5)).toBe(0);
  });

  it('clamps oversized jumps into range', () => {
    expect(nextIndex(0, 99, 5)).toBe(4);
    expect(nextIndex(4, -99, 5)).toBe(0);
  });

  it('handles a single-item list', () => {
    expect(nextIndex(-1, 1, 1)).toBe(0);
    expect(nextIndex(0, 1, 1)).toBe(0);
    expect(nextIndex(0, -1, 1)).toBe(0);
  });
});
