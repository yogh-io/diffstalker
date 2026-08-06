/**
 * Pure questions about a symbol list: which symbol owns a line, and which
 * symbols a set of changed line ranges touches.
 *
 * The rule both functions obey: **null rather than a guess.** A line that
 * no symbol spans belongs to no symbol. The nearest one above it is a
 * plausible answer and a wrong one, and a wrong symbol label is the
 * failure that discredits an outline — worse than a blank.
 */

import type { FileSymbol } from './types.js';

/** A 1-based, inclusive line span. */
export interface LineRange {
  start: number;
  end: number;
}

function spans(symbol: FileSymbol, line: number): boolean {
  return line >= symbol.startLine && line <= symbol.endLine;
}

/** How many lines a symbol covers. Smaller means more deeply nested. */
function extent(symbol: FileSymbol): number {
  return symbol.endLine - symbol.startLine;
}

/**
 * The innermost symbol containing `line`, or null.
 *
 * Innermost by span width: a method inside a class is the answer, not the
 * class. Ties break toward the later declaration, which is the inner one
 * when two symbols share a span.
 */
export function symbolAt(symbols: readonly FileSymbol[], line: number): FileSymbol | null {
  let best: FileSymbol | null = null;
  for (const symbol of symbols) {
    if (!spans(symbol, line)) continue;
    if (best === null || extent(symbol) <= extent(best)) best = symbol;
  }
  return best;
}

/**
 * Symbols overlapping any of `ranges` — the ones a changeset touched.
 *
 * Every overlapping symbol is returned, not just the innermost: a hunk
 * inside a method changed that method AND its class, and a reader wants
 * both marked. Callers that want one label ask `symbolAt`.
 */
export function markChangedSymbols(
  symbols: readonly FileSymbol[],
  ranges: readonly LineRange[]
): Set<FileSymbol> {
  const changed = new Set<FileSymbol>();
  for (const symbol of symbols) {
    for (const range of ranges) {
      if (symbol.startLine <= range.end && symbol.endLine >= range.start) {
        changed.add(symbol);
        break;
      }
    }
  }
  return changed;
}
