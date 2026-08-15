/**
 * Client-side state shapes the web stores render from — the browser port
 * of the CLI's session types (packages/cli/src/types/session.ts). Only
 * DTO types are imported, type-only, erased at build.
 *
 * One deliberate difference: hunkCounts stay the wire's plain
 * {path: number} objects (the CLI revives them into Maps for core's
 * FileHunkCounts; the browser has no consumer that needs a Map).
 */

import type {
  GitStatus,
  FileEntry,
  StashEntry,
  InProgressOperation,
  CommitInfo,
} from '@diffstalker/core/git/status';
import type { DiffResult, CompareDiff } from '@diffstalker/core/git/diff';
import type { JournalEntry } from '@diffstalker/core/types/journal';
import type { WireHunkCounts } from '@diffstalker/client';

/**
 * Shared repo state: what the daemon broadcasts on the per-repo SSE
 * stream. isLoading is client-only — true until the first snapshot
 * arrives (and during an explicit refresh).
 */
export interface RepoSharedState {
  status: GitStatus | null;
  hunkCounts: WireHunkCounts | null;
  stashList: StashEntry[];
  /** Multi-step git operation the repo is stopped in, null when none. */
  operationInProgress: InProgressOperation | null;
  /**
   * Working-file mtimes (path -> mtimeMs) from the daemon, one entry
   * per changed path; deleted/renamed files are omitted. Kept as the
   * wire's plain object (like hunkCounts) — auto mode reads it to spot
   * which file changed on disk; the browser cannot stat files itself.
   */
  mtimes: Record<string, number> | null;
  error: string | null;
  isLoading: boolean;
}

/**
 * The active file (auto mode's anchor and the list's re-anchoring
 * target). Selection fetches nothing — the stacked Changes surface
 * reads per-file diffs from the store's workingDiffs cache.
 */
export interface RepoSelectionState {
  file: FileEntry | null;
}

/** Commit history state (per-client; pulled on demand). */
export interface RepoHistoryState {
  commits: CommitInfo[];
  selectedCommit: CommitInfo | null;
  commitDiff: DiffResult | null;
  isLoading: boolean;
}

/**
 * The journal slice the repo store exposes (flat members, one ref
 * each): a per-client cache of the daemon's append-only, per-hunk
 * edit chronology. Entries are kept in seq order and deduped by seq —
 * seq is the only ordering axis; ts is a display label. SSE
 * 'journal-append' batches carry the emitting store's epoch and only
 * splice into a log from the SAME store: a mismatched batch means the
 * daemon store reset, so it is never appended — the log is refetched
 * from scratch instead (entries from two epochs never interleave).
 * Batches land even before the first lazy load so an append racing
 * the initial GET is never lost (the load merges by seq, same-epoch
 * only). Reconnect resyncs floor on an internal journalSyncedTo
 * watermark that only successful fetches advance — never the live
 * tail, which racing appends may have pushed past an unfetched gap.
 * Folding into display rows is a pure projection (utils/foldEntries),
 * not state.
 */
export interface JournalStoreSlice {
  journalEntries: JournalEntry[];
  /**
   * The daemon journal-store's epoch (an opaque string, compared by
   * equality only), null until the first load. A different epoch on
   * reconnect means a new store (daemon restart / eviction): the cached
   * entries' seq space is meaningless and the log is refetched from
   * scratch.
   */
  journalEpoch: string | null;
  /** Entries below this seq were evicted daemon-side (ring buffer). */
  journalPrunedBefore: number;
  /** True once the lazy first load landed (Journal view activation). */
  journalLoaded: boolean;
  /**
   * A journal reset (epoch change or pruned gap on reconnect) replaced
   * the entries wholesale — the view renders a "journal restarted"
   * divider above the refetched log instead of a silent hole.
   */
  journalRestarted: boolean;
  /** Lazy first load, called on Journal view activation. */
  loadJournal: () => Promise<void>;
}

export type CompareSelectionType = 'commit' | 'file';

/** The selected commit/file in the compare view and its diff. */
export interface CompareSelectionState {
  type: CompareSelectionType | null;
  index: number;
  diff: DiffResult | null;
}

/** Base-branch comparison state (per-client; pulled on demand). */
export interface RepoCompareState {
  compareDiff: CompareDiff | null;
  baseBranch: string | null;
  /**
   * How many commits the compare would list, kept live from the moment the
   * repo opens — pulled on its own from GET /compare/count so the rail can
   * badge the tab without the (far heavier) full compareDiff. Null means
   * not yet known or nothing to measure against (no base branch); 0 is a
   * real answer and is shown as one.
   */
  commitCount: number | null;
  loading: boolean;
  error: string | null;
  /**
   * The daemon has no base branch to compare against (422): base detection
   * only considers remote refs, so a repo with no remote has none. Distinct
   * from "loaded, but no changes vs the base" so the compare view can show
   * a truthful message instead of "No changes".
   */
  noBaseBranch: boolean;
  selection: CompareSelectionState;
}

/**
 * One whole-file request, naming the SURFACE that asked. Changes and
 * Compare both use `u:`-prefixed row keys and mean different comparisons,
 * so the key alone cannot decide which read to make.
 */
export type WholeFileRequest =
  | { view: 'changes'; key: string; path: string }
  | { view: 'compare'; key: string; path: string; uncommitted: boolean }
  | { view: 'history'; key: string; path: string; hash: string };
