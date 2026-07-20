/**
 * Client-side session state shapes.
 *
 * These are the shapes the TUI renders from. They used to live on the
 * in-process core managers (working-tree / history / compare); now the
 * daemon owns the git state and RepoSession (src/daemon/RepoSession.ts)
 * maintains these locally from the daemon's REST + SSE API. Only core DTO
 * types (status entries, diffs, commits) are imported — type-only, erased
 * at build.
 */

import type {
  GitStatus,
  FileEntry,
  StashEntry,
  InProgressOperation,
  CommitInfo,
} from '@diffstalker/core/git/status';
import type { DiffResult, FileHunkCounts, CompareDiff } from '@diffstalker/core/git/diff';

/** The unstaged/staged diff pair backing the flat (combined) diff view. */
export interface CombinedFileDiffs {
  unstaged: DiffResult;
  staged: DiffResult;
}

/**
 * Shared repo state: what the daemon broadcasts on the per-repo SSE
 * stream (and returns in mutation envelopes). isLoading is client-only —
 * true until the first snapshot arrives (and during an explicit refresh).
 */
export interface SessionSharedState {
  status: GitStatus | null;
  hunkCounts: FileHunkCounts | null;
  stashList: StashEntry[];
  /** Multi-step git operation the repo is stopped in, null when none. */
  operationInProgress: InProgressOperation | null;
  error: string | null;
  isLoading: boolean;
}

/** Per-client file selection and its fetched diffs. */
export interface SessionSelectionState {
  file: FileEntry | null;
  diff: DiffResult | null;
  combined: CombinedFileDiffs | null;
}

/** Commit history state (per-client; pulled on demand). */
export interface HistoryState {
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
export interface SessionCompareState {
  compareDiff: CompareDiff | null;
  baseBranch: string | null;
  loading: boolean;
  error: string | null;
  /**
   * The daemon has no base branch to compare against (422): base detection
   * only considers remote refs like origin/main, so a repo with no remote
   * has none. Distinct from "loaded, but no changes vs the base" so the
   * compare view can show a truthful message instead of "No changes".
   */
  noBaseBranch: boolean;
  selection: CompareSelectionState;
}
