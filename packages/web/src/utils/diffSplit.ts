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
 *
 * A `\ No newline at end of file` row is neither: it annotates the row
 * before it, so it takes a row of its own on that row's side only.
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

/**
 * A `\ No newline` row that stands on its own: the side it annotates
 * comes from the row before it — the deletion it follows (old file), the
 * addition it follows (new file), or both when it follows a context line
 * (one unchanged last line, so neither file ends in a newline). Showing
 * it on both sides regardless would claim the wrong thing about the file
 * that DOES end in a newline.
 */
function markerRow(marker: DiffContentRow, previous: DiffContentRow | undefined): SplitRow {
  if (previous?.kind === 'del') return { key: marker.key, left: marker, right: null };
  if (previous?.kind === 'add') return { key: marker.key, left: null, right: marker };
  return { key: marker.key, left: marker, right: marker };
}

/**
 * One change run: the deletions, the additions, and the `\ No newline`
 * markers git puts between and after them. `next` is the index the
 * scanner continues from.
 */
interface ChangeRun {
  dels: DiffContentRow[];
  adds: DiffContentRow[];
  /** The old side's marker — it sits BETWEEN the two runs. */
  midMarker: DiffContentRow | null;
  /** The new side's marker, after the additions. */
  endMarker: DiffContentRow | null;
  next: number;
}

/**
 * Read one change run out of `rows`, starting at `start`. A marker never
 * ends the run — stopping there is what put a pair on two rows.
 */
function takeRun(rows: DiffContentRow[], start: number): ChangeRun {
  let i = start;
  const dels: DiffContentRow[] = [];
  while (i < rows.length && rows[i].kind === 'del') dels.push(rows[i++]);
  const midMarker = i < rows.length && rows[i].kind === 'no-newline' ? rows[i++] : null;
  const adds: DiffContentRow[] = [];
  while (i < rows.length && rows[i].kind === 'add') adds.push(rows[i++]);
  const hasEndMarker =
    midMarker !== null && adds.length > 0 && i < rows.length && rows[i].kind === 'no-newline';
  const endMarker = hasEndMarker ? rows[i++] : null;
  // Defensive: a row of some other kind advances nothing above; step
  // over it so the caller's loop always terminates.
  if (dels.length === 0 && adds.length === 0 && midMarker === null) i++;
  return { dels, adds, midMarker, endMarker, next: i };
}

/** Zip a run into split rows: deletion j opposite addition j. */
function runRows(run: ChangeRun): SplitRow[] {
  const out: SplitRow[] = [];
  const n = Math.max(run.dels.length, run.adds.length);
  for (let j = 0; j < n; j++) {
    const left = run.dels[j] ?? null;
    const right = run.adds[j] ?? null;
    out.push({ key: `${left?.key ?? '_'}|${right?.key ?? '_'}`, left, right });
  }
  // Under the pair it annotates, on the old side. When the new side lost
  // its trailing newline too — the usual case, git emits a marker on each
  // side of the run — the two share this row instead of staggering.
  if (run.midMarker) {
    out.push({
      key: `${run.midMarker.key}|${run.endMarker?.key ?? '_'}`,
      left: run.midMarker,
      right: run.endMarker,
    });
  }
  return out;
}

/** Build the side-by-side rows for one hunk's unified content rows. */
export function toSplitRows(rows: DiffContentRow[]): SplitRow[] {
  const out: SplitRow[] = [];
  let i = 0;
  while (i < rows.length) {
    const row = rows[i];
    if (row.kind === 'no-newline') {
      out.push(markerRow(row, rows[i - 1]));
      i++;
    } else if (row.kind === 'context') {
      out.push({ key: row.key, left: row, right: row });
      i++;
    } else {
      const run = takeRun(rows, i);
      out.push(...runRows(run));
      i = run.next;
    }
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
