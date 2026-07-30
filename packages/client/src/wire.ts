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
import type { JournalEntry } from '@diffstalker/core/types/journal';

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
export type {
  JournalEntry,
  JournalHunkEntry,
  JournalBoundaryEntry,
  JournalHunkKind,
  JournalBoundaryKind,
} from '@diffstalker/core/types/journal';

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
  /**
   * Working-file mtimes (path -> mtimeMs), one entry per changed path;
   * files with nothing on disk (deleted/renamed) are omitted. Daemon-side
   * stat results — the field browser clients build mtime-based auto mode
   * on, since they cannot stat files themselves. An in-place edit bumps
   * an mtime, so a state-change fires even when +/- counts are unchanged.
   */
  mtimes: Record<string, number> | null;
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
  /** The daemon's $HOME, so clients can show/store paths relative to it
   * (a home-relative URL drops the /home/<user> prefix). Null if unknown. */
  home?: string | null;
}

/** How the running daemon relates to the latest version published on npm. */
export type VersionStatus = 'current' | 'outdated' | 'ahead' | 'unknown';

/** GET /version. Either side is null when it cannot be known — an
 *  unreadable manifest, an offline daemon, or --no-update-check. */
export interface VersionState {
  current: string | null;
  latest: string | null;
  status: VersionStatus;
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

/**
 * GET /repos/:id/compare/count: how many commits /compare would list, and
 * the base it measured against. JSON-native — no revival.
 */
export interface CompareCount {
  baseBranch: string;
  commits: number;
}

/**
 * GET /repos/:id/journal?since=<seq>: entries with seq > since (all when
 * omitted). Entries are JSON-native (ts is epoch ms; span/stats/supersedes
 * are plain; the embedded DiffResult crosses the wire as-is, like GET
 * /diff), so no revival is needed. An epoch mismatch, or prunedBefore
 * above the client's last seq, means the journal was reset/pruned: discard
 * the cache and refetch from scratch.
 */
export interface JournalResponse {
  /** Opaque store identity, minted per JournalStore; compare with equality only. */
  epoch: string;
  /** Ring-buffer eviction watermark: entries below it are gone. */
  prunedBefore: number;
  entries: JournalEntry[];
}

/**
 * Payload of the per-repo `journal-append` SSE event: all entries from one
 * observation in one event, so clients apply them atomically. The epoch is
 * the emitting store's identity (an opaque string, compared with ===/!==
 * only): a batch whose epoch differs from the client's cached one belongs
 * to a reset store's unrelated seq space — never append it; refetch the
 * log from scratch instead.
 */
export interface JournalAppendEvent {
  /** Opaque store identity; compare with equality only. */
  epoch: string;
  entries: JournalEntry[];
}
