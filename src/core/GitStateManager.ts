import * as path from 'node:path';
import * as fs from 'node:fs';
import { watch, FSWatcher } from 'chokidar';
import { EventEmitter } from 'node:events';
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
  GitStatus,
  FileEntry,
} from '../git/status.js';
import {
  getDiff,
  getDiffForUntracked,
  getStagedDiff,
  getDefaultBaseBranch,
  getDiffBetweenRefs,
  getPRDiffWithUncommitted,
  DiffResult,
  PRDiff,
} from '../git/diff.js';

export interface GitState {
  status: GitStatus | null;
  diff: DiffResult | null;
  stagedDiff: string;
  selectedFile: FileEntry | null;
  isLoading: boolean;
  error: string | null;
}

export interface PRState {
  prDiff: PRDiff | null;
  prBaseBranch: string | null;
  prLoading: boolean;
  prError: string | null;
}

type GitStateEventMap = {
  'state-change': [GitState];
  'pr-state-change': [PRState];
  'error': [string];
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

  // Current state
  private _state: GitState = {
    status: null,
    diff: null,
    stagedDiff: '',
    selectedFile: null,
    isLoading: false,
    error: null,
  };

  private _prState: PRState = {
    prDiff: null,
    prBaseBranch: null,
    prLoading: false,
    prError: null,
  };

  constructor(repoPath: string) {
    super();
    this.repoPath = repoPath;
    this.queue = getQueueForRepo(repoPath);
  }

  get state(): GitState {
    return this._state;
  }

  get prState(): PRState {
    return this._prState;
  }

  private updateState(partial: Partial<GitState>): void {
    this._state = { ...this._state, ...partial };
    this.emit('state-change', this._state);
  }

  private updatePRState(partial: Partial<PRState>): void {
    this._prState = { ...this._prState, ...partial };
    this.emit('pr-state-change', this._prState);
  }

  /**
   * Start watching for file changes.
   */
  startWatching(): void {
    const gitDir = path.join(this.repoPath, '.git');
    if (!fs.existsSync(gitDir)) return;

    const indexFile = path.join(gitDir, 'index');
    const headFile = path.join(gitDir, 'HEAD');
    const refsDir = path.join(gitDir, 'refs');

    this.gitWatcher = watch([indexFile, headFile, refsDir], {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 50,
      },
    });

    this.workingDirWatcher = watch(this.repoPath, {
      persistent: true,
      ignoreInitial: true,
      ignored: [
        '**/node_modules/**',
        '**/.git/**',
        '**/dist/**',
        '**/build/**',
        '**/*.log',
        '**/.DS_Store',
      ],
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 50,
      },
      depth: 10,
    });

    const scheduleRefresh = () => this.scheduleRefresh();

    this.gitWatcher.on('change', scheduleRefresh);
    this.gitWatcher.on('add', scheduleRefresh);
    this.gitWatcher.on('unlink', scheduleRefresh);

    this.workingDirWatcher.on('change', scheduleRefresh);
    this.workingDirWatcher.on('add', scheduleRefresh);
    this.workingDirWatcher.on('unlink', scheduleRefresh);
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
          f => f.path === currentSelectedFile.path && f.staged === currentSelectedFile.staged
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
          files: currentStatus.files.map(f =>
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
          files: currentStatus.files.map(f =>
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
   * Refresh PR diff.
   */
  async refreshPRDiff(includeUncommitted: boolean = false): Promise<void> {
    this.updatePRState({ prLoading: true, prError: null });

    try {
      await this.queue.enqueue(async () => {
        let base = this._prState.prBaseBranch;
        if (!base) {
          base = await getDefaultBaseBranch(this.repoPath);
          this.updatePRState({ prBaseBranch: base });
        }
        if (base) {
          const diff = includeUncommitted
            ? await getPRDiffWithUncommitted(this.repoPath, base)
            : await getDiffBetweenRefs(this.repoPath, base);
          this.updatePRState({ prDiff: diff, prLoading: false });
        } else {
          this.updatePRState({
            prDiff: null,
            prLoading: false,
            prError: 'No base branch found (no origin/main or origin/master)',
          });
        }
      });
    } catch (err) {
      this.updatePRState({
        prLoading: false,
        prError: `Failed to load PR diff: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
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
