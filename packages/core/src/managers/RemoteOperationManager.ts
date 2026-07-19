import { EventEmitter } from 'node:events';
import { GitOperationQueue } from './GitOperationQueue.js';
import {
  push as gitPush,
  fetchRemote as gitFetchRemote,
  pullRebase as gitPullRebase,
  stashSave as gitStashSave,
  stashPop as gitStashPop,
  getLocalBranches as gitGetLocalBranches,
  switchBranch as gitSwitchBranch,
  createBranch as gitCreateBranch,
  softResetHead as gitSoftResetHead,
  cherryPick as gitCherryPick,
  revertCommit as gitRevertCommit,
  abortOperation as gitAbortOperation,
  rebaseContinue as gitRebaseContinue,
  LocalBranch,
} from '../git/status.js';
import type { RemoteOperationState, RemoteOperation } from '../types/remote.js';

export type { LocalBranch } from '../git/status.js';
export type { RemoteOperationState, RemoteOperation } from '../types/remote.js';

/** Callbacks for cross-manager coordination. */
export interface RemoteCallbacks {
  scheduleRefresh: () => void;
  loadStashList: () => Promise<void>;
  resetCompareBaseBranch: () => void;
}

type RemoteEventMap = {
  'remote-state-change': [RemoteOperationState];
};

/**
 * Manages remote operations (push/pull/fetch), stash, branch switching, and undo operations.
 * Uses callbacks for cross-manager coordination (refresh, stash list, compare reset).
 */
export class RemoteOperationManager extends EventEmitter<RemoteEventMap> {
  private repoPath: string;
  private queue: GitOperationQueue;
  private callbacks: RemoteCallbacks;

  private _remoteState: RemoteOperationState = {
    operation: null,
    inProgress: false,
    error: null,
    lastResult: null,
  };

  constructor(repoPath: string, queue: GitOperationQueue, callbacks: RemoteCallbacks) {
    super();
    this.repoPath = repoPath;
    this.queue = queue;
    this.callbacks = callbacks;
  }

  get remoteState(): RemoteOperationState {
    return this._remoteState;
  }

  private updateRemoteState(partial: Partial<RemoteOperationState>): void {
    this._remoteState = { ...this._remoteState, ...partial };
    this.emit('remote-state-change', this._remoteState);
  }

  /**
   * Run one operation and return THIS call's final state snapshot. Callers
   * (the daemon) must read the returned snapshot, not `remoteState`: by the
   * time they look, the shared slot may already describe a later operation.
   */
  private async runRemoteOperation(
    operation: RemoteOperation,
    fn: () => Promise<string>
  ): Promise<RemoteOperationState> {
    this.updateRemoteState({ operation, inProgress: true, error: null, lastResult: null });

    try {
      const result = await this.queue.enqueue(fn);
      this.updateRemoteState({ inProgress: false, lastResult: result });
      this.callbacks.scheduleRefresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.updateRemoteState({ inProgress: false, error: message });
    }
    // updateRemoteState replaced the object synchronously above; this
    // reference is this operation's own outcome, immune to later ops.
    return this._remoteState;
  }

  /**
   * Clear the remote state (e.g. after auto-clear timeout).
   */
  clearRemoteState(): void {
    this.updateRemoteState({ operation: null, error: null, lastResult: null });
  }

  // --- Remote operations ---
  // Every operation returns its own final state snapshot, or null when it
  // was refused because another operation was already in progress.

  async push(): Promise<RemoteOperationState | null> {
    if (this._remoteState.inProgress) return null;
    return this.runRemoteOperation('push', () => gitPush(this.repoPath));
  }

  async fetchRemote(): Promise<RemoteOperationState | null> {
    if (this._remoteState.inProgress) return null;
    return this.runRemoteOperation('fetch', () => gitFetchRemote(this.repoPath));
  }

  async pullRebase(): Promise<RemoteOperationState | null> {
    if (this._remoteState.inProgress) return null;
    return this.runRemoteOperation('pull', () => gitPullRebase(this.repoPath));
  }

  // --- Stash operations ---

  async stash(message?: string): Promise<RemoteOperationState | null> {
    if (this._remoteState.inProgress) return null;
    const outcome = await this.runRemoteOperation('stash', () =>
      gitStashSave(this.repoPath, message)
    );
    await this.callbacks.loadStashList();
    return outcome;
  }

  async stashPop(index: number = 0): Promise<RemoteOperationState | null> {
    if (this._remoteState.inProgress) return null;
    const outcome = await this.runRemoteOperation('stashPop', () =>
      gitStashPop(this.repoPath, index)
    );
    await this.callbacks.loadStashList();
    return outcome;
  }

  // --- Branch operations ---

  async getLocalBranches(): Promise<LocalBranch[]> {
    return this.queue.enqueue(() => gitGetLocalBranches(this.repoPath));
  }

  async switchBranch(name: string): Promise<RemoteOperationState | null> {
    if (this._remoteState.inProgress) return null;
    const outcome = await this.runRemoteOperation('branchSwitch', () =>
      gitSwitchBranch(this.repoPath, name)
    );
    this.callbacks.resetCompareBaseBranch();
    return outcome;
  }

  async createBranch(name: string): Promise<RemoteOperationState | null> {
    if (this._remoteState.inProgress) return null;
    const outcome = await this.runRemoteOperation('branchCreate', () =>
      gitCreateBranch(this.repoPath, name)
    );
    this.callbacks.resetCompareBaseBranch();
    return outcome;
  }

  // --- Undo operations ---

  async softReset(count: number = 1): Promise<RemoteOperationState | null> {
    if (this._remoteState.inProgress) return null;
    return this.runRemoteOperation('softReset', () => gitSoftResetHead(this.repoPath, count));
  }

  async cherryPick(hash: string): Promise<RemoteOperationState | null> {
    if (this._remoteState.inProgress) return null;
    return this.runRemoteOperation('cherryPick', () => gitCherryPick(this.repoPath, hash));
  }

  async revertCommit(hash: string): Promise<RemoteOperationState | null> {
    if (this._remoteState.inProgress) return null;
    return this.runRemoteOperation('revert', () => gitRevertCommit(this.repoPath, hash));
  }

  // --- In-progress operation recovery ---

  async abortOperation(): Promise<RemoteOperationState | null> {
    if (this._remoteState.inProgress) return null;
    return this.runRemoteOperation('abort', () => gitAbortOperation(this.repoPath));
  }

  async rebaseContinue(): Promise<RemoteOperationState | null> {
    if (this._remoteState.inProgress) return null;
    return this.runRemoteOperation('rebaseContinue', () => gitRebaseContinue(this.repoPath));
  }
}
