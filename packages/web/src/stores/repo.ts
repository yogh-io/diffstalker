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
 * - selection (file + its diffs) is per-client and fetched on demand via
 *   GET /diff, with the 20ms leading+trailing debounce + identity
 *   stale-guard ported verbatim;
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

import { computed, shallowRef } from 'vue';
import { defineStore } from 'pinia';
import { DiffstalkerClient } from '../api/client';
import { DaemonError, isConnectionError } from '../api/errors';
import type { SseHandle } from '../api/transport';
import type { RepoRef, WireSharedState } from '@diffstalker/client';
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

/** How long two selectFile calls coalesce into one diff fetch. */
const DIFF_DEBOUNCE_MS = 20;

/** Delay before a reconnect attempt after the SSE stream drops. */
const RECONNECT_DELAY_MS = 1000;

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
    error: null,
    isLoading: true,
  };
}

function initialSelection(): RepoSelectionState {
  return { file: null, diff: null, combined: null };
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
  let diffDebounceTimer: ReturnType<typeof setTimeout> | null = null;
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

  function clearTimers(): void {
    if (diffDebounceTimer) {
      clearTimeout(diffDebounceTimer);
      diffDebounceTimer = null;
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
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

    repoId.value = null;
    repoPath.value = path;
    shared.value = initialShared();
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
   * then cascades — re-anchor the selection and re-fetch its diff,
   * re-pull history/compare when already loaded.
   */
  function applyWireState(wire: WireSharedState): void {
    shared.value = {
      status: wire.status,
      hunkCounts: wire.hunkCounts,
      stashList: wire.stashList,
      operationInProgress: wire.operationInProgress,
      error: wire.error,
      isLoading: false,
    };
    refreshSelectionAfterStatus();
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

  // --- File selection (ported 20ms debounce + identity stale-guard) ---

  /**
   * Select a file and fetch its diff(s). Rapid successive calls coalesce:
   * the first fetch fires immediately (leading), further calls within the
   * window replace the trailing fetch.
   */
  function selectFile(file: FileEntry | null): void {
    selection.value = { ...selection.value, file };
    if (repoId.value === null) return;
    scheduleDiffFetch();
  }

  function scheduleDiffFetch(): void {
    if (diffDebounceTimer) {
      clearTimeout(diffDebounceTimer);
      diffDebounceTimer = setTimeout(() => {
        diffDebounceTimer = null;
        void fetchDiffForSelection(); // catches internally; never rejects
      }, DIFF_DEBOUNCE_MS);
    } else {
      void fetchDiffForSelection(); // catches internally; never rejects
      diffDebounceTimer = setTimeout(() => {
        diffDebounceTimer = null;
      }, DIFF_DEBOUNCE_MS);
    }
  }

  async function fetchDiffForSelection(): Promise<void> {
    const gen = generation;
    const file = selection.value.file;
    try {
      await doFetchDiffForFile(file);
    } catch (err) {
      // Repo switched mid-fetch: drop, so a stale diff failure can't set an
      // error banner or trigger a reconnect against the newly-opened repo.
      if (gen !== generation) return;
      if (isConnectionError(err)) {
        handleConnectionLoss();
        return;
      }
      setError(`Failed to load diff: ${errorMessage(err)}`);
    }
  }

  async function doFetchDiffForFile(file: FileEntry | null): Promise<void> {
    const id = repoId.value;
    if (id === null) return;
    const gen = generation;

    if (!file) {
      // No selection: show the whole-tree staged diff.
      const diff = await client.diff(id, { staged: true });
      if (gen === generation && selection.value.file === null) {
        selection.value = { ...selection.value, diff, combined: null };
      }
      return;
    }

    if (file.status === 'untracked') {
      // Single fetch, and never staged=true — the daemon 400s a staged
      // diff request for an untracked file.
      const diff = await client.diff(id, { path: file.path });
      if (gen === generation && file === selection.value.file) {
        selection.value = {
          ...selection.value,
          diff,
          combined: { unstaged: diff, staged: { raw: '', lines: [] } },
        };
      }
      return;
    }

    const [unstaged, staged] = await Promise.all([
      client.diff(id, { path: file.path, staged: false }),
      client.diff(id, { path: file.path, staged: true }),
    ]);
    if (gen === generation && file === selection.value.file) {
      selection.value = {
        ...selection.value,
        diff: file.staged ? staged : unstaged,
        combined: { unstaged, staged },
      };
    }
  }

  /**
   * After fresh status arrives, re-anchor the selection to the matching
   * entry in the new file list (preferring the same staged side) and
   * re-fetch its diff. A vanished file clears the selection.
   */
  function refreshSelectionAfterStatus(): void {
    const selected = selection.value.file;
    const status = shared.value.status;
    if (!selected || !status) return;

    const match =
      status.files.find((f) => f.path === selected.path && f.staged === selected.staged) ??
      status.files.find((f) => f.path === selected.path);
    if (!match) {
      selection.value = initialSelection();
      return;
    }

    selection.value = { ...selection.value, file: match };
    scheduleDiffFetch();
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
