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
import type { FileForDisplay, FileMedia } from '@diffstalker/core/git/explorerData';
import type { JournalEntry } from '@diffstalker/core/types/journal';
import type { BlobSide } from '@diffstalker/core/utils/blobRef';
import type { SymbolOutcome } from '@diffstalker/core/symbols/types';

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
export type { DirEntry, FileForDisplay, FileMedia } from '@diffstalker/core/git/explorerData';
export type { BlobSide, BlobRef } from '@diffstalker/core/utils/blobRef';
export type { GrepMatch, GrepResult } from '@diffstalker/core/git/grep';
export type { FileSymbol, SymbolKind, SymbolOutcome } from '@diffstalker/core/symbols/types';

/**
 * A file read that may carry an outline.
 *
 * `symbols` is absent when it was not asked for, and also when the file is
 * binary or too large — those states are already on the flags, and giving
 * them a second encoding here is how two states collapse into one.
 */
export interface FileWithSymbols extends FileForDisplay {
  symbols?: SymbolOutcome;
}
export type { ImageInfo, ImageRefusal } from '@diffstalker/core/utils/imageSniff';
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

/**
 * GET/PUT /settings: the daemon's persistent, machine-level configuration.
 * `persisted` is false when the daemon holds settings in memory only, so a
 * client can say they will not outlive the daemon instead of promising a
 * save it did not get.
 */
export interface DaemonSettings {
  watchRoots: string[];
  persisted: boolean;
}

/** A git repo found under a watch directory, but not opened. */
export interface DiscoveredRepo {
  path: string;
  name: string;
  /** From .git/HEAD: a branch, a short sha when detached, or null. */
  branch: string | null;
  /**
   * Newest mtime of the git dir's `index` / `HEAD` (epoch ms), or null
   * when neither could be read. What a client ranks by, so the projects
   * worked on this week come first and years-old ones sink.
   */
  lastActivity: number | null;
}

/** One watch directory's scan result. */
export interface WatchRootState {
  path: string;
  repos: DiscoveredRepo[];
  /** Why the root itself yielded nothing (removed, unreadable). */
  error: string | null;
  /** The scan hit its cap: there are more repos than are listed. */
  capped: boolean;
}

/** One subdirectory in a GET /browse listing. */
export interface DirectoryEntry {
  name: string;
  path: string;
  /** True when the directory is itself a git repo, not a folder of them. */
  isRepo: boolean;
}

/**
 * GET /browse: one directory level of the daemon's filesystem, for picking
 * a watch directory. A browser cannot be handed a real path by its own
 * file pickers, so browsing happens daemon-side.
 */
export interface DirectoryListing {
  /** The directory that was listed, absolute and resolved. */
  path: string;
  /** Its parent, or null at the filesystem root. */
  parent: string | null;
  /** The daemon's home directory — where browsing starts. */
  home: string;
  entries: DirectoryEntry[];
}

/** GET /discovered, POST /discovered/rescan, and the `discovery-change` event. */
export interface DiscoveryState {
  roots: WatchRootState[];
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

/**
 * GET /repos/:id/media?path=&staged=0|1: one side of a changed file — where
 * its bytes are, and what the magic-byte sniffer made of them.
 *
 * `path` is already rename-resolved: the daemon reads the status entry and
 * answers with the path to ask /blob for on this side, so a client never
 * learns a rev vocabulary and never carries an originalPath of its own.
 *
 * `version` is the cache key to pass to blobUrl as `v` — the oid on the
 * index/head sides, `${size}-${mtimeMs}` on the worktree side. It is empty
 * when there is nothing to fetch (a side refused for being over the byte
 * cap), which is also when `image` is null: never build a blob URL for a
 * side whose `image` is null.
 */
export interface MediaSide extends FileMedia {
  path: string;
  side: BlobSide;
  /** The blob's real size, reported even when it was refused. */
  bytes: number;
  /** The git object id, or null for the working tree (not a git object). */
  oid: string | null;
}

/**
 * Old and new sides of one changed file. A side is null when the path does
 * not exist there, or when what is there is not a regular blob (a symlink,
 * a gitlink, a directory) — so `{old: null, new: null}` is a legitimate
 * answer, not an error.
 */
export interface MediaPair {
  old: MediaSide | null;
  new: MediaSide | null;
}
