/**
 * Journal types: the append-only, hunk-granular edit chronology.
 *
 * The journal records observed snapshots of the worktree-vs-HEAD diff.
 * Entries are immutable and the log only grows; "outdated" is derived from
 * later entries' `supersedes`/`resolves` pointers, never stored. `seq` is
 * the only ordering axis; `ts` is a display label (mtime-clamped).
 *
 * All imports here are type-only: this module is importable by browser
 * clients (web/client) under the existing dependency rules.
 */

import type { DiffResult } from '../git/diffParse.js';
import type { FileStatus, GitStatus, InProgressOperation } from '../git/status.js';

/**
 * Header line marking a synthetic section for an untracked file too large
 * to snapshot. WorkingTreeManager emits it (with a size/mtime suffix, so a
 * later save re-hashes into an 'edited' entry) instead of deferring the
 * file forever; JournalManager stores the entry with diff: null — the
 * documented oversize case of the diff:null promise. Never produced by
 * git itself.
 */
export const OVERSIZE_UNTRACKED_MARKER = 'diffstalker-journal: oversize untracked snapshot omitted';

export type JournalHunkKind = 'created' | 'edited' | 'expanded' | 'shrunk' | 'reverted' | 'renamed';

export type JournalBoundaryKind =
  'commit' | 'checkout' | 'stash' | 'op-start' | 'op-end' | 'journal-start';

/** One recorded change to one hunk (or one pseudo-hunk for binary/mode-only files). */
export interface JournalHunkEntry {
  type: 'hunk';
  /** Per-store monotonic sequence number — THE order. */
  seq: number;
  /** Epoch ms, mtime-clamped (min(file mtime, observation time)); display only. */
  ts: number;
  path: string;
  /** File status at capture. */
  status: FileStatus;
  kind: JournalHunkKind;
  /** HEAD old-line footprint hull — drives the "lines 10-14" label. */
  span: { start: number; count: number };
  /** This hunk only. */
  stats: { insertions: number; deletions: number };
  /** File header lines + the ONE @@ section; null for reverted/oversize/pruned. */
  diff: DiffResult | null;
  /** Seqs of the live entries this entry replaces (plural: merges, whole-file reverts). */
  supersedes: number[];
  /** Co-appended entries from the same component (1 = plain, >1 = split/N-M). */
  siblings: number;
  /** True for entries reconstructing state present when the journal started. */
  seeded: boolean;
}

/** A divider: commit/checkout/stash/operation transition/journal start. */
export interface JournalBoundaryEntry {
  type: 'boundary';
  seq: number;
  ts: number;
  kind: JournalBoundaryKind;
  /** Short hash, branch name, operation name, ... */
  label: string;
  /** Seqs of live entries this boundary retires. */
  resolves: number[];
}

export type JournalEntry = JournalHunkEntry | JournalBoundaryEntry;

/** A closed interval in half-line HEAD pre-image coordinates. */
export type Run = [lo: number, hi: number];

/**
 * A hunk currently present in the worktree-vs-HEAD diff, as last recorded.
 * `runs` are edit-run footprints in half-line HEAD coordinates, sorted;
 * `bodyHash` is djb2 over the +/- lines only (context and headers excluded).
 */
export interface LiveHunk {
  /** Journal entry that last recorded this hunk. */
  seq: number;
  runs: Run[];
  bodyHash: string;
  ins: number;
  del: number;
}

/**
 * A hunk as parsed from one observation's diff: footprints, silence hash,
 * size, span, and the single-hunk snapshot diff.
 */
export interface ObservedHunk {
  runs: Run[];
  bodyHash: string;
  ins: number;
  del: number;
  span: { start: number; count: number };
  /** File header lines + this one @@ section. */
  diff: DiffResult;
  /**
   * True for the pseudo-hunk of an OVERSIZE_UNTRACKED_MARKER section: the
   * classifier stores its entries with diff: null (the section is a
   * header-only stand-in, not a snapshot).
   */
  oversize?: boolean;
}

/**
 * The journal's whole state. Held ABOVE the manager lifecycle (phase 2
 * lifts it into a daemon-level map keyed by repoId) so closing the last
 * client does not wipe the session's chronology.
 */
export interface JournalStore {
  entries: JournalEntry[];
  /** Minted per store; clients discard their cache on mismatch. */
  epoch: string;
  /** Next seq to assign; starts at 1. */
  nextSeq: number;
  live: Map<string, LiveHunk[]>;
  /** null until the store's first (seeding) observation. */
  lastHeadOid: string | null;
  lastBranch: string | null;
  lastStashCount: number;
  lastOperation: InProgressOperation | null;
}

/**
 * One settled observation of the working tree, emitted by
 * WorkingTreeManager.doRefresh after a fully-successful input gather
 * (throwing diff read, double HEAD-oid read, untracked reads inside the
 * queue slot). A skipped observation is always safe; a torn one never
 * reaches the journal.
 */
export interface JournalObservation {
  status: GitStatus;
  /** Worktree-vs-HEAD diff (-U3 pinned), untracked files appended as synthetic sections. */
  headDiff: DiffResult;
  headOid: string;
  stashCount: number;
  operationInProgress: InProgressOperation | null;
  /** Working-file mtimes (path -> mtimeMs), as shipped in GitState. */
  mtimes: Map<string, number> | null;
  /** Observation time, epoch ms. */
  at: number;
}
