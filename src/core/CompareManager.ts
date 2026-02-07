import { EventEmitter } from 'node:events';
import { GitOperationQueue } from './GitOperationQueue.js';
import {
  getDiffBetweenRefs,
  getCompareDiffWithUncommitted,
  getDefaultBaseBranch,
  getCandidateBaseBranches as gitGetCandidateBaseBranches,
  getCommitDiff,
  CompareDiff,
  DiffResult,
} from '../git/diff.js';
import { getCachedBaseBranch, setCachedBaseBranch } from '../utils/baseBranchCache.js';

export interface CompareState {
  compareDiff: CompareDiff | null;
  compareBaseBranch: string | null;
  compareLoading: boolean;
  compareError: string | null;
}

export type CompareSelectionType = 'commit' | 'file';

export interface CompareSelectionState {
  type: CompareSelectionType | null;
  index: number;
  diff: DiffResult | null;
}

type CompareEventMap = {
  'compare-state-change': [CompareState];
  'compare-selection-change': [CompareSelectionState];
};

/**
 * Manages branch comparison state: base branch, diff, and selection.
 */
export class CompareManager extends EventEmitter<CompareEventMap> {
  private repoPath: string;
  private queue: GitOperationQueue;

  private _compareState: CompareState = {
    compareDiff: null,
    compareBaseBranch: null,
    compareLoading: false,
    compareError: null,
  };

  private _compareSelectionState: CompareSelectionState = {
    type: null,
    index: 0,
    diff: null,
  };

  constructor(repoPath: string, queue: GitOperationQueue) {
    super();
    this.repoPath = repoPath;
    this.queue = queue;
  }

  get compareState(): CompareState {
    return this._compareState;
  }

  get compareSelectionState(): CompareSelectionState {
    return this._compareSelectionState;
  }

  private updateCompareState(partial: Partial<CompareState>): void {
    this._compareState = { ...this._compareState, ...partial };
    this.emit('compare-state-change', this._compareState);
  }

  private updateCompareSelectionState(partial: Partial<CompareSelectionState>): void {
    this._compareSelectionState = { ...this._compareSelectionState, ...partial };
    this.emit('compare-selection-change', this._compareSelectionState);
  }

  /**
   * Refresh compare diff if it was previously loaded (has a base branch set).
   * Called by the cascade refresh after file changes.
   */
  async refreshIfLoaded(): Promise<void> {
    if (this._compareState.compareBaseBranch) {
      await this.doRefreshCompareDiff(false);
    }
  }

  /**
   * Reset the base branch (e.g. after switching branches).
   */
  resetBaseBranch(): void {
    this.updateCompareState({ compareBaseBranch: null });
  }

  /**
   * Refresh compare diff.
   */
  async refreshCompareDiff(includeUncommitted: boolean = false): Promise<void> {
    this.updateCompareState({ compareLoading: true, compareError: null });

    try {
      await this.queue.enqueue(() => this.doRefreshCompareDiff(includeUncommitted));
    } catch (err) {
      this.updateCompareState({
        compareLoading: false,
        compareError: `Failed to load compare diff: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  private async doRefreshCompareDiff(includeUncommitted: boolean): Promise<void> {
    let base = this._compareState.compareBaseBranch;
    if (!base) {
      // Try cached value first, then fall back to default detection
      base = getCachedBaseBranch(this.repoPath) ?? (await getDefaultBaseBranch(this.repoPath));
      this.updateCompareState({ compareBaseBranch: base });
    }
    if (base) {
      const diff = includeUncommitted
        ? await getCompareDiffWithUncommitted(this.repoPath, base)
        : await getDiffBetweenRefs(this.repoPath, base);
      this.updateCompareState({ compareDiff: diff, compareLoading: false });
    } else {
      this.updateCompareState({
        compareDiff: null,
        compareLoading: false,
        compareError: 'No base branch found',
      });
    }
  }

  /**
   * Get candidate base branches for branch comparison.
   */
  async getCandidateBaseBranches(): Promise<string[]> {
    return gitGetCandidateBaseBranches(this.repoPath);
  }

  /**
   * Set the base branch for branch comparison and refresh.
   * Also saves the selection to the cache for future sessions.
   */
  async setCompareBaseBranch(branch: string, includeUncommitted: boolean = false): Promise<void> {
    this.updateCompareState({ compareBaseBranch: branch });
    setCachedBaseBranch(this.repoPath, branch);
    await this.refreshCompareDiff(includeUncommitted);
  }

  /**
   * Select a commit in compare view and load its diff.
   */
  async selectCompareCommit(index: number): Promise<void> {
    const compareDiff = this._compareState.compareDiff;
    if (!compareDiff || index < 0 || index >= compareDiff.commits.length) {
      this.updateCompareSelectionState({ type: null, index: 0, diff: null });
      return;
    }

    const commit = compareDiff.commits[index];
    this.updateCompareSelectionState({ type: 'commit', index, diff: null });

    await this.queue.enqueue(async () => {
      const diff = await getCommitDiff(this.repoPath, commit.hash);
      this.updateCompareSelectionState({ diff });
    });
  }

  /**
   * Select a file in compare view and show its diff.
   */
  selectCompareFile(index: number): void {
    const compareDiff = this._compareState.compareDiff;
    if (!compareDiff || index < 0 || index >= compareDiff.files.length) {
      this.updateCompareSelectionState({ type: null, index: 0, diff: null });
      return;
    }

    const file = compareDiff.files[index];
    this.updateCompareSelectionState({ type: 'file', index, diff: file.diff });
  }
}
