import * as path from 'node:path';
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
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
  stageHunk as gitStageHunk,
  unstageHunk as gitUnstageHunk,
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
  countHunksPerFile,
  DiffResult,
  CompareDiff,
  FileHunkCounts,
} from '../git/diff.js';
import { getCachedBaseBranch, setCachedBaseBranch } from '../utils/baseBranchCache.js';

export type { FileHunkCounts } from '../git/diff.js';

export interface CombinedFileDiffs {
  unstaged: DiffResult;
  staged: DiffResult;
}

export interface GitState {
  status: GitStatus | null;
  diff: DiffResult | null;
  combinedFileDiffs: CombinedFileDiffs | null;
  selectedFile: FileEntry | null;
  isLoading: boolean;
  error: string | null;
  hunkCounts: FileHunkCounts | null;
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
  private ignorers: Map<string, Ignore> = new Map();
  private diffDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  // Current state
  private _state: GitState = {
    status: null,
    diff: null,
    combinedFileDiffs: null,
    selectedFile: null,
    isLoading: false,
    error: null,
    hunkCounts: null,
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
   * Load gitignore patterns from all .gitignore files and .git/info/exclude.
   * Returns a Map of directory → Ignore instance, where each instance handles
   * patterns relative to its own directory (matching how git scopes .gitignore files).
   */
  private loadGitignores(): Map<string, Ignore> {
    const ignorers = new Map<string, Ignore>();

    // Root ignorer: .git dir + root .gitignore + .git/info/exclude
    const rootIg = ignore();
    rootIg.add('.git');

    const rootGitignorePath = path.join(this.repoPath, '.gitignore');
    if (fs.existsSync(rootGitignorePath)) {
      rootIg.add(fs.readFileSync(rootGitignorePath, 'utf-8'));
    }

    const excludePath = path.join(this.repoPath, '.git', 'info', 'exclude');
    if (fs.existsSync(excludePath)) {
      rootIg.add(fs.readFileSync(excludePath, 'utf-8'));
    }

    ignorers.set('', rootIg);

    // Find all nested .gitignore files using git ls-files
    try {
      const output = execFileSync(
        'git',
        ['ls-files', '-z', '--cached', '--others', '**/.gitignore'],
        { cwd: this.repoPath, encoding: 'utf-8' }
      );

      for (const entry of output.split('\0')) {
        if (!entry || entry === '.gitignore') continue;
        if (!entry.endsWith('.gitignore')) continue;

        const dir = path.dirname(entry);
        const absPath = path.join(this.repoPath, entry);

        try {
          const content = fs.readFileSync(absPath, 'utf-8');
          const ig = ignore();
          ig.add(content);
          ignorers.set(dir, ig);
        } catch {
          // Skip unreadable files
        }
      }
    } catch {
      // git ls-files failed — we still have the root ignorer
    }

    return ignorers;
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
    this.ignorers = this.loadGitignores();

    this.workingDirWatcher = watch(this.repoPath, {
      persistent: true,
      ignoreInitial: true,
      ignored: (filePath: string) => {
        const relativePath = path.relative(this.repoPath, filePath);
        if (!relativePath) return false;

        // Walk ancestor directories from root to parent, checking each ignorer
        const parts = relativePath.split('/');
        for (let depth = 0; depth < parts.length; depth++) {
          const dir = depth === 0 ? '' : parts.slice(0, depth).join('/');
          const ig = this.ignorers.get(dir);
          if (ig) {
            const relToDir = depth === 0 ? relativePath : parts.slice(depth).join('/');
            if (ig.ignores(relToDir)) return true;
          }
        }
        return false;
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
        this.ignorers = this.loadGitignores();
      }
      scheduleRefresh();
    });
    this.gitWatcher.on('add', scheduleRefresh);
    this.gitWatcher.on('unlink', scheduleRefresh);
    this.gitWatcher.on('error', (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      this.emit('error', `Git watcher error: ${message}`);
    });

    this.workingDirWatcher.on('change', scheduleRefresh);
    this.workingDirWatcher.on('add', scheduleRefresh);
    this.workingDirWatcher.on('unlink', scheduleRefresh);
    this.workingDirWatcher.on('error', (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      this.emit('error', `Working dir watcher error: ${message}`);
    });
  }

  /**
   * Stop watching and clean up resources.
   */
  dispose(): void {
    if (this.diffDebounceTimer) clearTimeout(this.diffDebounceTimer);
    this.gitWatcher?.close();
    this.workingDirWatcher?.close();
    removeQueueForRepo(this.repoPath);
  }

  /**
   * Schedule a refresh (coalesced if one is already pending).
   * Also refreshes history and compare data if they were previously loaded.
   */
  scheduleRefresh(): void {
    this.queue.scheduleRefresh(async () => {
      await this.doRefresh();

      // Also refresh history if it was loaded (has commits)
      if (this._historyState.commits.length > 0) {
        await this.doLoadHistory();
      }

      // Also refresh compare if it was loaded (has a base branch set)
      if (this._compareState.compareBaseBranch) {
        await this.doRefreshCompareDiff(false);
      }
    });
  }

  /**
   * Schedule a lightweight status-only refresh (no diff fetching).
   * Used after stage/unstage where the diff view updates on file selection.
   */
  scheduleStatusRefresh(): void {
    this.queue.scheduleRefresh(async () => {
      const newStatus = await getStatus(this.repoPath);
      if (!newStatus.isRepo) {
        this.updateState({
          status: newStatus,
          diff: null,
          isLoading: false,
          error: 'Not a git repository',
        });
        return;
      }
      this.updateState({ status: newStatus, isLoading: false });
    });
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
          isLoading: false,
          error: 'Not a git repository',
        });
        return;
      }

      // Emit status immediately so the file list updates after a single git spawn
      this.updateState({ status: newStatus });

      // Fetch unstaged and staged diffs in parallel
      const [allUnstagedDiff, allStagedDiff] = await Promise.all([
        getDiff(this.repoPath, undefined, false),
        getDiff(this.repoPath, undefined, true),
      ]);

      // Count hunks per file for the file list display
      const hunkCounts: FileHunkCounts = {
        unstaged: countHunksPerFile(allUnstagedDiff.raw),
        staged: countHunksPerFile(allStagedDiff.raw),
      };

      // Determine display diff based on selected file
      const { displayDiff, combinedFileDiffs } = await this.resolveFileDiffs(
        newStatus,
        allUnstagedDiff
      );

      this.updateState({
        diff: displayDiff,
        combinedFileDiffs,
        hunkCounts,
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
   * Resolve display diff and combined diffs for the currently selected file.
   */
  private async resolveFileDiffs(
    newStatus: GitStatus,
    fallbackDiff: DiffResult
  ): Promise<{ displayDiff: DiffResult; combinedFileDiffs: CombinedFileDiffs | null }> {
    const currentSelectedFile = this._state.selectedFile;
    if (!currentSelectedFile) {
      return { displayDiff: fallbackDiff, combinedFileDiffs: null };
    }

    const currentFile = newStatus.files.find(
      (f) => f.path === currentSelectedFile.path && f.staged === currentSelectedFile.staged
    );
    if (!currentFile) {
      this.updateState({ selectedFile: null });
      return { displayDiff: fallbackDiff, combinedFileDiffs: null };
    }

    if (currentFile.status === 'untracked') {
      const displayDiff = await getDiffForUntracked(this.repoPath, currentFile.path);
      return {
        displayDiff,
        combinedFileDiffs: { unstaged: displayDiff, staged: { raw: '', lines: [] } },
      };
    }

    const [unstagedFileDiff, stagedFileDiff] = await Promise.all([
      getDiff(this.repoPath, currentFile.path, false),
      getDiff(this.repoPath, currentFile.path, true),
    ]);
    const displayDiff = currentFile.staged ? stagedFileDiff : unstagedFileDiff;
    return {
      displayDiff,
      combinedFileDiffs: { unstaged: unstagedFileDiff, staged: stagedFileDiff },
    };
  }

  /**
   * Select a file and update the diff display.
   * The selection highlight updates immediately; the diff fetch is debounced
   * so rapid arrow-key presses only spawn one git process for the final file.
   */
  selectFile(file: FileEntry | null): void {
    this.updateState({ selectedFile: file });

    if (!this._state.status?.isRepo) return;

    if (this.diffDebounceTimer) {
      // Already cooling down — reset the timer and fetch when it expires
      clearTimeout(this.diffDebounceTimer);
      this.diffDebounceTimer = setTimeout(() => {
        this.diffDebounceTimer = null;
        this.fetchDiffForSelection();
      }, 20);
    } else {
      // First call — fetch immediately, then start cooldown
      this.fetchDiffForSelection();
      this.diffDebounceTimer = setTimeout(() => {
        this.diffDebounceTimer = null;
      }, 20);
    }
  }

  private fetchDiffForSelection(): void {
    const file = this._state.selectedFile;

    this.queue
      .enqueue(async () => {
        if (file !== this._state.selectedFile) return;
        await this.doFetchDiffForFile(file);
      })
      .catch((err) => {
        this.updateState({
          error: `Failed to load diff: ${err instanceof Error ? err.message : String(err)}`,
        });
      });
  }

  private async doFetchDiffForFile(file: FileEntry | null): Promise<void> {
    if (!file) {
      const allDiff = await getStagedDiff(this.repoPath);
      if (this._state.selectedFile === null) {
        this.updateState({ diff: allDiff, combinedFileDiffs: null });
      }
      return;
    }

    if (file.status === 'untracked') {
      const fileDiff = await getDiffForUntracked(this.repoPath, file.path);
      if (file === this._state.selectedFile) {
        this.updateState({
          diff: fileDiff,
          combinedFileDiffs: { unstaged: fileDiff, staged: { raw: '', lines: [] } },
        });
      }
      return;
    }

    const [unstagedDiff, stagedDiff] = await Promise.all([
      getDiff(this.repoPath, file.path, false),
      getDiff(this.repoPath, file.path, true),
    ]);
    if (file === this._state.selectedFile) {
      const displayDiff = file.staged ? stagedDiff : unstagedDiff;
      this.updateState({
        diff: displayDiff,
        combinedFileDiffs: { unstaged: unstagedDiff, staged: stagedDiff },
      });
    }
  }

  /**
   * Stage a file.
   */
  async stage(file: FileEntry): Promise<void> {
    try {
      await this.queue.enqueueMutation(() => stageFile(this.repoPath, file.path));
      this.scheduleStatusRefresh();
    } catch (err) {
      await this.refresh();
      this.updateState({
        error: `Failed to stage ${file.path}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  /**
   * Unstage a file.
   */
  async unstage(file: FileEntry): Promise<void> {
    try {
      await this.queue.enqueueMutation(() => unstageFile(this.repoPath, file.path));
      this.scheduleStatusRefresh();
    } catch (err) {
      await this.refresh();
      this.updateState({
        error: `Failed to unstage ${file.path}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  /**
   * Stage a single hunk via patch.
   */
  async stageHunk(patch: string): Promise<void> {
    try {
      await this.queue.enqueueMutation(async () => gitStageHunk(this.repoPath, patch));
      this.scheduleRefresh();
    } catch (err) {
      await this.refresh();
      this.updateState({
        error: `Failed to stage hunk: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  /**
   * Unstage a single hunk via patch.
   */
  async unstageHunk(patch: string): Promise<void> {
    try {
      await this.queue.enqueueMutation(async () => gitUnstageHunk(this.repoPath, patch));
      this.scheduleRefresh();
    } catch (err) {
      await this.refresh();
      this.updateState({
        error: `Failed to unstage hunk: ${err instanceof Error ? err.message : String(err)}`,
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
      await this.queue.enqueue(() => this.doRefreshCompareDiff(includeUncommitted));
    } catch (err) {
      this.updateCompareState({
        compareLoading: false,
        compareError: `Failed to load compare diff: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  /**
   * Internal: refresh compare diff (called within queue).
   */
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
      await this.queue.enqueue(() => this.doLoadHistory(count));
    } catch (err) {
      this.updateHistoryState({ isLoading: false });
      this.updateState({
        error: `Failed to load history: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  /**
   * Internal: load commit history (called within queue).
   */
  private async doLoadHistory(count: number = 100): Promise<void> {
    const commits = await getCommitHistory(this.repoPath, count);
    this.updateHistoryState({ commits, isLoading: false });
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
