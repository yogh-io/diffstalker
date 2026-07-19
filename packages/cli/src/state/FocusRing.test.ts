import { describe, expect, it } from 'bun:test';
import { FocusRing } from './FocusRing.js';

describe('FocusRing', () => {
  it('returns current item', () => {
    const ring = new FocusRing(['a', 'b', 'c']);
    expect(ring.current()).toBe('a');
  });

  it('cycles forward with next()', () => {
    const ring = new FocusRing(['a', 'b', 'c']);
    expect(ring.next()).toBe('b');
    expect(ring.next()).toBe('c');
    expect(ring.next()).toBe('a'); // wraps
  });

  it('cycles backward with prev()', () => {
    const ring = new FocusRing(['a', 'b', 'c']);
    expect(ring.prev()).toBe('c'); // wraps
    expect(ring.prev()).toBe('b');
    expect(ring.prev()).toBe('a');
  });

  it('respects initialIndex', () => {
    const ring = new FocusRing(['a', 'b', 'c'], 2);
    expect(ring.current()).toBe('c');
  });

  it('clamps initialIndex to valid range', () => {
    const ring = new FocusRing(['a', 'b', 'c'], 10);
    expect(ring.current()).toBe('c');
  });

  it('setCurrent moves to matching item', () => {
    const ring = new FocusRing(['a', 'b', 'c']);
    expect(ring.setCurrent('b')).toBe(true);
    expect(ring.current()).toBe('b');
  });

  it('setCurrent returns false for non-existent item', () => {
    const ring = new FocusRing(['a', 'b', 'c']);
    expect(ring.setCurrent('z')).toBe(false);
    expect(ring.current()).toBe('a'); // unchanged
  });

  it('setItems replaces items and clamps index', () => {
    const ring = new FocusRing(['a', 'b', 'c'], 2);
    ring.setItems(['x', 'y']);
    expect(ring.current()).toBe('y'); // clamped from 2 to 1
  });

  it('setItems with defaultItem sets the correct position', () => {
    const ring = new FocusRing(['a', 'b', 'c']);
    ring.setItems(['x', 'y', 'z'], 'y');
    expect(ring.current()).toBe('y');
  });

  it('setItems with missing defaultItem falls back to index 0', () => {
    const ring = new FocusRing(['a', 'b', 'c']);
    ring.setItems(['x', 'y', 'z'], 'w');
    expect(ring.current()).toBe('x');
  });

  it('works with single-element ring', () => {
    const ring = new FocusRing(['only']);
    expect(ring.current()).toBe('only');
    expect(ring.next()).toBe('only');
    expect(ring.prev()).toBe('only');
  });

  it('next/prev maintain correct position through mixed calls', () => {
    const ring = new FocusRing(['a', 'b', 'c', 'd']);
    ring.next(); // b
    ring.next(); // c
    ring.prev(); // b
    expect(ring.current()).toBe('b');
  });
});
