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
