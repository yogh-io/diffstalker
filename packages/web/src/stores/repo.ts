/**
 * useRepoStore: the per-active-repo Pinia store — the browser port of the
 * CLI's RepoSession (packages/cli/src/daemon/RepoSession.ts), READ-ONLY:
 * the web UI is a viewer, so this store runs no git mutations. The only
 * non-GET requests it makes are POST /repos (attach) and DELETE /repos/:id
 * (release) — refcounting, not git operations.
 *
 * - shared state (status, hunk counts, stash list, in-progress op, error)
 *   is fed by the per-repo SSE stream through the single applyWireState
 *   sink;
 * - selection tracks the ACTIVE file only (auto mode's anchor and the
 *   list's re-anchoring). It fetches NOTHING — the stacked Changes
 *   surface reads per-file diffs from workingDiffs; the old per-selection
 *   GET /diff path is gone;
 * - workingDiffs is the per-file working-diff cache behind the stacked
 *   Changes surface (docs/web-diff-stream-architecture.md §2): activated
 *   by refreshAllDiffs (two whole-tree pulls split client-side +
 *   per-file pulls for untracked files) — fired automatically on the
 *   repo's first snapshot, retried on later snapshots until it lands —
 *   then kept warm on state-change by refetching ONLY the changed files
 *   (mtimes/hunkCounts/status diffing, whole-tree fallback past 15
 *   files). Entries preserve object identity when content is unchanged
 *   (raw compared by value) so downstream render memos hit; stale
 *   responses are dropped by per-key sequence tokens;
 * - history and compare are pulled on demand and re-pulled on state-change
 *   when previously loaded;
 * - the compare base is per-client too: selectedCompareBase rides along
 *   as GET /compare?base=… — nothing is persisted daemon-side.
 *
 * Everything a view reads is synchronous reactive state (shallowRefs whose
 * whole value is replaced — shallow so object identity survives, which the
 * stale-guard and selection re-anchoring depend on). Shared-state and diff
 * loading collapse errors into shared.error rather than throwing. The two
 * on-demand reads that mirror RepoSession by rejecting a DaemonError to the
 * caller — loadHistory and selectHistoryCommit — are the exceptions; a view
 * calling those awaits and catches (connection errors still collapse quietly).
 *
 * Reconnect: when the SSE stream drops, ONE calm status line lands in
 * shared.error and a single-flight recovery loop re-POSTs /repos (the
 * path-hashed id is stable across a daemon restart), resubscribes, and
 * pulls a fresh status — which clears the line. The browser cannot spawn
 * a daemon (unlike the CLI's ensureDaemon); it just retries until the
 * daemon is back.
 *
 * Deviations from RepoSession, both singleton-store realities:
 * - a generation counter guards async completions across open() calls
 *   (RepoSession is one instance per repo; this store is reused);
 * - open() is the ONE place a repo ref is taken (POST /repos) and it
 *   releases the previous repo's ref after a successful switch, so the
 *   daemon's refcount stays truthful and daemon-side close stays possible.
 */

import { computed, markRaw, shallowRef } from 'vue';
import { defineStore } from 'pinia';
import { DiffstalkerClient } from '../api/client';
import { DaemonError, isConnectionError } from '../api/errors';
import { splitDiffByFile } from '../utils/splitDiffByFile';
import { buildDiffModel } from '../utils/diffRows';
import type { DiffModel } from '../utils/diffRows';
import type { SseHandle } from '../api/transport';
import type { RepoRef, WireHunkCounts, WireSharedState } from '@diffstalker/client';
import type { FileEntry, CommitInfo } from '@diffstalker/core/git/status';
import type { CompareDiff, DiffResult } from '@diffstalker/core/git/diff';
import type { WorktreeInfo } from '@diffstalker/core/git/worktree';
import type {
  RepoSharedState,
  RepoSelectionState,
  RepoHistoryState,
  RepoCompareState,
  CompareSelectionState,
} from './types';

/** How long changed-file refetches coalesce into one per-file batch. */
const DIFF_DEBOUNCE_MS = 20;

/** Delay before a reconnect attempt after the SSE stream drops. */
const RECONNECT_DELAY_MS = 1000;

/** Max parallel per-file diff fetches for the working-diff cache. */
const WORKING_DIFF_CONCURRENCY = 6;

/**
 * When a state-change touches more files than this (branch switch,
 * big stash pop), one whole-tree re-pull beats N per-file fetches.
 */
const WHOLE_TREE_REPULL_THRESHOLD = 15;

/** One cached per-file working diff. The DiffResult is markRaw'd. */
export interface WorkingDiffEntry {
  /** The diff's raw text — compared BY VALUE to preserve identity. */
  raw: string;
  diff: DiffResult;
  /** When this entry's content was applied (epoch ms). */
  fetchedAt: number;
}

/** The working-diff cache: entries keyed by file-list row key. */
export interface WorkingDiffsState {
  byKey: Map<string, WorkingDiffEntry>;
  /** Bumped on every commit — the shallowRef's change signal. */
  seq: number;
}

/**
 * Cache key for a file-list row: `s:`/`u:` side prefix + path,
 * mirroring the Changes list exactly (a partially staged file has two
 * rows, two entries).
 */
export function workingDiffKey(file: FileEntry): string {
  return `${file.staged ? 's' : 'u'}:${file.path}`;
}

/**
 * Memoize buildDiffModel per DiffResult object: identity-preserved
 * entries (unchanged raw -> same DiffResult) re-run nothing. Module
 * scope on purpose — keyed by object identity, safe across stores.
 * One map per side: every cached DiffResult today belongs to exactly
 * one side (each entry's object comes from its own side's fetch or
 * tree split), but keying by side too makes a both-sides call safe
 * instead of silently returning the other side's model.
 */
const diffModelMemos = {
  staged: new WeakMap<DiffResult, DiffModel>(),
  unstaged: new WeakMap<DiffResult, DiffModel>(),
};

/** The last snapshot workingDiffs changed-set diffing compares against. */
interface WorkingSnapshot {
  files: Map<string, FileEntry>;
  mtimes: Record<string, number> | null;
  hunkCounts: WireHunkCounts | null;
}

/**
 * The single state a lost daemon connection collapses into. Set once
 * (never spammed) so the header shows one calm line while recovery runs
 * in the background; cleared when a fresh snapshot arrives.
 */
export const CONNECTION_LOST_MESSAGE = 'daemon connection lost — reconnecting…';

function initialShared(): RepoSharedState {
  return {
    status: null,
    hunkCounts: null,
    stashList: [],
    operationInProgress: null,
    mtimes: null,
    error: null,
    isLoading: true,
  };
}

function initialSelection(): RepoSelectionState {
  return { file: null };
}

function initialHistory(): RepoHistoryState {
  return { commits: [], selectedCommit: null, commitDiff: null, isLoading: false };
}

function initialCompare(): RepoCompareState {
  return {
    compareDiff: null,
    baseBranch: null,
    loading: false,
    error: null,
    noBaseBranch: false,
    selection: { type: null, index: 0, diff: null },
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const useRepoStore = defineStore('repo', () => {
  const client = new DiffstalkerClient();

  // --- Reactive state (shallowRefs, whole-value replacement) ---

  const repoId = shallowRef<string | null>(null);
  const repoPath = shallowRef<string | null>(null);
  const shared = shallowRef<RepoSharedState>(initialShared());
  /**
   * Per-file working-diff cache (§2 of the diff-stream design). Whole
   * value replaced on every commit; the entries' DiffResults are
   * markRaw'd (deep-proxying thousands of line objects would dominate
   * reactivity cost) and identity-preserved when content is unchanged.
   */
  const workingDiffs = shallowRef<WorkingDiffsState>({ byKey: new Map(), seq: 0 });
  const selection = shallowRef<RepoSelectionState>(initialSelection());
  const history = shallowRef<RepoHistoryState>(initialHistory());
  const compare = shallowRef<RepoCompareState>(initialCompare());
  /**
   * The base branch the compare view reads against, per-client. Null
   * means "let the daemon detect one". Sent as GET /compare?base=… —
   * never persisted daemon-side (the viewer mutates nothing).
   */
  const selectedCompareBase = shallowRef<string | null>(null);

  const isRepo = computed(() => repoId.value !== null);

  // --- Non-reactive internals ---

  let generation = 0;
  /**
   * The repo id whose daemon-side ref this store currently holds — the
   * last successful open's ref, not yet released. Tracked separately
   * from repoId because open() nulls repoId up front: during rapid
   * open churn (open A, open B before A resolves) repoId is already
   * null when the second open starts, but the previously held ref
   * still must be released after the next successful open.
   */
  let heldRepoId: string | null = null;
  let subscription: SseHandle | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let recovering = false;
  let historyPullInFlight = false;
  let lastIncludeUncommitted = false;
  let historyCount = 100;
  /**
   * Monotonic refreshCompare sequence: each request captures the counter
   * and only the latest one may apply its response, so a slow older pull
   * (e.g. uncommitted ON) landing after a fast newer one (uncommitted
   * OFF) cannot overwrite the state the UI's controls reflect.
   */
  let compareRequestSeq = 0;
  /**
   * True once refreshAllDiffs has run for this repo: only then do
   * state-changes cascade into per-file cache refetches (mirrors
   * history/compare, which also re-pull only once loaded).
   */
  let workingDiffsActive = false;
  /** Single-flight guard for the snapshot-triggered activation pull. */
  let workingDiffsPullInFlight = false;
  /**
   * Monotonic count of applied wire states. The activation pull
   * captures it before its whole-tree fetch: a state-change applied
   * WHILE the pull was in flight missed the changed-set cascade (the
   * cache was still inactive), so an advanced counter afterwards means
   * that window must be re-diffed.
   */
  let appliedStateCount = 0;
  /**
   * Monotonic token shared by ALL working-diff fetches (whole-tree and
   * per-file), captured at request start. appliedSeqByKey records the
   * token whose response each entry currently holds; a response only
   * applies when no later-started request already landed on that key —
   * a stale response can never overwrite a newer entry.
   */
  let workingDiffFetchSeq = 0;
  const appliedSeqByKey = new Map<string, number>();
  /** Changed files coalescing in the 20ms refetch window, by row key. */
  const pendingChangedFiles = new Map<string, FileEntry>();
  let workingDiffsDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  /** The previous wire state's slice the changed-set diffing reads. */
  let workingSnapshot: WorkingSnapshot | null = null;

  function clearTimers(): void {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (workingDiffsDebounceTimer) {
      clearTimeout(workingDiffsDebounceTimer);
      workingDiffsDebounceTimer = null;
    }
  }

  // --- Lifecycle ---

  /**
   * Open a repo — the SOLE place a repo ref is taken (POST /repos) — and
   * subscribe to its SSE stream. Resets all per-repo state first. After a
   * successful open, the previous repo's ref is released: net-zero on a
   * switch (release old, hold new) AND on a re-open of the same repo (the
   * POST bumped it to 2, the release brings it back to 1). A superseded
   * open (a newer open() started while this one's POST was in flight)
   * releases the ref it just acquired instead — no refcount leaks under
   * churn. Returns the opened ref, or null when the open failed or was
   * superseded. When the daemon refuses the path, the store lands in
   * not-a-repo mode: repoId stays null, the reason sits in shared.error,
   * and every operation below no-ops. A connection error routes into the
   * reconnect loop instead.
   */
  async function open(path: string): Promise<RepoRef | null> {
    const gen = ++generation;
    // Adopt a directly-assigned repoId (tests) into the held tracking.
    heldRepoId ??= repoId.value;
    subscription?.close();
    subscription = null;
    clearTimers();
    recovering = false;
    historyPullInFlight = false;
    lastIncludeUncommitted = false;
    historyCount = 100;

    workingDiffsActive = false;
    workingSnapshot = null;
    appliedSeqByKey.clear();
    pendingChangedFiles.clear();

    repoId.value = null;
    repoPath.value = path;
    shared.value = initialShared();
    workingDiffs.value = { byKey: new Map(), seq: 0 };
    selection.value = initialSelection();
    history.value = initialHistory();
    compare.value = initialCompare();
    selectedCompareBase.value = null;

    try {
      const ref = await client.openRepo(path);
      if (gen !== generation) {
        // Superseded by a newer open(): release the ref THIS call just
        // acquired — the newer open owns releasing whatever is held.
        client.closeRepo(ref.id).catch(() => {});
        return null;
      }
      if (heldRepoId !== null) {
        // Release the prior ref (fire-and-forget): the switch (or same-repo
        // re-open) must not leak a daemon-side refcount.
        client.closeRepo(heldRepoId).catch(() => {});
      }
      heldRepoId = ref.id;
      repoId.value = ref.id;
      repoPath.value = ref.path;
      connect();
      return ref;
    } catch (err) {
      if (gen !== generation) return null;
      if (isConnectionError(err)) {
        // Daemon unreachable mid-open: one calm line + background retry,
        // not a raw transport error with no recovery.
        handleConnectionLoss();
        return null;
      }
      shared.value = { ...shared.value, error: errorMessage(err), isLoading: false };
      return null;
    }
  }

  /** Subscribe to the repo's SSE stream. No-op in not-a-repo mode. */
  function connect(): void {
    if (repoId.value === null) return;
    subscription?.close();
    subscription = client.subscribeRepo(repoId.value, {
      onSnapshot: (state) => applyWireState(state),
      onStateChange: (state) => applyWireState(state),
      // An EventSource error IS the connection-down signal; recovery is
      // managed here (close + retry loop), not by the browser's auto-retry,
      // because a restarted daemon needs the repo re-POSTed first.
      onError: () => handleConnectionLoss(),
    });
  }

  /**
   * Unsubscribe and release the daemon-side refcount. The store can be
   * reused afterwards via open().
   */
  async function dispose(): Promise<void> {
    const gen = ++generation;
    subscription?.close();
    subscription = null;
    clearTimers();
    recovering = false;
    const id = repoId.value ?? heldRepoId;
    heldRepoId = null;
    if (id !== null) {
      await client.closeRepo(id).catch(() => {});
      if (gen !== generation) return;
      repoId.value = null;
    }
  }

  // --- Reconnect (single-flight, no daemon spawn) ---

  function handleConnectionLoss(): void {
    subscription?.close();
    subscription = null;
    // Set the message exactly once so the header doesn't flicker on every
    // failed call; recovery clears it when a fresh snapshot lands. Also
    // drop isLoading so a pre-first-snapshot drop doesn't leave a view
    // stuck on a loading state beside the error line.
    if (shared.value.error !== CONNECTION_LOST_MESSAGE) {
      shared.value = { ...shared.value, error: CONNECTION_LOST_MESSAGE, isLoading: false };
    }
    scheduleRecovery();
  }

  function scheduleRecovery(): void {
    if (recovering || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void recover(); // catches internally, never rejects
    }, RECONNECT_DELAY_MS);
  }

  /**
   * Single-flight recovery: re-POST /repos (a restarted daemon has an
   * empty registry; the path-hashed id is stable), resubscribe, and apply
   * a fresh /status snapshot — which clears the connection error. On any
   * failure, keep the error and retry. Never throws.
   *
   * The re-POST deliberately does NOT release anything: against a
   * restarted daemon there is nothing to release, and against a
   * live-daemon blip the extra count is an accepted minor over-count
   * (matching the CLI's RepoSession).
   */
  async function recover(): Promise<void> {
    const path = repoPath.value;
    if (recovering || path === null) return;
    recovering = true;
    const gen = generation;
    try {
      const ref = await client.openRepo(path);
      if (gen !== generation) return;
      // Track the ref when nothing was held (a held id stays: it is a
      // still-unreleased older repo the next successful open releases).
      heldRepoId ??= ref.id;
      repoId.value = ref.id;
      connect();
      const state = await client.status(ref.id);
      if (gen !== generation) return;
      applyWireState(state);
    } catch {
      // Still down (or down again mid-recovery): keep the error, retry.
      recovering = false;
      if (gen === generation) scheduleRecovery();
      return;
    }
    recovering = false;
  }

  // --- Shared state ---

  /**
   * THE single sink: applies a wire state (SSE snapshot/state-change),
   * then cascades — re-anchor the selection, keep the working-diff
   * cache warm (activating it on the first snapshot), re-pull
   * history/compare when already loaded.
   */
  function applyWireState(wire: WireSharedState): void {
    appliedStateCount += 1;
    const prevSnapshot = workingSnapshot;
    workingSnapshot = snapshotWorkingState(wire);
    shared.value = {
      status: wire.status,
      hunkCounts: wire.hunkCounts,
      stashList: wire.stashList,
      operationInProgress: wire.operationInProgress,
      mtimes: wire.mtimes,
      error: wire.error,
      isLoading: false,
    };
    refreshSelectionAfterStatus();
    if (workingDiffsActive) {
      updateWorkingDiffsAfterState(prevSnapshot);
    } else {
      // First snapshot (or an earlier activation failed): pull the whole
      // tree so the stacked Changes surface has diffs from the start.
      void activateWorkingDiffs(); // catches internally; never rejects
    }
    if (history.value.commits.length > 0) {
      void reloadHistory();
    }
    if (compare.value.compareDiff !== null && !compare.value.loading) {
      void refreshCompare(lastIncludeUncommitted);
    }
  }

  /** Surface an error in the UI; cleared by the next applied state. */
  function setError(message: string): void {
    shared.value = { ...shared.value, error: message };
  }

  /**
   * Run a daemon read. On connection loss: enter the reconnect state and
   * resolve to `fallback` — never throw into a view. A DaemonError
   * propagates to the caller's own error handling.
   */
  async function read<T>(op: () => Promise<T>, fallback: T): Promise<T> {
    const gen = generation;
    try {
      return await op();
    } catch (err) {
      // Repo switched (open()) while this read was in flight: drop it silently
      // so a stale failure can't touch the new repo's state.
      if (gen !== generation) return fallback;
      if (isConnectionError(err)) {
        handleConnectionLoss();
        return fallback;
      }
      throw err;
    }
  }

  /** Pull fresh shared state from the daemon. */
  async function refresh(): Promise<void> {
    const id = repoId.value;
    if (id === null) return;
    const gen = generation;
    shared.value = { ...shared.value, isLoading: true };
    try {
      const state = await client.status(id);
      if (gen !== generation) return;
      applyWireState(state);
    } catch (err) {
      if (gen !== generation) return;
      shared.value = { ...shared.value, isLoading: false };
      if (isConnectionError(err)) {
        handleConnectionLoss();
        return;
      }
      setError(`Failed to refresh: ${errorMessage(err)}`);
    }
  }

  // --- File selection (active file only) ---

  /**
   * Record the active file — auto mode's anchor and the list's
   * re-anchoring target. Fetches NOTHING: the stacked Changes surface
   * reads per-file diffs from workingDiffs.
   */
  function selectFile(file: FileEntry | null): void {
    selection.value = { file };
  }

  /**
   * After fresh status arrives, re-anchor the selection to the matching
   * entry in the new file list (preferring the same staged side). A
   * vanished file clears the selection.
   */
  function refreshSelectionAfterStatus(): void {
    const selected = selection.value.file;
    const status = shared.value.status;
    if (!selected || !status) return;

    const match =
      status.files.find((f) => f.path === selected.path && f.staged === selected.staged) ??
      status.files.find((f) => f.path === selected.path);
    selection.value = match ? { file: match } : initialSelection();
  }

  // --- Working-diff cache (per-file, stacked Changes surface) ---

  function snapshotWorkingState(wire: WireSharedState): WorkingSnapshot {
    return {
      files: new Map((wire.status?.files ?? []).map((f) => [workingDiffKey(f), f])),
      mtimes: wire.mtimes,
      hunkCounts: wire.hunkCounts,
    };
  }

  /**
   * Replace the cache map immutably; the shallowRef signals on every
   * commit. mutate returns false to skip the commit entirely (no
   * reactive churn when nothing changed).
   */
  function commitWorkingDiffs(mutate: (byKey: Map<string, WorkingDiffEntry>) => boolean): void {
    const prev = workingDiffs.value;
    const byKey = new Map(prev.byKey);
    if (!mutate(byKey)) return;
    workingDiffs.value = { byKey, seq: prev.seq + 1 };
  }

  /**
   * Land one per-file response. Drops stale responses (a later-started
   * request already applied to this key), drops keys that left the
   * status set while the fetch was in flight, and preserves identity:
   * an unchanged raw keeps the SAME entry — same DiffResult object, no
   * commit, no reactive signal.
   */
  function applyWorkingDiff(key: string, token: number, diff: DiffResult): void {
    if ((appliedSeqByKey.get(key) ?? 0) > token) return;
    if (workingSnapshot !== null && !workingSnapshot.files.has(key)) return;
    appliedSeqByKey.set(key, token);
    const cached = workingDiffs.value.byKey.get(key);
    if (cached && cached.raw === diff.raw) return;
    commitWorkingDiffs((byKey) => {
      byKey.set(key, { raw: diff.raw, diff: markRaw(diff), fetchedAt: Date.now() });
      return true;
    });
  }

  /**
   * Fetch per-file diffs through a bounded queue (concurrency 6).
   * Untracked files fetch without a staged flag — the daemon 400s
   * staged=true for them. Never rejects; errors collapse like the
   * selection fetch (connection loss -> reconnect, else shared.error).
   */
  async function fetchWorkingDiffsFor(files: FileEntry[]): Promise<void> {
    const id = repoId.value;
    if (id === null || files.length === 0) return;
    const gen = generation;
    const queue = [...files];
    let lost = false;
    // ONE setError per batch (like the whole-tree pull), not one per
    // failed file — N failures would rewrite shared.error N times.
    let firstFailure: string | null = null;
    const worker = async (): Promise<void> => {
      for (;;) {
        const file = queue.shift();
        if (!file || lost || gen !== generation) return;
        const key = workingDiffKey(file);
        const token = ++workingDiffFetchSeq;
        try {
          const diff =
            file.status === 'untracked'
              ? await client.diff(id, { path: file.path })
              : await client.diff(id, { path: file.path, staged: file.staged });
          if (gen !== generation) return;
          applyWorkingDiff(key, token, diff);
        } catch (err) {
          if (gen !== generation) return;
          if (isConnectionError(err)) {
            lost = true;
            handleConnectionLoss();
            return;
          }
          firstFailure ??= errorMessage(err);
        }
      }
    };
    const workers = Array.from(
      { length: Math.min(WORKING_DIFF_CONCURRENCY, queue.length) },
      () => worker() // catches internally; never rejects
    );
    await Promise.all(workers);
    if (firstFailure !== null && !lost && gen === generation) {
      setError(`Failed to load diffs: ${firstFailure}`);
    }
  }

  /**
   * The snapshot-triggered activation: one refreshAllDiffs at a time.
   * Runs on every applied wire state while the cache is inactive, so a
   * failed activation (daemon hiccup) retries on the next snapshot /
   * state-change instead of silently staying empty. QUIET on daemon
   * errors: this passive warm-up must not overwrite a fresher wire
   * error on every retry — the stack just keeps its placeholders until
   * a pull lands. (Connection errors still enter the reconnect loop.)
   */
  async function activateWorkingDiffs(): Promise<void> {
    if (workingDiffsPullInFlight || repoId.value === null) return;
    workingDiffsPullInFlight = true;
    const gen = generation;
    const snapshotBefore = workingSnapshot;
    const countBefore = appliedStateCount;
    try {
      await refreshAllDiffs({ quiet: true }); // catches internally; never rejects
    } finally {
      workingDiffsPullInFlight = false;
    }
    // A state-change applied while the whole-tree pull was in flight
    // missed the changed-set cascade (the cache was still inactive):
    // re-run it across that window so the fresh edit isn't served from
    // the stale tree. Quiet like the pull; skipped when the activation
    // failed (the next state retries the whole pull anyway).
    if (gen !== generation || !workingDiffsActive) return;
    if (appliedStateCount !== countBefore) {
      updateWorkingDiffsAfterState(snapshotBefore);
    }
  }

  /**
   * Activate (or fully re-pull) the cache: two whole-tree pulls —
   * GET /diff (unstaged) and GET /diff?staged=true — split client-side
   * into per-file entries, then untracked files (absent from git diff)
   * fetched per-file through the bounded queue. Applies in ONE commit;
   * evicts entries whose file left the status set; value-equal raws
   * keep their objects (stale-while-revalidate — nothing ever blanks).
   * `quiet` keeps a daemon error out of shared.error (the activation
   * retry path); explicit calls surface it.
   */
  async function refreshAllDiffs(opts: { quiet?: boolean } = {}): Promise<void> {
    const id = repoId.value;
    if (id === null) return;
    const gen = generation;
    const token = ++workingDiffFetchSeq;
    let unstagedTree: DiffResult;
    let stagedTree: DiffResult;
    try {
      [unstagedTree, stagedTree] = await Promise.all([
        client.diff(id, {}),
        client.diff(id, { staged: true }),
      ]);
    } catch (err) {
      // Activation stays off on failure: an active-but-empty cache would
      // only refetch CHANGED files on later state-changes, silently
      // staying partial. Inactive, the next refreshAllDiffs re-pulls all.
      if (gen !== generation) return;
      if (isConnectionError(err)) {
        handleConnectionLoss();
        return;
      }
      if (!opts.quiet) setError(`Failed to load diffs: ${errorMessage(err)}`);
      return;
    }
    if (gen !== generation) return;
    workingDiffsActive = true;

    const files = shared.value.status?.files ?? [];
    const validKeys = new Set(files.map(workingDiffKey));
    commitWorkingDiffs((byKey) => {
      let dirty = applyTreeSide(byKey, 'u', splitDiffByFile(unstagedTree), validKeys, token);
      dirty = applyTreeSide(byKey, 's', splitDiffByFile(stagedTree), validKeys, token) || dirty;
      for (const key of [...byKey.keys()]) {
        if (!validKeys.has(key)) {
          byKey.delete(key);
          appliedSeqByKey.delete(key);
          dirty = true;
        }
      }
      return dirty;
    });

    await fetchWorkingDiffsFor(files.filter((f) => f.status === 'untracked'));
  }

  /**
   * Merge one side of a split whole-tree pull into the map: keys must
   * still be in the status set, later-started per-file pulls win (seq),
   * value-equal raws keep their objects. Returns whether anything moved.
   */
  function applyTreeSide(
    byKey: Map<string, WorkingDiffEntry>,
    side: 's' | 'u',
    byPath: Map<string, DiffResult>,
    validKeys: Set<string>,
    token: number
  ): boolean {
    let dirty = false;
    for (const [path, diff] of byPath) {
      const key = `${side}:${path}`;
      if (!validKeys.has(key)) continue;
      if ((appliedSeqByKey.get(key) ?? 0) > token) continue; // a newer per-file pull landed
      appliedSeqByKey.set(key, token);
      const cached = byKey.get(key);
      if (cached && cached.raw === diff.raw) continue; // identity preserved
      byKey.set(key, { raw: diff.raw, diff: markRaw(diff), fetchedAt: Date.now() });
      dirty = true;
    }
    return dirty;
  }

  /**
   * The state-change cascade: evict entries whose file left the status
   * set, then refetch ONLY the files the new wire state marks as
   * changed (vs the previous snapshot). Past the threshold, one
   * whole-tree re-pull replaces N per-file fetches (branch switch).
   */
  function updateWorkingDiffsAfterState(prev: WorkingSnapshot | null): void {
    const next = workingSnapshot;
    if (next === null) return;

    const leaving = [...workingDiffs.value.byKey.keys()].filter((key) => !next.files.has(key));
    if (leaving.length > 0) {
      commitWorkingDiffs((byKey) => {
        for (const key of leaving) {
          byKey.delete(key);
          appliedSeqByKey.delete(key);
        }
        return true;
      });
    }
    for (const key of [...pendingChangedFiles.keys()]) {
      if (!next.files.has(key)) pendingChangedFiles.delete(key);
    }

    const changed = computeChangedFiles(prev, next);
    if (changed.length === 0) return;
    if (changed.length > WHOLE_TREE_REPULL_THRESHOLD) {
      pendingChangedFiles.clear();
      void refreshAllDiffs(); // catches internally; never rejects
      return;
    }
    scheduleWorkingDiffRefetch(changed);
  }

  /**
   * The changed set: files entering the status set, plus files whose
   * mtime, hunk count (their own side), or status letter moved since
   * the previous snapshot.
   */
  function computeChangedFiles(prev: WorkingSnapshot | null, next: WorkingSnapshot): FileEntry[] {
    const changed: FileEntry[] = [];
    for (const [key, file] of next.files) {
      const prevFile = prev?.files.get(key);
      if (!prevFile) {
        changed.push(file); // entering
        continue;
      }
      const mtimeChanged = next.mtimes?.[file.path] !== prev?.mtimes?.[file.path];
      const hunksChanged =
        hunkCountOf(next.hunkCounts, file) !== hunkCountOf(prev?.hunkCounts ?? null, file);
      if (mtimeChanged || hunksChanged || prevFile.status !== file.status) {
        changed.push(file);
      }
    }
    return changed;
  }

  function hunkCountOf(counts: WireHunkCounts | null, file: FileEntry): number {
    if (!counts) return 0;
    const side = file.staged ? counts.staged : counts.unstaged;
    return side[file.path] ?? 0;
  }

  /** Coalesce changed files for 20ms, then refetch them per-file. */
  function scheduleWorkingDiffRefetch(files: FileEntry[]): void {
    for (const file of files) {
      pendingChangedFiles.set(workingDiffKey(file), file);
    }
    if (workingDiffsDebounceTimer) return;
    workingDiffsDebounceTimer = setTimeout(() => {
      workingDiffsDebounceTimer = null;
      const batch = [...pendingChangedFiles.values()];
      pendingChangedFiles.clear();
      void fetchWorkingDiffsFor(batch); // catches internally; never rejects
    }, DIFF_DEBOUNCE_MS);
  }

  /**
   * buildDiffModel through the WeakMap memo: an identity-preserved
   * DiffResult returns the identical DiffModel — unchanged files
   * re-run nothing and keep their vnodes. `staged` MUST match the
   * entry's side (the cache key's `s:`/`u:` prefix): it feeds the
   * model's section keys, so a wrong flag would collide a partially
   * staged file's two sections.
   */
  function diffModelFor(diff: DiffResult, staged: boolean): DiffModel {
    const memo = staged ? diffModelMemos.staged : diffModelMemos.unstaged;
    const cached = memo.get(diff);
    if (cached) return cached;
    const model = buildDiffModel(diff, staged);
    memo.set(diff, model);
    return model;
  }

  // --- History ---

  async function loadHistory(count: number = 100): Promise<void> {
    const id = repoId.value;
    if (id === null) return;
    const gen = generation;
    historyCount = count;
    history.value = { ...history.value, isLoading: true };
    try {
      const commits = await client.history(id, count);
      if (gen !== generation) return;
      history.value = { commits, selectedCommit: null, commitDiff: null, isLoading: false };
    } catch (err) {
      if (gen !== generation) return;
      history.value = { ...history.value, isLoading: false };
      if (isConnectionError(err)) {
        handleConnectionLoss();
        return;
      }
      throw err;
    }
  }

  /** Cascade re-pull after a state-change; errors stay out of the UI. */
  async function reloadHistory(): Promise<void> {
    if (historyPullInFlight) return;
    historyPullInFlight = true;
    try {
      await loadHistory(historyCount);
    } catch {
      // Transient (e.g. mid-rebase): keep the previous commits visible.
    } finally {
      historyPullInFlight = false;
    }
  }

  async function selectHistoryCommit(commit: CommitInfo | null): Promise<void> {
    history.value = { ...history.value, selectedCommit: commit, commitDiff: null };
    const id = repoId.value;
    if (!commit || id === null) return;
    const gen = generation;

    const diff = await read<DiffResult | null>(() => client.commitDiff(id, commit.hash), null);
    if (diff === null || gen !== generation) return;
    if (history.value.selectedCommit === commit) {
      history.value = { ...history.value, commitDiff: diff };
    }
  }

  // --- Compare ---

  /** The include-uncommitted flag of the most recent compare pull — lets
   * the view's toggle survive a tab switch (the ref is component-local). */
  function getLastIncludeUncommitted(): boolean {
    return lastIncludeUncommitted;
  }

  /**
   * Re-anchor a file selection by path after the file set changed: same
   * file → its new index + diff; file gone → selection cleared so the
   * highlight cannot land on a different file.
   */
  function reanchoredCompareSelection(
    prev: RepoCompareState,
    next: CompareDiff
  ): CompareSelectionState {
    const sel = prev.selection;
    if (sel.type !== 'file') return sel;
    const path = prev.compareDiff?.files[sel.index]?.path;
    const index = path === undefined ? -1 : next.files.findIndex((f) => f.path === path);
    if (index === -1) return { type: null, index: 0, diff: null };
    return { type: 'file', index, diff: next.files[index].diff };
  }

  async function refreshCompare(includeUncommitted: boolean = false): Promise<void> {
    lastIncludeUncommitted = includeUncommitted;
    const id = repoId.value;
    if (id === null) return;
    const gen = generation;
    const seq = ++compareRequestSeq;
    compare.value = { ...compare.value, loading: true, error: null, noBaseBranch: false };
    try {
      const diff = await client.compare(id, {
        base: selectedCompareBase.value ?? undefined,
        uncommitted: includeUncommitted,
      });
      if (gen !== generation || seq !== compareRequestSeq) return;
      compare.value = {
        ...compare.value,
        compareDiff: diff,
        baseBranch: diff.baseBranch,
        loading: false,
        noBaseBranch: false,
        selection: reanchoredCompareSelection(compare.value, diff),
      };
    } catch (err) {
      if (gen !== generation || seq !== compareRequestSeq) return;
      applyCompareFailure(err);
    }
  }

  function applyCompareFailure(err: unknown): void {
    if (isConnectionError(err)) {
      compare.value = { ...compare.value, loading: false };
      handleConnectionLoss();
      return;
    }
    // A 422 means the daemon found no base branch to compare against
    // (base detection only considers remote refs). That is a normal
    // state, not a failure — flag it so the view shows a truthful
    // message instead of the generic error banner.
    if (err instanceof DaemonError && err.status === 422) {
      compare.value = {
        ...compare.value,
        compareDiff: null,
        baseBranch: null,
        loading: false,
        error: null,
        noBaseBranch: true,
      };
      return;
    }
    compare.value = {
      ...compare.value,
      loading: false,
      error: `Failed to load compare diff: ${errorMessage(err)}`,
    };
  }

  async function getCandidateBaseBranches(): Promise<string[]> {
    const id = repoId.value;
    if (id === null) return [];
    return read<string[]>(() => client.baseBranches(id), []);
  }

  /**
   * Pick the base the compare view reads against (read-only: rides the
   * next GET /compare as ?base=…, never persisted daemon-side) and
   * re-pull with it.
   */
  async function setSelectedCompareBase(
    branch: string,
    includeUncommitted: boolean = false
  ): Promise<void> {
    selectedCompareBase.value = branch;
    await refreshCompare(includeUncommitted);
  }

  async function selectCompareCommit(index: number): Promise<void> {
    const compareDiff = compare.value.compareDiff;
    const id = repoId.value;
    if (!compareDiff || index < 0 || index >= compareDiff.commits.length || id === null) {
      compare.value = { ...compare.value, selection: { type: null, index: 0, diff: null } };
      return;
    }

    const commit = compareDiff.commits[index];
    compare.value = { ...compare.value, selection: { type: 'commit', index, diff: null } };
    const gen = generation;

    const diff = await read<DiffResult | null>(() => client.commitDiff(id, commit.hash), null);
    if (diff === null || gen !== generation) return;
    const current = compare.value.selection;
    if (current.type === 'commit' && current.index === index) {
      compare.value = { ...compare.value, selection: { ...current, diff } };
    }
  }

  function selectCompareFile(index: number): void {
    const compareDiff = compare.value.compareDiff;
    if (!compareDiff || index < 0 || index >= compareDiff.files.length) {
      compare.value = { ...compare.value, selection: { type: null, index: 0, diff: null } };
      return;
    }
    compare.value = {
      ...compare.value,
      selection: { type: 'file', index, diff: compareDiff.files[index].diff },
    };
  }

  // --- Worktrees / explorer sources ---

  async function listWorktrees(): Promise<WorktreeInfo[]> {
    const id = repoId.value;
    if (id === null) return [];
    return read<WorktreeInfo[]>(() => client.worktrees(id), []);
  }

  return {
    // reactive state
    repoId,
    repoPath,
    isRepo,
    shared,
    workingDiffs,
    selection,
    history,
    compare,
    selectedCompareBase,
    // lifecycle
    open,
    dispose,
    refresh,
    setError,
    // selection
    selectFile,
    // working-diff cache
    refreshAllDiffs,
    diffModelFor,
    // history
    loadHistory,
    selectHistoryCommit,
    // compare
    refreshCompare,
    getLastIncludeUncommitted,
    getCandidateBaseBranches,
    setSelectedCompareBase,
    selectCompareCommit,
    selectCompareFile,
    // worktrees
    listWorktrees,
  };
});
