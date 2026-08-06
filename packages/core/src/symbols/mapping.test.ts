/**
 * symbolAt / markChangedSymbols.
 *
 * The rule under test everywhere: null rather than a guess. A line no
 * symbol spans belongs to no symbol — the nearest declaration above it is
 * plausible and wrong, and a wrong label is worse than a blank one.
 */

import { describe, expect, test } from 'bun:test';
import { markChangedSymbols, symbolAt } from './mapping.js';
import type { FileSymbol } from './types.js';

function sym(name: string, startLine: number, endLine: number, parent: string | null = null): FileSymbol {
  return { kind: 'method', name, startLine, endLine, column: 0, parent };
}

// class Widget { render() {…} helper() {…} }  plus a free function below.
const CLASS = sym('Widget', 1, 20);
const RENDER = sym('render', 3, 8, 'Widget');
const HELPER = sym('helper', 10, 14, 'Widget');
const FREE = sym('free', 30, 34);
const SYMBOLS = [CLASS, RENDER, HELPER, FREE];

describe('symbolAt', () => {
  test('returns the innermost symbol, not the enclosing class', () => {
    expect(symbolAt(SYMBOLS, 5)?.name).toBe('render');
  });

  test('returns the class for a line inside it but outside any method', () => {
    expect(symbolAt(SYMBOLS, 9)?.name).toBe('Widget');
  });

  test('includes both boundary lines', () => {
    expect(symbolAt(SYMBOLS, 3)?.name).toBe('render');
    expect(symbolAt(SYMBOLS, 8)?.name).toBe('render');
  });

  test('a line between symbols is null, not the nearest one', () => {
    expect(symbolAt(SYMBOLS, 25)).toBeNull();
  });

  test('a line before everything is null', () => {
    expect(symbolAt(SYMBOLS, 0)).toBeNull();
  });

  test('an empty symbol list is null, never a throw', () => {
    expect(symbolAt([], 5)).toBeNull();
  });

  test('a one-line symbol is found on its line', () => {
    expect(symbolAt([sym('tiny', 7, 7)], 7)?.name).toBe('tiny');
  });
});

describe('markChangedSymbols', () => {
  test('marks a symbol a hunk falls inside', () => {
    const changed = markChangedSymbols(SYMBOLS, [{ start: 5, end: 6 }]);
    expect([...changed].map((s) => s.name).sort()).toEqual(['Widget', 'render']);
  });

  test('marks a symbol a hunk merely overlaps at its edge', () => {
    const changed = markChangedSymbols([RENDER], [{ start: 8, end: 12 }]);
    expect(changed.has(RENDER)).toBe(true);
  });

  test('does not mark a symbol the hunk misses', () => {
    const changed = markChangedSymbols(SYMBOLS, [{ start: 24, end: 26 }]);
    expect(changed.size).toBe(0);
  });

  test('marks across several ranges without duplicating', () => {
    const changed = markChangedSymbols(SYMBOLS, [
      { start: 5, end: 5 },
      { start: 6, end: 6 },
      { start: 31, end: 31 },
    ]);
    expect([...changed].map((s) => s.name).sort()).toEqual(['Widget', 'free', 'render']);
  });

  test('no ranges marks nothing', () => {
    expect(markChangedSymbols(SYMBOLS, []).size).toBe(0);
  });
});
