import * as path from 'node:path';
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { watch, FSWatcher } from 'chokidar';
import { EventEmitter } from 'node:events';
import ignore, { Ignore } from 'ignore';
import * as logger from '../utils/logger.js';
import { GitOperationQueue } from './GitOperationQueue.js';
import {
  getStatus,
  stageFile,
  unstageFile,
  stageAll as gitStageAll,
  unstageAll as gitUnstageAll,
  discardChanges as gitDiscardChanges,
  commit as gitCommit,
  stageHunk as gitStageHunk,
  unstageHunk as gitUnstageHunk,
  getStashList as gitGetStashList,
  GitStatus,
  FileEntry,
  StashEntry,
} from '../git/status.js';
import {
  getDiff,
  getDiffForUntracked,
  getStagedDiff,
  countHunksPerFile,
  DiffResult,
  FileHunkCounts,
} from '../git/diff.js';

export type { FileHunkCounts } from '../git/diff.js';
export type { StashEntry } from '../git/status.js';

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
  stashList: StashEntry[];
}

type WorkingTreeEventMap = {
  'state-change': [GitState];
  error: [string];
};

/**
 * Manages the working tree: file watching, status, diffs, staging, and commits.
 * Accepts an onRefresh callback for cascading refreshes to history/compare managers.
 */
export class WorkingTreeManager extends EventEmitter<WorkingTreeEventMap> {
  private repoPath: string;
  private queue: GitOperationQueue;
  private onRefresh: (() => Promise<void>) | null;
  private gitWatcher: FSWatcher | null = null;
  private workingDirWatcher: FSWatcher | null = null;
  private ignorers: Map<string, Ignore> = new Map();
  private diffDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  private _state: GitState = {
    status: null,
    diff: null,
    combinedFileDiffs: null,
    selectedFile: null,
    isLoading: false,
    error: null,
    hunkCounts: null,
    stashList: [],
  };

  constructor(repoPath: string, queue: GitOperationQueue, onRefresh?: () => Promise<void>) {
    super();
    this.repoPath = repoPath;
    this.queue = queue;
    this.onRefresh = onRefresh ?? null;
  }

  get state(): GitState {
    return this._state;
  }

  private updateState(partial: Partial<GitState>): void {
    this._state = { ...this._state, ...partial };
    this.emit('state-change', this._state);
  }

  // --- Gitignore loading ---

  private loadGitignores(): Map<string, Ignore> {
    const ignorers = new Map<string, Ignore>();

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
        } catch (err) {
          logger.warn(`Failed to read ${absPath}: ${err instanceof Error ? err.message : err}`);
        }
      }
    } catch {
      // git ls-files failed — we still have the root ignorer
    }

    return ignorers;
  }

  // --- File watching ---

  startWatching(): void {
    const gitDir = path.join(this.repoPath, '.git');
    if (!fs.existsSync(gitDir)) return;

    const indexFile = path.join(gitDir, 'index');
    const headFile = path.join(gitDir, 'HEAD');
    const refsDir = path.join(gitDir, 'refs');
    const gitignorePath = path.join(this.repoPath, '.gitignore');

    this.gitWatcher = watch([indexFile, headFile, refsDir, gitignorePath], {
      persistent: true,
      ignoreInitial: true,
      usePolling: true,
      interval: 100,
    });

    this.ignorers = this.loadGitignores();

    this.workingDirWatcher = watch(this.repoPath, {
      persistent: true,
      ignoreInitial: true,
      ignored: (filePath: string) => {
        const relativePath = path.relative(this.repoPath, filePath);
        if (!relativePath) return false;

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

  dispose(): void {
    if (this.diffDebounceTimer) clearTimeout(this.diffDebounceTimer);
    this.gitWatcher?.close();
    this.workingDirWatcher?.close();
  }

  // --- Refresh ---

  scheduleRefresh(): void {
    this.queue.scheduleRefresh(async () => {
      await this.doRefresh();

      // Cascade refresh to history and compare if loaded
      if (this.onRefresh) {
        await this.onRefresh();
      }
    });
  }

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

      const [allUnstagedDiff, allStagedDiff] = await Promise.all([
        getDiff(this.repoPath, undefined, false),
        getDiff(this.repoPath, undefined, true),
      ]);

      const hunkCounts: FileHunkCounts = {
        unstaged: countHunksPerFile(allUnstagedDiff.raw),
        staged: countHunksPerFile(allStagedDiff.raw),
      };

      const { displayDiff, combinedFileDiffs } = await this.resolveFileDiffs(
        newStatus,
        allUnstagedDiff
      );

      this.updateState({
        status: newStatus,
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

  private async resolveFileDiffs(
    newStatus: GitStatus,
    fallbackDiff: DiffResult
  ): Promise<{ displayDiff: DiffResult; combinedFileDiffs: CombinedFileDiffs | null }> {
    const currentSelectedFile = this._state.selectedFile;
    if (!currentSelectedFile) {
      return { displayDiff: fallbackDiff, combinedFileDiffs: null };
    }

    const currentFile =
      newStatus.files.find(
        (f) => f.path === currentSelectedFile.path && f.staged === currentSelectedFile.staged
      ) ?? newStatus.files.find((f) => f.path === currentSelectedFile.path);
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

  // --- File selection ---

  selectFile(file: FileEntry | null): void {
    this.updateState({ selectedFile: file });

    if (!this._state.status?.isRepo) return;

    if (this.diffDebounceTimer) {
      clearTimeout(this.diffDebounceTimer);
      this.diffDebounceTimer = setTimeout(() => {
        this.diffDebounceTimer = null;
        this.fetchDiffForSelection();
      }, 20);
    } else {
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

  // --- Staging operations ---

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

  // --- Commit ---

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

  // --- Stash list ---

  async loadStashList(): Promise<void> {
    try {
      const stashList = await this.queue.enqueue(() => gitGetStashList(this.repoPath));
      this.updateState({ stashList });
    } catch {
      // Silently ignore — stash list is non-critical
    }
  }
}
