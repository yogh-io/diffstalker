/**
 * Pure encoders for the daemon wire format.
 *
 * Only SHARED repo state crosses the wire: status, hunk counts, stash
 * list, error, and any in-progress operation. Per-client concerns (file
 * selection and its diffs) never live on the manager's GitState — clients
 * fetch diffs via the parameterized /repos/:id/diff endpoint instead.
 */

import type { GitStatus, StashEntry, InProgressOperation } from '@diffstalker/core/git/status';
import type { FileHunkCounts } from '@diffstalker/core/git/diff';
import type { GitState } from '@diffstalker/core/managers/WorkingTreeManager';
import type { JournalEntry, JournalStore } from '@diffstalker/core/types/journal';

export interface WireHunkCounts {
  staged: Record<string, number>;
  unstaged: Record<string, number>;
}

export interface WireSharedState {
  status: GitStatus | null;
  hunkCounts: WireHunkCounts | null;
  /** Watcher/refresh error surfaced by the manager, null when healthy. */
  error: string | null;
  /** Stash entries ({index, message}), refreshed with the working tree. */
  stashList: StashEntry[];
  /**
   * Multi-step git operation the repo is stopped in (a conflicted rebase,
   * cherry-pick, revert, or merge), null when none. When set, mutations
   * will keep failing until POST /abort (or /rebase-continue) resolves it.
   */
  operationInProgress: InProgressOperation | null;
  /**
   * Working-file mtimes (path -> mtimeMs), one entry per changed path;
   * stat-failing (deleted/renamed) files are omitted. Browser clients
   * cannot stat files — this field is what drives their mtime-based
   * auto mode. Because an in-place edit bumps an mtime, it also makes
   * the state-change payload differ so the SSE dedup still fires when
   * the +/- line counts are unchanged.
   */
  mtimes: Record<string, number> | null;
}

/** Convert a string-keyed Map to a plain object for JSON. */
export function mapToRecord<V>(map: Map<string, V>): Record<string, V> {
  const record: Record<string, V> = {};
  for (const [key, value] of map) {
    record[key] = value;
  }
  return record;
}

/** Encode hunk counts (two Maps) as plain objects. */
export function serializeHunkCounts(counts: FileHunkCounts | null): WireHunkCounts | null {
  if (!counts) return null;
  return {
    staged: mapToRecord(counts.staged),
    unstaged: mapToRecord(counts.unstaged),
  };
}

/** Encode the shared part of a repo's GitState for the wire. */
export function serializeSharedState(state: GitState): WireSharedState {
  return {
    status: state.status,
    hunkCounts: serializeHunkCounts(state.hunkCounts),
    error: state.error,
    stashList: state.stashList,
    operationInProgress: state.operationInProgress,
    mtimes: state.mtimes ? mapToRecord(state.mtimes) : null,
  };
}

/** GET /repos/:id/journal response. */
export interface WireJournal {
  /** Opaque store identity, minted per JournalStore; clients discard their cache on mismatch. */
  epoch: string;
  /**
   * Highest pruned seq (0 when nothing is pruned): entries with
   * seq <= prunedBefore are gone. A prunedBefore above a client's last
   * seen seq means a gap it can never fill with ?since — full refetch.
   */
  prunedBefore: number;
  entries: JournalEntry[];
}

/**
 * Encode journal entries for the wire: a pass-through. Entries are
 * JSON-native by design (ts is epoch ms, span/stats/supersedes are plain)
 * and the embedded DiffResult ({raw, lines}) crosses the wire exactly as
 * the existing /diff endpoints send it — plain JSON, no Dates or Maps.
 */
export function serializeJournalEntries(entries: JournalEntry[]): JournalEntry[] {
  return entries;
}

/**
 * Derive the highest pruned seq from the store: seqs start at 1, so any
 * gap below the first retained entry is pruned history. An empty store
 * that has assigned seqs (everything pruned) reports its last assigned
 * seq; a fresh store reports 0.
 */
export function journalPrunedBefore(store: JournalStore): number {
  return store.entries.length > 0 ? store.entries[0].seq - 1 : store.nextSeq - 1;
}

/** Encode a journal read: entries with seq > since (all when since is 0). */
export function serializeJournal(store: JournalStore, since: number): WireJournal {
  const entries = since > 0 ? store.entries.filter((e) => e.seq > since) : store.entries;
  return {
    epoch: store.epoch,
    prunedBefore: journalPrunedBefore(store),
    entries: serializeJournalEntries(entries),
  };
}

/**
 * Recursively make a value JSON-safe: Dates become ISO strings and Maps
 * become plain objects. Applied to every response payload before
 * JSON.stringify so no endpoint can leak a non-JSON type.
 */
export function toWire(value: unknown): unknown {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value instanceof Map) {
    const record: Record<string, unknown> = {};
    for (const [key, entry] of value) {
      record[String(key)] = toWire(entry);
    }
    return record;
  }
  if (Array.isArray(value)) {
    return value.map(toWire);
  }
  if (value !== null && typeof value === 'object') {
    const record: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      record[key] = toWire(entry);
    }
    return record;
  }
  return value;
}
