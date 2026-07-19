import { EventEmitter } from 'node:events';
import { GitOperationQueue } from './GitOperationQueue.js';
import { getCommitHistory, getHeadMessage, CommitInfo } from '../git/status.js';
import { getCommitDiff, DiffResult } from '../git/diff.js';

export interface HistoryState {
  commits: CommitInfo[];
  selectedCommit: CommitInfo | null;
  commitDiff: DiffResult | null;
  isLoading: boolean;
}

type HistoryEventMap = {
  'history-state-change': [HistoryState];
};

/**
 * Manages commit history state: loading, selection, and diff display.
 */
export class HistoryManager extends EventEmitter<HistoryEventMap> {
  private repoPath: string;
  private queue: GitOperationQueue;

  private _historyState: HistoryState = {
    commits: [],
    selectedCommit: null,
    commitDiff: null,
    isLoading: false,
  };

  constructor(repoPath: string, queue: GitOperationQueue) {
    super();
    this.repoPath = repoPath;
    this.queue = queue;
  }

  get historyState(): HistoryState {
    return this._historyState;
  }

  private updateHistoryState(partial: Partial<HistoryState>): void {
    this._historyState = { ...this._historyState, ...partial };
    this.emit('history-state-change', this._historyState);
  }

  /**
   * Refresh history if it was previously loaded (has commits).
   * Called by the cascade refresh after file changes.
   */
  async refreshIfLoaded(count: number = 100): Promise<void> {
    if (this._historyState.commits.length > 0) {
      await this.doLoadHistory(count);
    }
  }

  /**
   * Load commit history for the history view.
   */
  async loadHistory(count: number = 100): Promise<void> {
    this.updateHistoryState({ isLoading: true });

    try {
      await this.queue.enqueue(() => this.doLoadHistory(count));
    } catch (err) {
      this.updateHistoryState({ isLoading: false });
      throw err;
    }
  }

  private async doLoadHistory(count: number = 100): Promise<void> {
    const commits = await getCommitHistory(this.repoPath, count);
    this.updateHistoryState({ commits, selectedCommit: null, commitDiff: null, isLoading: false });
  }

  /**
   * Select a commit in history view and load its diff.
   */
  async selectHistoryCommit(commit: CommitInfo | null): Promise<void> {
    this.updateHistoryState({ selectedCommit: commit, commitDiff: null });

    if (!commit) return;

    await this.queue.enqueue(async () => {
      const diff = await getCommitDiff(this.repoPath, commit.hash);
      this.updateHistoryState({ commitDiff: diff });
    });
  }

  /**
   * Get the HEAD commit message.
   */
  async getHeadCommitMessage(): Promise<string> {
    return this.queue.enqueue(() => getHeadMessage(this.repoPath));
  }
}
