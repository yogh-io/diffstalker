import * as path from 'node:path';
import * as fs from 'node:fs';
import { watch, FSWatcher } from 'chokidar';
import { EventEmitter } from 'node:events';
import ignore, { Ignore } from 'ignore';
import { GitOperationQueue, getQueueForRepo, removeQueueForRepo } from './GitOperationQueue.js';
import {
  getStatus,
  stageFile,
  unstageFile,
  stageAll as gitStageAll,
  unstageAll as gitUnstageAll,
  discardChanges as gitDiscardChanges,
  commit as gitCommit,
  getHeadMessage,
  getCommitHistory,
  GitStatus,
  FileEntry,
  CommitInfo,
} from '../git/status.js';
import {
  getDiff,
  getDiffForUntracked,
  getStagedDiff,
  getDefaultBaseBranch,
  getCandidateBaseBranches,
  getDiffBetweenRefs,
  getCompareDiffWithUncommitted,
  getCommitDiff,
  DiffResult,
  CompareDiff,
} from '../git/diff.js';
import { getCachedBaseBranch, setCachedBaseBranch } from '../utils/baseBranchCache.js';

export interface GitState {
  status: GitStatus | null;
  diff: DiffResult | null;
  stagedDiff: string;
  selectedFile: FileEntry | null;
  isLoading: boolean;
  error: string | null;
}

export interface CompareState {
  compareDiff: CompareDiff | null;
  compareBaseBranch: string | null;
  compareLoading: boolean;
  compareError: string | null;
}

export interface HistoryState {
  commits: CommitInfo[];
  selectedCommit: CommitInfo | null;
  commitDiff: DiffResult | null;
  isLoading: boolean;
}

export type CompareSelectionType = 'commit' | 'file';

export interface CompareSelectionState {
  type: CompareSelectionType | null;
  index: number;
  diff: DiffResult | null;
}

type GitStateEventMap = {
  'state-change': [GitState];
  'compare-state-change': [CompareState];
  'history-state-change': [HistoryState];
  'compare-selection-change': [CompareSelectionState];
  error: [string];
};

/**
 * GitStateManager manages git state independent of React.
 * It owns the operation queue, file watchers, and emits events on state changes.
 */
export class GitStateManager extends EventEmitter<GitStateEventMap> {
  private repoPath: string;
  private queue: GitOperationQueue;
  private gitWatcher: FSWatcher | null = null;
  private workingDirWatcher: FSWatcher | null = null;
  private ignorer: Ignore | null = null;

  // Current state
  private _state: GitState = {
    status: null,
    diff: null,
    stagedDiff: '',
    selectedFile: null,
    isLoading: false,
    error: null,
  };

  private _compareState: CompareState = {
    compareDiff: null,
    compareBaseBranch: null,
    compareLoading: false,
    compareError: null,
  };

  private _historyState: HistoryState = {
    commits: [],
    selectedCommit: null,
    commitDiff: null,
    isLoading: false,
  };

  private _compareSelectionState: CompareSelectionState = {
    type: null,
    index: 0,
    diff: null,
  };

  constructor(repoPath: string) {
    super();
    this.repoPath = repoPath;
    this.queue = getQueueForRepo(repoPath);
  }

  get state(): GitState {
    return this._state;
  }

  get compareState(): CompareState {
    return this._compareState;
  }

  get historyState(): HistoryState {
    return this._historyState;
  }

  get compareSelectionState(): CompareSelectionState {
    return this._compareSelectionState;
  }

  private updateState(partial: Partial<GitState>): void {
    this._state = { ...this._state, ...partial };
    this.emit('state-change', this._state);
  }

  private updateCompareState(partial: Partial<CompareState>): void {
    this._compareState = { ...this._compareState, ...partial };
    this.emit('compare-state-change', this._compareState);
  }

  private updateHistoryState(partial: Partial<HistoryState>): void {
    this._historyState = { ...this._historyState, ...partial };
    this.emit('history-state-change', this._historyState);
  }

  private updateCompareSelectionState(partial: Partial<CompareSelectionState>): void {
    this._compareSelectionState = { ...this._compareSelectionState, ...partial };
    this.emit('compare-selection-change', this._compareSelectionState);
  }

  /**
   * Load gitignore patterns from .gitignore and .git/info/exclude.
   * Returns an Ignore instance that can test paths.
   */
  private loadGitignore(): Ignore {
    const ig = ignore();

    // Always ignore .git directory (has its own dedicated watcher)
    ig.add('.git');

    // Load .gitignore if it exists
    const gitignorePath = path.join(this.repoPath, '.gitignore');
    if (fs.existsSync(gitignorePath)) {
      ig.add(fs.readFileSync(gitignorePath, 'utf-8'));
    }

    // Load .git/info/exclude if it exists (repo-specific ignores)
    const excludePath = path.join(this.repoPath, '.git', 'info', 'exclude');
    if (fs.existsSync(excludePath)) {
      ig.add(fs.readFileSync(excludePath, 'utf-8'));
    }

    return ig;
  }

  /**
   * Start watching for file changes.
   */
  startWatching(): void {
    const gitDir = path.join(this.repoPath, '.git');
    if (!fs.existsSync(gitDir)) return;

    // --- Git internals watcher ---
    const indexFile = path.join(gitDir, 'index');
    const headFile = path.join(gitDir, 'HEAD');
    const refsDir = path.join(gitDir, 'refs');
    const gitignorePath = path.join(this.repoPath, '.gitignore');

    // Git uses atomic writes (write to temp, then rename). We use polling
    // for reliable detection of these atomic operations.
    this.gitWatcher = watch([indexFile, headFile, refsDir, gitignorePath], {
      persistent: true,
      ignoreInitial: true,
      usePolling: true,
      interval: 100,
    });

    // --- Working directory watcher with gitignore support ---
    this.ignorer = this.loadGitignore();

    this.workingDirWatcher = watch(this.repoPath, {
      persistent: true,
      ignoreInitial: true,
      ignored: (filePath: string) => {
        // Get path relative to repo root
        const relativePath = path.relative(this.repoPath, filePath);

        // Don't ignore the repo root itself
        if (!relativePath) return false;

        // Check against gitignore patterns
        // When this returns true for a directory, chokidar won't recurse into it
        return this.ignorer?.ignores(relativePath) ?? false;
      },
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 50,
      },
    });

    const scheduleRefresh = () => this.scheduleRefresh();

    this.gitWatcher.on('change', (filePath) => {
      // Reload gitignore patterns if .gitignore changed
      if (filePath === gitignorePath) {
        this.ignorer = this.loadGitignore();
      }
      scheduleRefresh();
    });
    this.gitWatcher.on('add', scheduleRefresh);
    this.gitWatcher.on('unlink', scheduleRefresh);
    this.gitWatcher.on('error', (err) => {
      this.emit('error', `Git watcher error: ${err.message}`);
    });

    this.workingDirWatcher.on('change', scheduleRefresh);
    this.workingDirWatcher.on('add', scheduleRefresh);
    this.workingDirWatcher.on('unlink', scheduleRefresh);
    this.workingDirWatcher.on('error', (err) => {
      this.emit('error', `Working dir watcher error: ${err.message}`);
    });
  }

  /**
   * Stop watching and clean up resources.
   */
  dispose(): void {
    this.gitWatcher?.close();
    this.workingDirWatcher?.close();
    removeQueueForRepo(this.repoPath);
  }

  /**
   * Schedule a refresh (coalesced if one is already pending).
   */
  scheduleRefresh(): void {
    this.queue.scheduleRefresh(() => this.doRefresh());
  }

  /**
   * Immediately refresh git state.
   */
  async refresh(): Promise<void> {
    await this.queue.enqueue(() => this.doRefresh());
  }

  private async doRefresh(): Promise<void> {
    this.updateState({ isLoading: true, error: null });

    try {
      const newStatus = await getStatus(this.repoPath);

      if (!newStatus.isRepo) {
        this.updateState({
          status: newStatus,
          diff: null,
          stagedDiff: '',
          isLoading: false,
          error: 'Not a git repository',
        });
        return;
      }

      // Fetch all diffs atomically
      const [allStagedDiff, allUnstagedDiff] = await Promise.all([
        getStagedDiff(this.repoPath),
        getDiff(this.repoPath, undefined, false),
      ]);

      // Determine display diff based on selected file
      let displayDiff: DiffResult;
      const currentSelectedFile = this._state.selectedFile;

      if (currentSelectedFile) {
        const currentFile = newStatus.files.find(
          (f) => f.path === currentSelectedFile.path && f.staged === currentSelectedFile.staged
        );
        if (currentFile) {
          if (currentFile.status === 'untracked') {
            displayDiff = await getDiffForUntracked(this.repoPath, currentFile.path);
          } else {
            displayDiff = await getDiff(this.repoPath, currentFile.path, currentFile.staged);
          }
        } else {
          // File no longer exists - clear selection
          displayDiff = allUnstagedDiff.raw ? allUnstagedDiff : allStagedDiff;
          this.updateState({ selectedFile: null });
        }
      } else {
        if (allUnstagedDiff.raw) {
          displayDiff = allUnstagedDiff;
        } else if (allStagedDiff.raw) {
          displayDiff = allStagedDiff;
        } else {
          displayDiff = { raw: '', lines: [] };
        }
      }

      this.updateState({
        status: newStatus,
        diff: displayDiff,
        stagedDiff: allStagedDiff.raw,
        isLoading: false,
      });
    } catch (err) {
      this.updateState({
        isLoading: false,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }

  /**
   * Select a file and update the diff display.
   */
  async selectFile(file: FileEntry | null): Promise<void> {
    this.updateState({ selectedFile: file });

    if (!this._state.status?.isRepo) return;

    await this.queue.enqueue(async () => {
      if (file) {
        let fileDiff: DiffResult;
        if (file.status === 'untracked') {
          fileDiff = await getDiffForUntracked(this.repoPath, file.path);
        } else {
          fileDiff = await getDiff(this.repoPath, file.path, file.staged);
        }
        this.updateState({ diff: fileDiff });
      } else {
        const allDiff = await getStagedDiff(this.repoPath);
        this.updateState({ diff: allDiff });
      }
    });
  }

  /**
   * Stage a file with optimistic update.
   */
  async stage(file: FileEntry): Promise<void> {
    // Optimistic update
    const currentStatus = this._state.status;
    if (currentStatus) {
      this.updateState({
        status: {
          ...currentStatus,
          files: currentStatus.files.map((f) =>
            f.path === file.path && !f.staged ? { ...f, staged: true } : f
          ),
        },
      });
    }

    try {
      await this.queue.enqueueMutation(() => stageFile(this.repoPath, file.path));
      this.scheduleRefresh();
    } catch (err) {
      await this.refresh();
      this.updateState({
        error: `Failed to stage ${file.path}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  /**
   * Unstage a file with optimistic update.
   */
  async unstage(file: FileEntry): Promise<void> {
    // Optimistic update
    const currentStatus = this._state.status;
    if (currentStatus) {
      this.updateState({
        status: {
          ...currentStatus,
          files: currentStatus.files.map((f) =>
            f.path === file.path && f.staged ? { ...f, staged: false } : f
          ),
        },
      });
    }

    try {
      await this.queue.enqueueMutation(() => unstageFile(this.repoPath, file.path));
      this.scheduleRefresh();
    } catch (err) {
      await this.refresh();
      this.updateState({
        error: `Failed to unstage ${file.path}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  /**
   * Discard changes to a file.
   */
  async discard(file: FileEntry): Promise<void> {
    if (file.staged || file.status === 'untracked') return;

    try {
      await this.queue.enqueueMutation(() => gitDiscardChanges(this.repoPath, file.path));
      await this.refresh();
    } catch (err) {
      this.updateState({
        error: `Failed to discard ${file.path}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  /**
   * Stage all files.
   */
  async stageAll(): Promise<void> {
    try {
      await this.queue.enqueueMutation(() => gitStageAll(this.repoPath));
      await this.refresh();
    } catch (err) {
      this.updateState({
        error: `Failed to stage all: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  /**
   * Unstage all files.
   */
  async unstageAll(): Promise<void> {
    try {
      await this.queue.enqueueMutation(() => gitUnstageAll(this.repoPath));
      await this.refresh();
    } catch (err) {
      this.updateState({
        error: `Failed to unstage all: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  /**
   * Create a commit.
   */
  async commit(message: string, amend: boolean = false): Promise<void> {
    try {
      await this.queue.enqueue(() => gitCommit(this.repoPath, message, amend));
      await this.refresh();
    } catch (err) {
      this.updateState({
        error: `Failed to commit: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  /**
   * Get the HEAD commit message.
   */
  async getHeadCommitMessage(): Promise<string> {
    return this.queue.enqueue(() => getHeadMessage(this.repoPath));
  }

  /**
   * Refresh compare diff.
   */
  async refreshCompareDiff(includeUncommitted: boolean = false): Promise<void> {
    this.updateCompareState({ compareLoading: true, compareError: null });

    try {
      await this.queue.enqueue(async () => {
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
      });
    } catch (err) {
      this.updateCompareState({
        compareLoading: false,
        compareError: `Failed to load compare diff: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  /**
   * Get candidate base branches for branch comparison.
   */
  async getCandidateBaseBranches(): Promise<string[]> {
    return getCandidateBaseBranches(this.repoPath);
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
   * Load commit history for the history view.
   */
  async loadHistory(count: number = 100): Promise<void> {
    this.updateHistoryState({ isLoading: true });

    try {
      const commits = await this.queue.enqueue(() => getCommitHistory(this.repoPath, count));
      this.updateHistoryState({ commits, isLoading: false });
    } catch (err) {
      this.updateHistoryState({ isLoading: false });
      this.updateState({
        error: `Failed to load history: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  /**
   * Select a commit in history view and load its diff.
   */
  async selectHistoryCommit(commit: CommitInfo | null): Promise<void> {
    this.updateHistoryState({ selectedCommit: commit, commitDiff: null });

    if (!commit) return;

    try {
      await this.queue.enqueue(async () => {
        const diff = await getCommitDiff(this.repoPath, commit.hash);
        this.updateHistoryState({ commitDiff: diff });
      });
    } catch (err) {
      this.updateState({
        error: `Failed to load commit diff: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
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

    try {
      await this.queue.enqueue(async () => {
        const diff = await getCommitDiff(this.repoPath, commit.hash);
        this.updateCompareSelectionState({ diff });
      });
    } catch (err) {
      this.updateState({
        error: `Failed to load commit diff: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
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
