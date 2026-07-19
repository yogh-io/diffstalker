/**
 * GitStateManager coordinator.
 * Wires sub-managers together; callers access sub-managers directly.
 */

import { getQueueForRepo, removeQueueForRepo } from './GitOperationQueue.js';
import { WorkingTreeManager } from './WorkingTreeManager.js';
import { HistoryManager } from './HistoryManager.js';
import { CompareManager } from './CompareManager.js';
import { RemoteOperationManager } from './RemoteOperationManager.js';

/**
 * Coordinates WorkingTreeManager, HistoryManager,
 * CompareManager, and RemoteOperationManager.
 * Sub-managers are public readonly — callers use them directly.
 */
export class GitStateManager {
  readonly workingTree: WorkingTreeManager;
  readonly history: HistoryManager;
  readonly compare: CompareManager;
  readonly remote: RemoteOperationManager;

  private repoPath: string;

  constructor(repoPath: string) {
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
  }

  dispose(): void {
    this.workingTree.dispose();
    removeQueueForRepo(this.repoPath);
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
