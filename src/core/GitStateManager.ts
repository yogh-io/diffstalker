/**
 * GitStateManager facade.
 * Coordinates sub-managers and re-exports their events/types for backward compatibility.
 * All logic lives in the focused sub-managers; this file wires them together.
 */

import { EventEmitter } from 'node:events';
import { getQueueForRepo, removeQueueForRepo } from './GitOperationQueue.js';
import { WorkingTreeManager } from './WorkingTreeManager.js';
import { HistoryManager } from './HistoryManager.js';
import { CompareManager } from './CompareManager.js';
import { RemoteOperationManager } from './RemoteOperationManager.js';
import type { GitState } from './WorkingTreeManager.js';
import type { HistoryState } from './HistoryManager.js';
import type { CompareState, CompareSelectionState } from './CompareManager.js';
import type { RemoteOperationState } from './RemoteOperationManager.js';
import type { FileEntry, CommitInfo, LocalBranch } from '../git/status.js';

// Re-export types for backward compatibility
export type { CombinedFileDiffs, GitState } from './WorkingTreeManager.js';
export type { HistoryState } from './HistoryManager.js';
export type {
  CompareState,
  CompareSelectionType,
  CompareSelectionState,
} from './CompareManager.js';
export type { RemoteOperationState, RemoteOperation } from './RemoteOperationManager.js';
export type { FileHunkCounts } from '../git/diff.js';
export type { StashEntry, LocalBranch } from '../git/status.js';

type GitStateEventMap = {
  'state-change': [GitState];
  'compare-state-change': [CompareState];
  'history-state-change': [HistoryState];
  'compare-selection-change': [CompareSelectionState];
  'remote-state-change': [RemoteOperationState];
  error: [string];
};

/**
 * Facade that coordinates WorkingTreeManager, HistoryManager,
 * CompareManager, and RemoteOperationManager.
 * Preserves the exact same public API as before for App.ts compatibility.
 */
export class GitStateManager extends EventEmitter<GitStateEventMap> {
  private repoPath: string;
  readonly workingTree: WorkingTreeManager;
  readonly history: HistoryManager;
  readonly compare: CompareManager;
  readonly remote: RemoteOperationManager;

  constructor(repoPath: string) {
    super();
    this.repoPath = repoPath;
    const queue = getQueueForRepo(repoPath);

    // Create sub-managers with cross-cutting callbacks
    this.history = new HistoryManager(repoPath, queue);
    this.compare = new CompareManager(repoPath, queue);

    this.workingTree = new WorkingTreeManager(repoPath, queue, async () => {
      await this.history.refreshIfLoaded();
      await this.compare.refreshIfLoaded();
    });

    this.remote = new RemoteOperationManager(repoPath, queue, {
      scheduleRefresh: () => this.workingTree.scheduleRefresh(),
      loadStashList: () => this.workingTree.loadStashList(),
      resetCompareBaseBranch: () => this.compare.resetBaseBranch(),
    });

    // Forward all sub-manager events to facade
    this.workingTree.on('state-change', (s) => this.emit('state-change', s));
    this.workingTree.on('error', (s) => this.emit('error', s));
    this.history.on('history-state-change', (s) => this.emit('history-state-change', s));
    this.compare.on('compare-state-change', (s) => this.emit('compare-state-change', s));
    this.compare.on('compare-selection-change', (s) => this.emit('compare-selection-change', s));
    this.remote.on('remote-state-change', (s) => this.emit('remote-state-change', s));
  }

  // --- State getters (backward compat) ---

  get state(): GitState {
    return this.workingTree.state;
  }

  get compareState(): CompareState {
    return this.compare.compareState;
  }

  get historyState(): HistoryState {
    return this.history.historyState;
  }

  get compareSelectionState(): CompareSelectionState {
    return this.compare.compareSelectionState;
  }

  get remoteState(): RemoteOperationState {
    return this.remote.remoteState;
  }

  // --- Delegating methods ---

  // Working tree
  startWatching(): void {
    this.workingTree.startWatching();
  }
  dispose(): void {
    this.workingTree.dispose();
    removeQueueForRepo(this.repoPath);
  }
  scheduleRefresh(): void {
    this.workingTree.scheduleRefresh();
  }
  async refresh(): Promise<void> {
    await this.workingTree.refresh();
  }
  selectFile(file: FileEntry | null): void {
    this.workingTree.selectFile(file);
  }
  async stage(file: FileEntry): Promise<void> {
    await this.workingTree.stage(file);
  }
  async unstage(file: FileEntry): Promise<void> {
    await this.workingTree.unstage(file);
  }
  async stageHunk(patch: string): Promise<void> {
    await this.workingTree.stageHunk(patch);
  }
  async unstageHunk(patch: string): Promise<void> {
    await this.workingTree.unstageHunk(patch);
  }
  async discard(file: FileEntry): Promise<void> {
    await this.workingTree.discard(file);
  }
  async stageAll(): Promise<void> {
    await this.workingTree.stageAll();
  }
  async unstageAll(): Promise<void> {
    await this.workingTree.unstageAll();
  }
  async commit(message: string, amend: boolean = false): Promise<void> {
    await this.workingTree.commit(message, amend);
  }
  async loadStashList(): Promise<void> {
    await this.workingTree.loadStashList();
  }

  // History
  async loadHistory(count: number = 100): Promise<void> {
    try {
      await this.history.loadHistory(count);
    } catch (err) {
      this.emit('state-change', {
        ...this.workingTree.state,
        error: `Failed to load history: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  async selectHistoryCommit(commit: CommitInfo | null): Promise<void> {
    try {
      await this.history.selectHistoryCommit(commit);
    } catch (err) {
      this.emit('state-change', {
        ...this.workingTree.state,
        error: `Failed to load commit diff: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  async getHeadCommitMessage(): Promise<string> {
    return this.history.getHeadCommitMessage();
  }

  // Compare
  async refreshCompareDiff(includeUncommitted: boolean = false): Promise<void> {
    await this.compare.refreshCompareDiff(includeUncommitted);
  }
  async getCandidateBaseBranches(): Promise<string[]> {
    return this.compare.getCandidateBaseBranches();
  }
  async setCompareBaseBranch(branch: string, includeUncommitted: boolean = false): Promise<void> {
    await this.compare.setCompareBaseBranch(branch, includeUncommitted);
  }
  async selectCompareCommit(index: number): Promise<void> {
    try {
      await this.compare.selectCompareCommit(index);
    } catch (err) {
      this.emit('state-change', {
        ...this.workingTree.state,
        error: `Failed to load commit diff: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  selectCompareFile(index: number): void {
    this.compare.selectCompareFile(index);
  }

  // Remote
  async push(): Promise<void> {
    await this.remote.push();
  }
  async fetchRemote(): Promise<void> {
    await this.remote.fetchRemote();
  }
  async pullRebase(): Promise<void> {
    await this.remote.pullRebase();
  }
  async stash(message?: string): Promise<void> {
    await this.remote.stash(message);
  }
  async stashPop(index: number = 0): Promise<void> {
    await this.remote.stashPop(index);
  }
  async getLocalBranches(): Promise<LocalBranch[]> {
    return this.remote.getLocalBranches();
  }
  async switchBranch(name: string): Promise<void> {
    await this.remote.switchBranch(name);
  }
  async createBranch(name: string): Promise<void> {
    await this.remote.createBranch(name);
  }
  async softReset(count: number = 1): Promise<void> {
    await this.remote.softReset(count);
  }
  async cherryPick(hash: string): Promise<void> {
    await this.remote.cherryPick(hash);
  }
  async revertCommit(hash: string): Promise<void> {
    await this.remote.revertCommit(hash);
  }
  clearRemoteState(): void {
    this.remote.clearRemoteState();
  }
}

// Registry of managers per repo path
const managerRegistry = new Map<string, GitStateManager>();

/**
 * Get the state manager for a specific repository.
 */
export function getManagerForRepo(repoPath: string): GitStateManager {
  let manager = managerRegistry.get(repoPath);
  if (!manager) {
    manager = new GitStateManager(repoPath);
    managerRegistry.set(repoPath, manager);
  }
  return manager;
}

/**
 * Remove a manager from the registry.
 */
export function removeManagerForRepo(repoPath: string): void {
  const manager = managerRegistry.get(repoPath);
  if (manager) {
    manager.dispose();
    managerRegistry.delete(repoPath);
  }
}
