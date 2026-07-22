/**
 * Split-view row projection: turns a hunk's unified content rows into
 * side-by-side rows (old on the left, new on the right), the second diff
 * viewing mode. Pure and memoized per rows-array identity — the SINGLE
 * source of truth for the split row count, shared by DiffView (render)
 * and DiffStack (its exact body-height model). A hunk's `rows` array is
 * stable per model build, so the WeakMap yields free repeat lookups.
 *
 * Pairing mirrors the unified builder (diffRows.buildHunkRows): within a
 * change run, consecutive deletions then consecutive additions are
 * zipped by position — deletion j sits opposite addition j (so a similar
 * pair's word-diff segments face each other), and the shorter side pads
 * with empty cells. Context lines occupy both sides. An unbalanced run
 * therefore yields max(dels, adds) split rows, fewer than the unified
 * dels + adds — which is exactly why the height model must count split
 * rows, not unified rows, in this mode.
 */

import type { DiffContentRow } from './diffRows';

export interface SplitRow {
  /** Content-stable v-for key, from the two sides' row keys. */
  key: string;
  /** Old side: a deletion or context row, or null (padding). */
  left: DiffContentRow | null;
  /** New side: an addition or context row, or null (padding). */
  right: DiffContentRow | null;
}

/** Build the side-by-side rows for one hunk's unified content rows. */
export function toSplitRows(rows: DiffContentRow[]): SplitRow[] {
  const out: SplitRow[] = [];
  let i = 0;
  while (i < rows.length) {
    if (rows[i].kind === 'context') {
      out.push({ key: rows[i].key, left: rows[i], right: rows[i] });
      i++;
      continue;
    }
    // A change run: consecutive deletions, then consecutive additions.
    const dels: DiffContentRow[] = [];
    while (i < rows.length && rows[i].kind === 'del') dels.push(rows[i++]);
    const adds: DiffContentRow[] = [];
    while (i < rows.length && rows[i].kind === 'add') adds.push(rows[i++]);
    const n = Math.max(dels.length, adds.length);
    for (let j = 0; j < n; j++) {
      const left = dels[j] ?? null;
      const right = adds[j] ?? null;
      out.push({ key: `${left?.key ?? '_'}|${right?.key ?? '_'}`, left, right });
    }
    // Defensive: a row that is neither context/del/add would not advance
    // i above (n === 0); skip it so the loop always terminates.
    if (dels.length === 0 && adds.length === 0) i++;
  }
  return out;
}

const cache = new WeakMap<readonly DiffContentRow[], SplitRow[]>();

/** Memoized toSplitRows, keyed by the hunk's stable rows array. */
export function splitRows(rows: DiffContentRow[]): SplitRow[] {
  let hit = cache.get(rows);
  if (!hit) {
    hit = toSplitRows(rows);
    cache.set(rows, hit);
  }
  return hit;
}

/** Number of side-by-side rows a hunk renders in split mode. */
export function splitRowCount(rows: DiffContentRow[]): number {
  return splitRows(rows).length;
}
