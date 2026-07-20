/**
 * RepoSession: the TUI's client-side store for one open repository on
 * diffstalkerd.
 *
 * One honest store instead of a mimic of the old four-manager split:
 * - shared state (status, hunk counts, stash list, in-progress op, error)
 *   is fed by the per-repo SSE stream and by mutation response envelopes;
 * - selection (file + its diffs) is per-client and fetched on demand via
 *   GET /diff, with the 20ms debounce + stale-guard ported from the old
 *   WorkingTreeManager.selectFile;
 * - history and compare are pulled on demand and re-pulled on state-change
 *   when previously loaded (the old cascade refresh, client-side);
 * - remote operation state (cherry-pick/revert progress) is synthesized
 *   locally around the mutation call — there is no remote SSE channel.
 *
 * Mutations apply the response envelope's `state` through the same path
 * as SSE events (so selection anchors are consumed against fresh status)
 * and swallow failures into shared.error — they never throw to the UI.
 *
 * All getters return cached state synchronously (blessed renders
 * synchronously); nothing here ever hands the UI a promise.
 *
 * Reconnect: when the SSE stream drops, the session surfaces the outage
 * in shared.error and retries by re-POSTing /repos (a daemon restart
 * empties its registry; the path-hashed id is stable) and resubscribing.
 */

import { EventEmitter } from 'node:events';
import { isConnectionError } from '@diffstalker/client';
import type {
  DiffstalkerClient,
  MutationEnvelope,
  RepoSubscription,
  WireSharedState,
} from '@diffstalker/client';
import type { FileEntry, CommitInfo } from '@diffstalker/core/git/status';
import type { FileHunkCounts, DiffResult } from '@diffstalker/core/git/diff';
import type { WorktreeInfo } from '@diffstalker/core/git/worktree';
import type { RemoteOperationState, RemoteOperation } from '@diffstalker/core/types/remote';
import type {
  SessionSharedState,
  SessionSelectionState,
  HistoryState,
  SessionCompareState,
} from '../types/session.js';

/** How long two selectFile calls coalesce into one diff fetch. */
const DIFF_DEBOUNCE_MS = 20;

/** Delay before a reconnect attempt after the SSE stream drops. */
const RECONNECT_DELAY_MS = 1000;

const NOT_A_REPO_ERROR = 'Not a git repository';

/**
 * The single state a lost daemon connection collapses into. Set once (never
 * spammed) so the header shows one calm line while recovery runs in the
 * background; cleared when a fresh snapshot arrives.
 */
const CONNECTION_LOST_MESSAGE = 'daemon connection lost — reconnecting…';

type SessionEventMap = {
  'state-change': [];
  'history-change': [];
  'compare-change': [];
  'remote-change': [];
};

export interface RepoSessionOptions {
  /** Test hook: shrink the reconnect delay. */
  reconnectDelayMs?: number;
  /**
   * Initial shared error for a session that has no repo id (the daemon
   * refused to open the path). Defaults to "Not a git repository".
   */
  initialError?: string;
  /**
   * Re-establish the daemon during recovery: ensures diffstalkerd is alive
   * (spawns a fresh one when the socket is gone, attaches when it came back)
   * and returns the client to use afterwards. App wires this to
   * ensureDaemon(); when omitted, recovery just re-opens the repo on the
   * existing client (a live daemon that only dropped the SSE stream).
   */
  ensureDaemon?: () => Promise<DiffstalkerClient>;
}

/** Revive wire hunk counts (plain objects) into core's Map-based shape. */
function reviveHunkCounts(wire: WireSharedState['hunkCounts']): FileHunkCounts | null {
  if (!wire) return null;
  return {
    staged: new Map(Object.entries(wire.staged)),
    unstaged: new Map(Object.entries(wire.unstaged)),
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class RepoSession extends EventEmitter<SessionEventMap> {
  /** Normalized worktree root (or the raw path in not-a-repo mode). */
  readonly repoPath: string;

  private client: DiffstalkerClient;
  private id: string | null;
  private subscription: RepoSubscription | null = null;
  private disposed = false;
  private reconnectDelayMs: number;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private recovering = false;
  private ensureDaemonFn: (() => Promise<DiffstalkerClient>) | null;

  private diffDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private historyPullInFlight = false;
  private lastIncludeUncommitted = false;
  private historyCount = 100;

  private _shared: SessionSharedState = {
    status: null,
    hunkCounts: null,
    stashList: [],
    operationInProgress: null,
    error: null,
    isLoading: true,
  };

  private _selection: SessionSelectionState = { file: null, diff: null, combined: null };

  private _history: HistoryState = {
    commits: [],
    selectedCommit: null,
    commitDiff: null,
    isLoading: false,
  };

  private _compare: SessionCompareState = {
    compareDiff: null,
    baseBranch: null,
    loading: false,
    error: null,
    selection: { type: null, index: 0, diff: null },
  };

  private _remote: RemoteOperationState = {
    operation: null,
    inProgress: false,
    error: null,
    lastResult: null,
  };

  constructor(
    client: DiffstalkerClient,
    ref: { id: string | null; path: string },
    options: RepoSessionOptions = {}
  ) {
    super();
    this.client = client;
    this.id = ref.id;
    this.repoPath = ref.path;
    this.reconnectDelayMs = options.reconnectDelayMs ?? RECONNECT_DELAY_MS;
    this.ensureDaemonFn = options.ensureDaemon ?? null;

    if (this.id === null) {
      // Not-a-repo mode: nothing to subscribe to; the header renders the
      // error and every operation below no-ops on the null id.
      this._shared = {
        ...this._shared,
        error: options.initialError ?? NOT_A_REPO_ERROR,
        isLoading: false,
      };
    }
  }

  // --- State getters (synchronous, cached — blessed renders from these) ---

  get repoId(): string | null {
    return this.id;
  }

  get isRepo(): boolean {
    return this.id !== null;
  }

  get shared(): SessionSharedState {
    return this._shared;
  }

  get selection(): SessionSelectionState {
    return this._selection;
  }

  get history(): HistoryState {
    return this._history;
  }

  get compare(): SessionCompareState {
    return this._compare;
  }

  get remote(): RemoteOperationState {
    return this._remote;
  }

  // --- Lifecycle ---

  /** Subscribe to the repo's SSE stream. No-op in not-a-repo mode. */
  connect(): void {
    if (this.id === null || this.disposed) return;
    this.subscription?.close();
    const subscription = this.client.subscribeRepo(this.id);
    this.subscription = subscription;
    subscription.on('snapshot', (state) => this.applyWireState(state));
    subscription.on('state-change', (state) => this.applyWireState(state));
    // The stream ending server-side or erroring IS the connection-down
    // signal; both route into the single-flight recovery below.
    subscription.on('close', () => this.handleConnectionLoss('stream closed'));
    subscription.on('error', (err) => this.handleConnectionLoss(errorMessage(err)));
  }

  /**
   * Unsubscribe and release the daemon-side refcount. Safe to call once;
   * the returned promise resolves when the DELETE has been sent.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.removeAllListeners();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.diffDebounceTimer) clearTimeout(this.diffDebounceTimer);
    this.subscription?.close();
    this.subscription = null;
    if (this.id !== null) {
      await this.client.closeRepo(this.id).catch(() => {});
    }
  }

  /**
   * A transport/connection loss happened (SSE drop or a read/write hitting a
   * dead socket). Collapse it into ONE calm state — set once, never spammed —
   * and drive the single-flight recovery. Never throws, never logs: doing
   * either from the render loop garbles the blessed alt-screen.
   */
  private handleConnectionLoss(_reason: string): void {
    if (this.disposed) return;
    this.subscription?.close();
    this.subscription = null;
    // Set the message exactly once so the header doesn't flicker on every
    // failed keypress; recovery clears it when a fresh snapshot lands.
    if (this._shared.error !== CONNECTION_LOST_MESSAGE) {
      this._shared = { ...this._shared, error: CONNECTION_LOST_MESSAGE };
      this.emit('state-change');
    }
    this.scheduleRecovery();
  }

  private scheduleRecovery(): void {
    if (this.disposed || this.recovering || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.recover(); // single-flight; catches internally, never rejects
    }, this.reconnectDelayMs);
  }

  /**
   * Single-flight recovery: make sure diffstalkerd is alive (ensureDaemon
   * spawns/attaches), re-POST /repos (a restarted daemon has an empty
   * registry; the path-hashed id is stable), resubscribe the SSE stream, and
   * apply a fresh /status snapshot — which clears the connection error. On
   * any failure, keep the error and retry with backoff. Never throws/prints.
   */
  private async recover(): Promise<void> {
    if (this.disposed || this.recovering) return;
    this.recovering = true;
    try {
      if (this.ensureDaemonFn) {
        this.client = await this.ensureDaemonFn();
      }
      if (this.disposed) return;
      const ref = await this.client.openRepo(this.repoPath);
      if (this.disposed) return;
      this.id = ref.id;
      this.connect();
      // Fresh snapshot: applyWireState overwrites shared.error with the
      // daemon's (null on success), clearing the reconnect line, and cascades
      // the on-demand re-pulls (selection diff, history, compare) itself.
      this.applyWireState(await this.client.status(this.id));
    } catch {
      // Still down (or down again mid-recovery): keep the error, retry.
      this.recovering = false;
      this.scheduleRecovery();
      return;
    }
    this.recovering = false;
  }

  // --- Shared state ---

  /**
   * Apply a wire state (SSE snapshot/state-change or a mutation response
   * envelope), emit state-change, then keep the per-client surfaces in
   * step: re-fetch the selected file's diff and re-pull history/compare
   * when they were loaded (the old in-process cascade, client-side).
   */
  private applyWireState(wire: WireSharedState): void {
    this._shared = {
      status: wire.status,
      hunkCounts: reviveHunkCounts(wire.hunkCounts),
      stashList: wire.stashList,
      operationInProgress: wire.operationInProgress,
      error: wire.error,
      isLoading: false,
    };
    this.emit('state-change');
    this.refreshSelectionAfterStatus();
    if (this._history.commits.length > 0) {
      this.reloadHistory();
    }
    if (this._compare.compareDiff !== null && !this._compare.loading) {
      this.refreshCompare(this.lastIncludeUncommitted);
    }
  }

  /** Surface an error in the UI (header); cleared by the next state. */
  setError(message: string): void {
    this._shared = { ...this._shared, error: message };
    this.emit('state-change');
  }

  /**
   * Run a daemon read. On connection loss: enter the reconnect state, kick
   * off recovery, and resolve to `fallback` — never throw, never log, so a
   * keypress-triggered fetch can't crash or garble the UI. An HTTP
   * DaemonError propagates to the caller's own error handling.
   */
  private async read<T>(op: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await op();
    } catch (err) {
      if (isConnectionError(err)) {
        this.handleConnectionLoss(errorMessage(err));
        return fallback;
      }
      throw err;
    }
  }

  /** Pull fresh shared state from the daemon. */
  async refresh(): Promise<void> {
    if (this.id === null) return;
    this._shared = { ...this._shared, isLoading: true };
    this.emit('state-change');
    try {
      this.applyWireState(await this.client.status(this.id));
    } catch (err) {
      this._shared = { ...this._shared, isLoading: false };
      if (isConnectionError(err)) {
        this.handleConnectionLoss(errorMessage(err));
        return;
      }
      this.setError(`Failed to refresh: ${errorMessage(err)}`);
    }
  }

  // --- File selection (ported debounce + stale-guard) ---

  /**
   * Select a file and fetch its diff(s). Rapid successive calls (holding
   * j/k) coalesce: the first fetch fires immediately, further calls within
   * the debounce window replace the trailing fetch.
   */
  selectFile(file: FileEntry | null): void {
    this._selection = { ...this._selection, file };
    this.emit('state-change');

    if (this.id === null) return;
    this.scheduleDiffFetch();
  }

  private scheduleDiffFetch(): void {
    if (this.diffDebounceTimer) {
      clearTimeout(this.diffDebounceTimer);
      this.diffDebounceTimer = setTimeout(() => {
        this.diffDebounceTimer = null;
        this.fetchDiffForSelection(); // catches internally; never rejects
      }, DIFF_DEBOUNCE_MS);
    } else {
      this.fetchDiffForSelection(); // catches internally; never rejects
      this.diffDebounceTimer = setTimeout(() => {
        this.diffDebounceTimer = null;
      }, DIFF_DEBOUNCE_MS);
    }
  }

  private async fetchDiffForSelection(): Promise<void> {
    const file = this._selection.file;
    try {
      await this.doFetchDiffForFile(file);
    } catch (err) {
      if (isConnectionError(err)) {
        this.handleConnectionLoss(errorMessage(err));
        return;
      }
      this.setError(`Failed to load diff: ${errorMessage(err)}`);
    }
  }

  private async doFetchDiffForFile(file: FileEntry | null): Promise<void> {
    if (this.id === null) return;

    if (!file) {
      // No selection: show the whole-tree staged diff (old behavior).
      const diff = await this.client.diff(this.id, { staged: true });
      if (this._selection.file === null) {
        this._selection = { ...this._selection, diff, combined: null };
        this.emit('state-change');
      }
      return;
    }

    if (file.status === 'untracked') {
      // Single fetch, and never staged=true — the daemon 400s a staged
      // diff request for an untracked file.
      const diff = await this.client.diff(this.id, { path: file.path });
      if (file === this._selection.file) {
        this._selection = {
          ...this._selection,
          diff,
          combined: { unstaged: diff, staged: { raw: '', lines: [] } },
        };
        this.emit('state-change');
      }
      return;
    }

    const [unstaged, staged] = await Promise.all([
      this.client.diff(this.id, { path: file.path, staged: false }),
      this.client.diff(this.id, { path: file.path, staged: true }),
    ]);
    if (file === this._selection.file) {
      this._selection = {
        ...this._selection,
        diff: file.staged ? staged : unstaged,
        combined: { unstaged, staged },
      };
      this.emit('state-change');
    }
  }

  /**
   * After fresh status arrives, re-anchor the selection to the matching
   * entry in the new file list (preferring the same staged side) and
   * re-fetch its diff so the pane tracks on-disk edits. A vanished file
   * clears the selection; the UI reconciler then picks a neighbor.
   */
  private refreshSelectionAfterStatus(): void {
    const selected = this._selection.file;
    const status = this._shared.status;
    if (!selected || !status) return;

    const match =
      status.files.find((f) => f.path === selected.path && f.staged === selected.staged) ??
      status.files.find((f) => f.path === selected.path);
    if (!match) {
      this._selection = { file: null, diff: null, combined: null };
      this.emit('state-change');
      return;
    }

    this._selection = { ...this._selection, file: match };
    this.scheduleDiffFetch();
  }

  // --- Mutations (never throw to the UI; failures land in shared.error) ---

  private async runMutation(
    describe: string,
    fn: (id: string) => Promise<MutationEnvelope>
  ): Promise<void> {
    if (this.id === null) return;
    try {
      const envelope = await fn(this.id);
      // Apply the response state through the same path as SSE events so a
      // pending selection anchor is consumed against post-mutation status.
      this.applyWireState(envelope.state);
    } catch (err) {
      if (isConnectionError(err)) {
        this.handleConnectionLoss(errorMessage(err));
        return;
      }
      this.setError(`${describe}: ${errorMessage(err)}`);
    }
  }

  async stage(file: FileEntry): Promise<void> {
    await this.runMutation(`Failed to stage ${file.path}`, (id) =>
      this.client.stage(id, file.path)
    );
  }

  async unstage(file: FileEntry): Promise<void> {
    await this.runMutation(`Failed to unstage ${file.path}`, (id) =>
      this.client.unstage(id, file.path)
    );
  }

  async stageAll(): Promise<void> {
    await this.runMutation('Failed to stage all', (id) => this.client.stageAll(id));
  }

  async unstageAll(): Promise<void> {
    await this.runMutation('Failed to unstage all', (id) => this.client.unstageAll(id));
  }

  async discard(file: FileEntry): Promise<void> {
    // Parity with the old manager: discard is only for the unstaged side.
    if (file.staged) return;
    await this.runMutation(`Failed to discard ${file.path}`, (id) =>
      this.client.discard(id, file.path)
    );
  }

  async stageHunk(patch: string): Promise<void> {
    await this.runMutation('Failed to stage hunk', (id) => this.client.stageHunk(id, patch));
  }

  async unstageHunk(patch: string): Promise<void> {
    await this.runMutation('Failed to unstage hunk', (id) => this.client.unstageHunk(id, patch));
  }

  async commit(message: string, amend: boolean = false): Promise<void> {
    await this.runMutation('Failed to commit', (id) => this.client.commit(id, message, { amend }));
  }

  // --- History ---

  async loadHistory(count: number = 100): Promise<void> {
    if (this.id === null) return;
    this.historyCount = count;
    this._history = { ...this._history, isLoading: true };
    this.emit('history-change');
    try {
      const commits = await this.client.history(this.id, count);
      this._history = { commits, selectedCommit: null, commitDiff: null, isLoading: false };
      this.emit('history-change');
    } catch (err) {
      this._history = { ...this._history, isLoading: false };
      this.emit('history-change');
      if (isConnectionError(err)) {
        this.handleConnectionLoss(errorMessage(err));
        return;
      }
      throw err;
    }
  }

  /** Cascade re-pull after a state-change; errors stay out of the UI. */
  private async reloadHistory(): Promise<void> {
    if (this.historyPullInFlight) return;
    this.historyPullInFlight = true;
    try {
      await this.loadHistory(this.historyCount);
    } catch {
      // Transient (e.g. mid-rebase): keep the previous commits visible.
    } finally {
      this.historyPullInFlight = false;
    }
  }

  async selectHistoryCommit(commit: CommitInfo | null): Promise<void> {
    this._history = { ...this._history, selectedCommit: commit, commitDiff: null };
    this.emit('history-change');
    if (!commit || this.id === null) return;

    const id = this.id;
    const diff = await this.read<DiffResult | null>(
      () => this.client.commitDiff(id, commit.hash),
      null
    );
    if (diff === null) return;
    if (this._history.selectedCommit === commit) {
      this._history = { ...this._history, commitDiff: diff };
      this.emit('history-change');
    }
  }

  /** HEAD commit message for the amend prefill ("" without commits). */
  async getHeadCommitMessage(): Promise<string> {
    if (this.id === null) return '';
    const id = this.id;
    return this.read(() => this.client.headMessage(id), '');
  }

  // --- Compare ---

  async refreshCompare(includeUncommitted: boolean = false): Promise<void> {
    if (this.id === null) return;
    this.lastIncludeUncommitted = includeUncommitted;
    this._compare = { ...this._compare, loading: true, error: null };
    this.emit('compare-change');
    try {
      const diff = await this.client.compare(this.id, { uncommitted: includeUncommitted });
      this._compare = {
        ...this._compare,
        compareDiff: diff,
        baseBranch: diff.baseBranch,
        loading: false,
      };
      this.emit('compare-change');
    } catch (err) {
      if (isConnectionError(err)) {
        this._compare = { ...this._compare, loading: false };
        this.emit('compare-change');
        this.handleConnectionLoss(errorMessage(err));
        return;
      }
      this._compare = {
        ...this._compare,
        loading: false,
        error: `Failed to load compare diff: ${errorMessage(err)}`,
      };
      this.emit('compare-change');
    }
  }

  async getCandidateBaseBranches(): Promise<string[]> {
    if (this.id === null) return [];
    const id = this.id;
    return this.read<string[]>(() => this.client.baseBranches(id), []);
  }

  async setCompareBaseBranch(branch: string, includeUncommitted: boolean = false): Promise<void> {
    if (this.id === null) return;
    try {
      await this.client.setCompareBase(this.id, branch);
    } catch (err) {
      if (isConnectionError(err)) {
        this.handleConnectionLoss(errorMessage(err));
        return;
      }
      this._compare = {
        ...this._compare,
        error: `Failed to set base branch: ${errorMessage(err)}`,
      };
      this.emit('compare-change');
      return;
    }
    this._compare = { ...this._compare, baseBranch: branch };
    await this.refreshCompare(includeUncommitted);
  }

  async selectCompareCommit(index: number): Promise<void> {
    const compareDiff = this._compare.compareDiff;
    if (!compareDiff || index < 0 || index >= compareDiff.commits.length || this.id === null) {
      this._compare = { ...this._compare, selection: { type: null, index: 0, diff: null } };
      this.emit('compare-change');
      return;
    }

    const commit = compareDiff.commits[index];
    this._compare = { ...this._compare, selection: { type: 'commit', index, diff: null } };
    this.emit('compare-change');

    const id = this.id;
    const diff = await this.read<DiffResult | null>(
      () => this.client.commitDiff(id, commit.hash),
      null
    );
    if (diff === null) return;
    const selection = this._compare.selection;
    if (selection.type === 'commit' && selection.index === index) {
      this._compare = { ...this._compare, selection: { ...selection, diff } };
      this.emit('compare-change');
    }
  }

  selectCompareFile(index: number): void {
    const compareDiff = this._compare.compareDiff;
    if (!compareDiff || index < 0 || index >= compareDiff.files.length) {
      this._compare = { ...this._compare, selection: { type: null, index: 0, diff: null } };
      this.emit('compare-change');
      return;
    }

    this._compare = {
      ...this._compare,
      selection: { type: 'file', index, diff: compareDiff.files[index].diff },
    };
    this.emit('compare-change');
  }

  // --- Remote operations (state synthesized client-side) ---

  async cherryPick(hash: string): Promise<void> {
    await this.runRemoteOperation('cherryPick', (id) => this.client.cherryPick(id, hash));
  }

  async revertCommit(hash: string): Promise<void> {
    await this.runRemoteOperation('revert', (id) => this.client.revert(id, hash));
  }

  private async runRemoteOperation(
    operation: RemoteOperation,
    fn: (id: string) => Promise<MutationEnvelope>
  ): Promise<void> {
    if (this.id === null || this._remote.inProgress) return;
    this._remote = { operation, inProgress: true, error: null, lastResult: null };
    this.emit('remote-change');
    try {
      const envelope = await fn(this.id);
      this.applyWireState(envelope.state);
      this._remote = { ...this._remote, inProgress: false, lastResult: envelope.result ?? null };
      this.emit('remote-change');
    } catch (err) {
      if (isConnectionError(err)) {
        this._remote = { ...this._remote, inProgress: false };
        this.emit('remote-change');
        this.handleConnectionLoss(errorMessage(err));
        return;
      }
      this._remote = { ...this._remote, inProgress: false, error: errorMessage(err) };
      this.emit('remote-change');
    }
  }

  clearRemoteState(): void {
    this._remote = { operation: null, inProgress: false, error: null, lastResult: null };
    this.emit('remote-change');
  }

  // --- Worktrees ---

  async listWorktrees(): Promise<WorktreeInfo[]> {
    if (this.id === null) return [];
    const id = this.id;
    return this.read<WorktreeInfo[]>(() => this.client.worktrees(id), []);
  }
}

/**
 * Open a repo on the daemon and return a connected session. The daemon
 * normalizes the path to its worktree root (POST /repos resolves
 * subdirectories and bare containers); when it refuses the path — or is
 * unreachable — the session comes back in not-a-repo mode with the reason
 * surfaced in shared.error, exactly like the old in-process "not a git
 * repository" state.
 */
export async function openRepoSession(
  client: DiffstalkerClient,
  path: string,
  options: RepoSessionOptions = {}
): Promise<RepoSession> {
  try {
    const ref = await client.openRepo(path);
    const session = new RepoSession(client, ref, options);
    session.connect();
    return session;
  } catch (err) {
    return new RepoSession(
      client,
      { id: null, path },
      { ...options, initialError: errorMessage(err) }
    );
  }
}
