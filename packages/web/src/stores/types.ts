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
