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

/** The unstaged/staged diff pair backing a combined diff view. */
export interface CombinedFileDiffs {
  unstaged: DiffResult;
  staged: DiffResult;
}

/**
 * Shared repo state: what the daemon broadcasts on the per-repo SSE
 * stream (and returns in mutation envelopes). isLoading is client-only —
 * true until the first snapshot arrives (and during an explicit refresh).
 */
export interface RepoSharedState {
  status: GitStatus | null;
  hunkCounts: WireHunkCounts | null;
  stashList: StashEntry[];
  /** Multi-step git operation the repo is stopped in, null when none. */
  operationInProgress: InProgressOperation | null;
  error: string | null;
  isLoading: boolean;
}

/** Per-client file selection and its fetched diffs. */
export interface RepoSelectionState {
  file: FileEntry | null;
  diff: DiffResult | null;
  combined: CombinedFileDiffs | null;
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
