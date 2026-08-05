/**
 * finderModel: the pure matching logic behind the fuzzy finders.
 *
 * The web overlay and the CLI modal were the same code in two dialects —
 * same fzf, same smart-case, same empty-query rule, same highlight
 * segmentation, same selection arithmetic. This is the one copy.
 *
 * Pure by design: no state, no I/O, no widgets. Callers keep their own
 * selection state (the CLI in instance fields, the web in refs) and hand
 * it back here for the arithmetic. Nothing here knows what a repo is.
 */

import { Fzf, type FzfResultItem } from 'fzf';

/** Input debounce before a query is applied. Shared so both UIs feel alike. */
export const FINDER_DEBOUNCE_MS = 15;

export interface FinderMatch {
  text: string;
  /** Indices (into `text`) of the matched characters. */
  positions: Set<number>;
}

/** A run of characters that either all matched or all did not. */
export interface Segment {
  text: string;
  hit: boolean;
}

export interface FinderIndex {
  /** Matches for `query`. An empty query returns the first `limit` items. */
  find(query: string): FinderMatch[];
}

/** Shared by every empty-query result — never mutated. */
const NO_POSITIONS: ReadonlySet<number> = new Set<number>();

/**
 * Build a matcher over `items`, capped at `limit` results.
 *
 * Synchronous on purpose. fzf also ships an async matcher for very large
 * inputs, but making `find` promise-shaped would import an out-of-order
 * resolve bug into both call sites, which today have none.
 */
export function createFinderIndex(items: readonly string[], limit: number): FinderIndex {
  const list = items as string[];
  const fzf = new Fzf(list, { limit, casing: 'smart-case' });

  return {
    find(query: string): FinderMatch[] {
      if (query === '') {
        return list.slice(0, limit).map((text) => ({
          text,
          positions: NO_POSITIONS as Set<number>,
        }));
      }
      return fzf
        .find(query)
        .map((entry: FzfResultItem<string>) => ({ text: entry.item, positions: entry.positions }));
    },
  };
}

/**
 * Fold matched character indices into runs, for highlighting.
 *
 * `positions` indexes the ORIGINAL string. When the caller renders a
 * truncated tail, it passes that tail as `text` and the index the tail
 * starts at as `sliceFrom`; positions outside the tail simply drop out.
 * Callers that prefix an ellipsis render it themselves — keeping it out
 * of here is what removes the off-by-one the CLI used to carry.
 */
export function toSegments(text: string, positions: ReadonlySet<number>, sliceFrom = 0): Segment[] {
  const out: Segment[] = [];
  for (let i = 0; i < text.length; i++) {
    const hit = positions.has(i + sliceFrom);
    const last = out[out.length - 1];
    if (last !== undefined && last.hit === hit) last.text += text[i];
    else out.push({ text: text[i], hit });
  }
  return out;
}

/** Move `index` by `delta`, stopping at both ends. Empty list stays at 0. */
export function clampMove(index: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  return Math.min(length - 1, Math.max(0, index + delta));
}

/** Move `index` by `delta`, wrapping around both ends. Empty list stays at 0. */
export function cycleMove(index: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  return (((index + delta) % length) + length) % length;
}
