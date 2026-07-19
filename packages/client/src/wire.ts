/**
 * Wire types for the diffstalkerd REST + SSE API.
 *
 * DTO shapes come TYPE-ONLY from @diffstalker/core — the client never
 * imports core (or daemon) runtime code; its only runtime dependencies are
 * node builtins. Daemon-specific shapes (the shared-state snapshot, the
 * {state, result?} mutation envelope, the SSE event payloads) are declared
 * here to match packages/daemon/src/serialize.ts and the route modules.
 */

import type {
  GitStatus,
  StashEntry,
  InProgressOperation,
  CommitInfo,
} from '@diffstalker/core/git/status';
import type { CompareDiff } from '@diffstalker/core/git/diff';

// Core DTOs re-exported for consumers (type-only, erased at build).
export type {
  GitStatus,
  FileEntry,
  BranchInfo,
  FileStatus,
  StashEntry,
  InProgressOperation,
  CommitInfo,
  LocalBranch,
} from '@diffstalker/core/git/status';
export type {
  DiffResult,
  DiffLine,
  CompareDiff,
  CompareFileDiff,
  CompareDiffStats,
} from '@diffstalker/core/git/diff';
export type { DirEntry, FileForDisplay } from '@diffstalker/core/git/explorerData';
export type { WorktreeInfo } from '@diffstalker/core/git/worktree';
export type { RemoteOperationState, RemoteOperation } from '@diffstalker/core/types/remote';

/** Hunk counts as JSON: core's two Maps become plain objects. */
export interface WireHunkCounts {
  staged: Record<string, number>;
  unstaged: Record<string, number>;
}

/**
 * The shared repo state the daemon serves on GET /status, in mutation
 * envelopes, and on the per-repo SSE stream (snapshot / state-change).
 * Mirrors WireSharedState in packages/daemon/src/serialize.ts.
 */
export interface WireSharedState {
  status: GitStatus | null;
  hunkCounts: WireHunkCounts | null;
  /** Watcher/refresh error surfaced by the manager, null when healthy. */
  error: string | null;
  /** Stash entries ({index, message}), refreshed with the working tree. */
  stashList: StashEntry[];
  /**
   * Multi-step git operation the repo is stopped in (a conflicted rebase,
   * cherry-pick, revert, or merge), null when none.
   */
  operationInProgress: InProgressOperation | null;
}

/**
 * The unified mutation response: refreshed shared state, plus the optional
 * human-readable outcome text of remote/branch/undo operations.
 */
export interface MutationEnvelope {
  state: WireSharedState;
  result?: string | null;
}

/** GET /health. */
export interface HealthState {
  ok: boolean;
  ready: boolean;
}

/** A repo as identified by the daemon (POST /repos, SSE repo-opened). */
export interface RepoRef {
  id: string;
  path: string;
}

/** One row of GET /repos. */
export interface RepoSummary extends RepoRef {
  branch: string | null;
}

/** GET /follow. */
export interface FollowState {
  /** The hook file being watched (null when follow mode is disabled). */
  targetFile: string | null;
  enabled: boolean;
  /** Repo id of the currently followed repo, null before the first hit. */
  followedRepoId: string | null;
  /** Worktree root of the currently followed repo. */
  followedPath: string | null;
}

/** Payload of the daemon-scope `follow-change` SSE event. */
export interface FollowChangeEvent {
  repoId: string;
  /** Resolved hook-file content; may point at a file inside the repo. */
  path: string;
  /** The literal hook-file line. */
  rawContent: string;
}

/** Payload of the daemon-scope `repo-opened` SSE event. */
export type RepoOpenedEvent = RepoRef;

/** Payload of the daemon-scope `repo-closed` SSE event. */
export interface RepoClosedEvent {
  id: string;
}

/** CommitInfo as JSON: the Date crosses the wire as an ISO string. */
export type WireCommitInfo = Omit<CommitInfo, 'date'> & { date: string };

/** CompareDiff as JSON: commit dates are ISO strings. */
export type WireCompareDiff = Omit<CompareDiff, 'commits'> & { commits: WireCommitInfo[] };
