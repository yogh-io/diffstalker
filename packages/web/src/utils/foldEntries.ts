/**
 * foldEntries: the client-side fold window over the journal's
 * append-only log (docs/journal-hunk-classifier.md, section 4), plus
 * its display row model.
 *
 * The daemon log is strictly append-only; folding an autosave chain of
 * supersessions into one evolving display row is a pure projection
 * computed here, so refetch, ?since=seq, epoch reset, and a second
 * client all re-fold identically from the same immutable bytes.
 *
 * Walking the entries in seq order (the store keeps them sorted), a
 * hunk entry joins the open group whose tip it supersedes iff:
 *   1. supersedes is exactly [tipSeq] (a linear 1-to-1 revision),
 *   2. siblings === 1 — the SPLIT GUARD: a split child carries a
 *      single-element supersedes and would otherwise absorb silently
 *      as a linear revision,
 *   3. no boundary entry sits between their seqs (a boundary closes
 *      every open group),
 *   4. ts - tip.ts <= foldMs, negative deltas clamped to 0 (ts is
 *      mtime-clamped and can be non-monotone; seq already proves
 *      order). The window is per-gap: a long session on one hunk
 *      stays one group as long as consecutive saves land inside it.
 * Merges (supersedes.length > 1), reverts, and boundaries END a group.
 *
 * A group is keyed by its FIRST member's seq — render keys never
 * change as the group grows — renders as its TIP (latest member) at
 * the tip's position (recent edits at the bottom), exposes the member
 * chain for the "xN" affordance, and recomputes its displayed kind
 * against the pre-group baseline (the entry the group's first member
 * superseded, looked up by seq; the tip's own kind when the baseline
 * was pruned) so keystroke-to-keystroke kind flip-flop cannot show.
 */

import type {
  JournalBoundaryEntry,
  JournalEntry,
  JournalHunkEntry,
  JournalHunkKind,
} from '@diffstalker/core/types/journal';

/** Per-gap fold window: successive 1-to-1 supersessions within this join. */
export const FOLD_MS = 15_000;

/** One rendered blurb: a chain of folded hunk entries; tip = the latest. */
export interface JournalHunkRow {
  type: 'hunk-group';
  /** First member's seq — the stable v-for key (keys never reorder). */
  key: number;
  /** Members in seq order; the tip is the last. */
  members: JournalHunkEntry[];
  tip: JournalHunkEntry;
  /** Display kind, recomputed against the pre-group baseline. */
  kind: JournalHunkKind;
}

/** One rendered divider row. */
export interface JournalBoundaryRow {
  type: 'boundary';
  key: number;
  entry: JournalBoundaryEntry;
}

export type JournalRow = JournalHunkRow | JournalBoundaryRow;

/**
 * Fold a seq-ordered entry list into display rows. Pure: never mutates
 * the input, and the same input always yields the same rows.
 */
export function foldEntries(
  entries: readonly JournalEntry[],
  foldMs: number = FOLD_MS
): JournalRow[] {
  const bySeq = new Map<number, JournalHunkEntry>();
  for (const entry of entries) {
    if (entry.type === 'hunk') bySeq.set(entry.seq, entry);
  }

  const rows: JournalRow[] = [];
  /** Open (joinable) groups by their tip's seq — the join-rule lookup. */
  const openByTip = new Map<number, JournalHunkRow>();

  for (const entry of entries) {
    if (entry.type === 'boundary') {
      openByTip.clear();
      rows.push({ type: 'boundary', key: entry.seq, entry });
      continue;
    }
    if (tryJoinGroup(entry, openByTip, rows, foldMs)) continue;

    // Merges/reverts/split children: close the groups they supersede.
    for (const seq of entry.supersedes) openByTip.delete(seq);
    const row: JournalHunkRow = {
      type: 'hunk-group',
      key: entry.seq,
      members: [entry],
      tip: entry,
      kind: entry.kind,
    };
    rows.push(row);
    // A revert is a tombstone: it ends its lineage and is never a join
    // target itself.
    if (entry.kind !== 'reverted') openByTip.set(entry.seq, row);
  }

  for (const row of rows) {
    if (row.type === 'hunk-group') row.kind = groupDisplayKind(row, bySeq);
  }
  return rows;
}

/**
 * Try to absorb `entry` into the open group whose tip it supersedes
 * (join-rule points 1, 2, and 4; point 3 holds because boundaries
 * clear the open set). On join the group re-keys its tip and moves to
 * the tip's position (the bottom); its render key never changes.
 */
function tryJoinGroup(
  entry: JournalHunkEntry,
  openByTip: Map<number, JournalHunkRow>,
  rows: JournalRow[],
  foldMs: number
): boolean {
  if (entry.kind === 'reverted' || entry.supersedes.length !== 1 || entry.siblings !== 1) {
    return false;
  }
  const target = openByTip.get(entry.supersedes[0]);
  if (!target || Math.max(0, entry.ts - target.tip.ts) > foldMs) return false;
  openByTip.delete(target.tip.seq);
  target.members.push(entry);
  target.tip = entry;
  openByTip.set(entry.seq, target);
  rows.splice(rows.indexOf(target), 1);
  rows.push(target);
  return true;
}

/**
 * A grown group's displayed kind, recomputed against the PRE-GROUP
 * baseline: the entry the group's first member superseded. Tip size vs
 * baseline size: greater is expanded, smaller is shrunk, equal is
 * edited. A chain that STARTED as a creation is one creation, however
 * edited; a pruned (or plural, merge-started) baseline falls back to
 * the tip's own kind.
 */
function groupDisplayKind(
  row: JournalHunkRow,
  bySeq: ReadonlyMap<number, JournalHunkEntry>
): JournalHunkKind {
  const { members, tip } = row;
  if (members.length === 1) return tip.kind;
  const first = members[0];
  if (first.supersedes.length === 0) return 'created';
  if (first.supersedes.length !== 1) return tip.kind;
  const baseline = bySeq.get(first.supersedes[0]);
  if (!baseline) return tip.kind; // baseline pruned — honest fallback
  const tipSize = tip.stats.insertions + tip.stats.deletions;
  const baseSize = baseline.stats.insertions + baseline.stats.deletions;
  if (tipSize > baseSize) return 'expanded';
  if (tipSize < baseSize) return 'shrunk';
  return 'edited';
}
