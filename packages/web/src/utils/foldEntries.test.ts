/**
 * foldEntries tests: the pure client-side fold projection
 * (docs/journal-hunk-classifier.md, section 4). Covers the join rule
 * (linear supersession inside the per-gap window), the split guard
 * (siblings), merge/revert/boundary group endings, the negative-delta
 * clamp, latest-position ordering, pre-group-baseline kind recompute,
 * key stability under growth, and purity (double apply on frozen
 * input).
 */

import { describe, test, expect } from 'vitest';
import { foldEntries, FOLD_MS } from './foldEntries';
import type { JournalHunkRow, JournalRow } from './foldEntries';
import type {
  JournalBoundaryEntry,
  JournalEntry,
  JournalHunkEntry,
} from '@diffstalker/core/types/journal';

/** Hunk entry: ts defaults to seq seconds (1s gaps, inside the window). */
function hunk(seq: number, overrides: Partial<JournalHunkEntry> = {}): JournalHunkEntry {
  return {
    type: 'hunk',
    seq,
    ts: seq * 1000,
    path: 'a.ts',
    status: 'modified',
    kind: 'edited',
    span: { start: 1, count: 1 },
    stats: { insertions: 1, deletions: 0 },
    diff: null,
    supersedes: [],
    siblings: 1,
    seeded: false,
    ...overrides,
  };
}

function boundary(
  seq: number,
  overrides: Partial<JournalBoundaryEntry> = {}
): JournalBoundaryEntry {
  return {
    type: 'boundary',
    seq,
    ts: seq * 1000,
    kind: 'commit',
    label: 'a1b2c3d subject',
    resolves: [],
    ...overrides,
  };
}

function keys(rows: JournalRow[]): number[] {
  return rows.map((row) => row.key);
}

function hunkRow(row: JournalRow): JournalHunkRow {
  if (row.type !== 'hunk-group') throw new Error('expected a hunk-group row');
  return row;
}

describe('basics', () => {
  test('empty input folds to no rows', () => {
    expect(foldEntries([])).toEqual([]);
  });

  test('unrelated entries each get their own row, in order', () => {
    const entries = [hunk(1), hunk(2, { path: 'b.ts' }), hunk(3, { path: 'c.ts' })];
    const rows = foldEntries(entries);
    expect(keys(rows)).toEqual([1, 2, 3]);
    for (const row of rows) {
      expect(hunkRow(row).members).toHaveLength(1);
      expect(hunkRow(row).kind).toBe('edited');
    }
  });

  test('a boundary renders as its own row', () => {
    const rows = foldEntries([hunk(1), boundary(2)]);
    expect(rows[1]).toEqual({ type: 'boundary', key: 2, entry: boundary(2) });
  });
});

describe('folding', () => {
  test('a fold-while-typing chain of N supersessions becomes one group xN', () => {
    // e1 created, then four autosave revisions each superseding the last.
    const entries: JournalEntry[] = [
      hunk(1, { kind: 'created' }),
      hunk(2, { supersedes: [1] }),
      hunk(3, { supersedes: [2] }),
      hunk(4, { supersedes: [3] }),
      hunk(5, { supersedes: [4] }),
    ];
    const rows = foldEntries(entries);
    expect(rows).toHaveLength(1);
    const group = hunkRow(rows[0]);
    expect(group.key).toBe(1); // keyed by the FIRST member — stable
    expect(group.tip.seq).toBe(5); // renders as the LATEST member
    expect(group.members.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]); // the x5 affordance
    expect(group.kind).toBe('created'); // began life as a new hunk
  });

  test('the window is per-gap: consecutive small gaps fold past foldMs total', () => {
    // 10s gaps, 40s total span — every gap is inside the 15s window.
    const entries: JournalEntry[] = [
      hunk(1, { ts: 0 }),
      hunk(2, { supersedes: [1], ts: 10_000 }),
      hunk(3, { supersedes: [2], ts: 20_000 }),
      hunk(4, { supersedes: [3], ts: 30_000 }),
      hunk(5, { supersedes: [4], ts: 40_000 }),
    ];
    expect(foldEntries(entries)).toHaveLength(1);
  });

  test('a gap above foldMs breaks the chain; exactly foldMs still folds', () => {
    const atWindow: JournalEntry[] = [
      hunk(1, { ts: 0 }),
      hunk(2, { supersedes: [1], ts: FOLD_MS }),
    ];
    expect(foldEntries(atWindow)).toHaveLength(1);

    const pastWindow: JournalEntry[] = [
      hunk(1, { ts: 0 }),
      hunk(2, { supersedes: [1], ts: FOLD_MS + 1 }),
    ];
    expect(foldEntries(pastWindow)).toHaveLength(2);
  });

  test('a negative ts delta clamps to 0 and folds (mtime is non-monotone; seq proves order)', () => {
    const entries: JournalEntry[] = [
      hunk(1, { ts: 100_000 }),
      hunk(2, { supersedes: [1], ts: 500 }), // earlier label than its predecessor
    ];
    const rows = foldEntries(entries);
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe(1);
  });

  test("a group moves to its tip's position; interleaved lineages order by tip", () => {
    // Lineage A gets revised AFTER lineage B appeared: A's group renders
    // at the bottom (recent edits at the bottom), still keyed 1.
    const entries: JournalEntry[] = [
      hunk(1),
      hunk(2, { path: 'b.ts' }),
      hunk(3, { supersedes: [1] }),
    ];
    const rows = foldEntries(entries);
    expect(keys(rows)).toEqual([2, 1]);
    const a = hunkRow(rows[1]);
    expect(a.tip.seq).toBe(3);
    expect(a.members).toHaveLength(2);
  });
});

describe('group endings', () => {
  test('the split guard: a split child never absorbs as a linear revision', () => {
    // Parent 1 splits into 2 and 3 — both supersede [1] with siblings 2.
    const entries: JournalEntry[] = [
      hunk(1),
      hunk(2, { supersedes: [1], siblings: 2 }),
      hunk(3, { supersedes: [1], siblings: 2 }),
    ];
    const rows = foldEntries(entries);
    expect(keys(rows)).toEqual([1, 2, 3]);
    for (const row of rows) {
      expect(hunkRow(row).members).toHaveLength(1);
    }
  });

  test('a merge (plural supersedes) never joins, but starts a joinable group', () => {
    const entries: JournalEntry[] = [
      hunk(1),
      hunk(2),
      hunk(3, { supersedes: [1, 2] }), // merge: ends both lineages
      hunk(4, { supersedes: [3] }), // a plain revision of the merged hunk
    ];
    const rows = foldEntries(entries);
    expect(keys(rows)).toEqual([1, 2, 3]);
    expect(hunkRow(rows[2]).members.map((e) => e.seq)).toEqual([3, 4]);
  });

  test('a revert ends the group: the tombstone stands alone', () => {
    const entries: JournalEntry[] = [
      hunk(1),
      hunk(2, { supersedes: [1], kind: 'reverted', diff: null }),
    ];
    const rows = foldEntries(entries);
    expect(keys(rows)).toEqual([1, 2]);
    const tombstone = hunkRow(rows[1]);
    expect(tombstone.kind).toBe('reverted');
    expect(tombstone.members).toHaveLength(1);
  });

  test('a boundary between the seqs breaks the group', () => {
    const entries: JournalEntry[] = [hunk(1), boundary(2), hunk(3, { supersedes: [1] })];
    const rows = foldEntries(entries);
    expect(keys(rows)).toEqual([1, 2, 3]);
    expect(hunkRow(rows[2]).members).toHaveLength(1);
  });

  test('lineages tipped AFTER a boundary keep folding', () => {
    const entries: JournalEntry[] = [boundary(1), hunk(2), hunk(3, { supersedes: [2] })];
    expect(keys(foldEntries(entries))).toEqual([1, 2]);
  });
});

describe('displayed kind vs the pre-group baseline', () => {
  test('recomputed against the entry the FIRST member superseded', () => {
    // Baseline 1 (size 5) is its own settled group (gap past the window);
    // the new group [2, 3] compares its tip against 1, not against 2.
    const entries: JournalEntry[] = [
      hunk(1, { ts: 0, stats: { insertions: 4, deletions: 1 } }),
      hunk(2, {
        supersedes: [1],
        ts: 100_000, // past the window: starts a NEW group
        stats: { insertions: 9, deletions: 0 },
        kind: 'expanded',
      }),
      hunk(3, {
        supersedes: [2],
        ts: 101_000,
        stats: { insertions: 6, deletions: 0 },
        kind: 'shrunk', // vs 2 it shrank — but vs the baseline it grew
      }),
    ];
    const rows = foldEntries(entries);
    expect(keys(rows)).toEqual([1, 2]);
    const group = hunkRow(rows[1]);
    expect(group.tip.seq).toBe(3);
    expect(group.kind).toBe('expanded'); // 6 > 5, keystroke flip-flop hidden
  });

  test('equal size against the baseline reads edited', () => {
    const entries: JournalEntry[] = [
      hunk(1, { ts: 0, stats: { insertions: 5, deletions: 0 } }),
      hunk(2, { supersedes: [1], ts: 100_000, stats: { insertions: 2, deletions: 0 } }),
      hunk(3, { supersedes: [2], ts: 101_000, stats: { insertions: 5, deletions: 0 } }),
    ];
    expect(hunkRow(foldEntries(entries)[1]).kind).toBe('edited');
  });

  test("a merge-started group falls back to the tip's own kind", () => {
    const entries: JournalEntry[] = [
      hunk(1),
      hunk(2),
      hunk(3, { supersedes: [1, 2] }),
      hunk(4, { supersedes: [3], kind: 'expanded' }),
    ];
    expect(hunkRow(foldEntries(entries)[2]).kind).toBe('expanded');
  });

  test("a pruned baseline falls back to the tip's own kind", () => {
    // Seq 4 was evicted daemon-side: 10 supersedes an entry we cannot see.
    const entries: JournalEntry[] = [
      hunk(10, { supersedes: [4] }),
      hunk(11, { supersedes: [10], kind: 'shrunk' }),
    ];
    const group = hunkRow(foldEntries(entries)[0]);
    expect(group.members).toHaveLength(2);
    expect(group.kind).toBe('shrunk');
  });
});

describe('purity and stability', () => {
  test('double apply on frozen input: identical output, input untouched', () => {
    const entries: JournalEntry[] = [
      hunk(1, { kind: 'created' }),
      hunk(2, { supersedes: [1] }),
      boundary(3),
      hunk(4, { supersedes: [2] }),
    ];
    for (const entry of entries) Object.freeze(entry);
    Object.freeze(entries);

    const first = foldEntries(entries);
    const second = foldEntries(entries);
    expect(second).toEqual(first);
    expect(entries.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
  });

  test('group keys never change as the log grows', () => {
    const prefix: JournalEntry[] = [hunk(1, { kind: 'created' }), hunk(2, { supersedes: [1] })];
    const full: JournalEntry[] = [...prefix, hunk(3, { supersedes: [2] })];

    const before = foldEntries(prefix);
    const after = foldEntries(full);
    expect(keys(before)).toEqual([1]);
    expect(keys(after)).toEqual([1]); // same key, tip moved to 3
    expect(hunkRow(after[0]).tip.seq).toBe(3);
  });
});
