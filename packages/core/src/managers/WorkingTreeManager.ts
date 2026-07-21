import * as path from 'node:path';
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { watch, FSWatcher } from 'chokidar';
import { EventEmitter } from 'node:events';
import ignore, { Ignore } from 'ignore';
import * as logger from '../utils/logger.js';
import { GitOperationQueue } from './GitOperationQueue.js';
import { gitEnv } from '../git/gitClient.js';
import {
  getStatus,
  stageFile,
  unstageFile,
  stageAll as gitStageAll,
  unstageAll as gitUnstageAll,
  discardChanges as gitDiscardChanges,
  deleteUntracked as gitDeleteUntracked,
  commit as gitCommit,
  stageHunk as gitStageHunk,
  unstageHunk as gitUnstageHunk,
  getStashList as gitGetStashList,
  getInProgressOperation,
  GitStatus,
  FileEntry,
  StashEntry,
  InProgressOperation,
} from '../git/status.js';
import {
  getDiff,
  countHunksPerFile,
  DiffResult,
  FileHunkCounts,
} from '../git/diff.js';
import { HunkTimeTracker } from '../git/hunkTimes.js';

export type { FileHunkCounts } from '../git/diff.js';
export type { StashEntry, InProgressOperation } from '../git/status.js';

export interface GitState {
  status: GitStatus | null;
  isLoading: boolean;
  error: string | null;
  hunkCounts: FileHunkCounts | null;
  stashList: StashEntry[];
  /** Multi-step git operation the repo is stopped in (conflicted rebase, cherry-pick, ...). */
  operationInProgress: InProgressOperation | null;
  /**
   * Working-file mtimes (path -> mtimeMs) for every changed file, one
   * entry per path (the staged/unstaged pair collapses). Files that fail
   * to stat (deleted/renamed) are omitted. This is what lets a BROWSER
   * client run mtime-based auto mode — it cannot stat files itself.
   *
   * Intended side effect: a content edit bumps an mtime, so the
   * serialized state changes even when the +/- line counts do not —
   * the daemon's SSE payload dedup then still fires a state-change for
   * in-place edits, which auto mode needs to catch them.
   */
  mtimes: Map<string, number> | null;
}

type WorkingTreeEventMap = {
  'state-change': [GitState];
  error: [string];
};

/**
 * Manages the working tree: file watching, status, whole-tree diffs (for hunk
 * counts and edit-time stamps), staging, and commits.
 */
export class WorkingTreeManager extends EventEmitter<WorkingTreeEventMap> {
  private repoPath: string;
  private queue: GitOperationQueue;
  private hunkTimes: HunkTimeTracker;
  private gitWatcher: FSWatcher | null = null;
  private workingDirWatcher: FSWatcher | null = null;
  private ignorers: Map<string, Ignore> = new Map();

  private _state: GitState = {
    status: null,
    isLoading: false,
    error: null,
    hunkCounts: null,
    stashList: [],
    operationInProgress: null,
    mtimes: null,
  };

  constructor(repoPath: string, queue: GitOperationQueue) {
    super();
    this.repoPath = repoPath;
    this.queue = queue;
    this.hunkTimes = new HunkTimeTracker(repoPath);
  }

  get state(): GitState {
    return this._state;
  }

  private updateState(partial: Partial<GitState>): void {
    this._state = { ...this._state, ...partial };
    this.emit('state-change', this._state);
  }

  /**
   * Surface an error in the UI. It renders in the header (via state-change)
   * and clears on the next refresh.
   */
  setError(message: string): void {
    this.updateState({ error: message });
  }

  /**
   * Clear a surfaced error. Lets callers (e.g. the daemon) reset the error
   * slot before a mutation so a stale message is not mistaken for a fresh
   * failure. No-op (no emit) when there is nothing to clear.
   */
  clearError(): void {
    if (this._state.error !== null) {
      this.updateState({ error: null });
    }
  }

  /**
   * Annotate a diff with hunk edit-time stamps, exactly as diffs entering
   * this manager's own state are. Lets external consumers (the daemon's
   * stateless /diff endpoint) keep the hunk-edit-time feature.
   */
  stampDiff(diff: DiffResult): void {
    this.hunkTimes.stamp(diff);
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
        { cwd: this.repoPath, encoding: 'utf-8', env: gitEnv() }
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
      this.setError(`Git watcher error: ${message}`);
    });

    this.workingDirWatcher.on('change', scheduleRefresh);
    this.workingDirWatcher.on('add', scheduleRefresh);
    this.workingDirWatcher.on('unlink', scheduleRefresh);
    this.workingDirWatcher.on('error', (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      this.setError(`Working dir watcher error: ${message}`);
    });
  }

  dispose(): void {
    this.gitWatcher?.close();
    this.workingDirWatcher?.close();
  }

  /**
   * Stat each changed file's WORKING path and map path -> mtimeMs.
   * The changed-file set is small, so the sync stats are negligible.
   * One entry per path; files with nothing on disk are omitted.
   */
  private statMtimes(status: GitStatus): Map<string, number> {
    const mtimes = new Map<string, number>();
    for (const file of status.files) {
      if (mtimes.has(file.path)) continue; // staged/unstaged pair: one entry
      try {
        mtimes.set(file.path, fs.statSync(path.join(this.repoPath, file.path)).mtimeMs);
      } catch {
        // deleted/renamed — nothing on disk to stamp
      }
    }
    return mtimes;
  }

  // --- Refresh ---

  scheduleRefresh(): void {
    this.queue.scheduleRefresh(async () => {
      await this.doRefresh();
    });
  }

  scheduleStatusRefresh(): void {
    this.queue.scheduleRefresh(async () => {
      try {
        const newStatus = await getStatus(this.repoPath);
        if (!newStatus.isRepo) {
          this.updateState({
            status: newStatus,
            isLoading: false,
            error: 'Not a git repository',
          });
          return;
        }
        this.updateState({
          status: newStatus,
          mtimes: this.statMtimes(newStatus),
          isLoading: false,
        });
      } catch (err) {
        // Transient failure (e.g. index.lock contention): keep the previous
        // status and surface the error instead of wiping the file list
        this.updateState({
          isLoading: false,
          error: err instanceof Error ? err.message : 'Unknown error',
        });
      }
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
          isLoading: false,
          error: 'Not a git repository',
        });
        return;
      }

      // Stash list and in-progress operation are shared repo state (they
      // cross the daemon wire), so a full refresh recomputes them too.
      // Plain git functions, not loadStashList: this already runs inside
      // the queue, so re-enqueueing would deadlock.
      const [allUnstagedDiff, allStagedDiff, stashList, operationInProgress] = await Promise.all([
        getDiff(this.repoPath, undefined, false),
        getDiff(this.repoPath, undefined, true),
        gitGetStashList(this.repoPath),
        getInProgressOperation(this.repoPath),
      ]);

      const hunkCounts: FileHunkCounts = {
        unstaged: countHunksPerFile(allUnstagedDiff.raw),
        staged: countHunksPerFile(allStagedDiff.raw),
      };

      // Observe every hunk so first-seen stamps are locked in as soon as a
      // change appears, then drop stamps for files that no longer have changes
      this.hunkTimes.stamp(allUnstagedDiff);
      this.hunkTimes.stamp(allStagedDiff);
      this.hunkTimes.prune(new Set(newStatus.files.map((f) => f.path)));

      this.updateState({
        status: newStatus,
        hunkCounts,
        stashList,
        operationInProgress,
        mtimes: this.statMtimes(newStatus),
        isLoading: false,
      });
    } catch (err) {
      this.updateState({
        isLoading: false,
        error: err instanceof Error ? err.message : 'Unknown error',
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
    if (file.staged) return;

    const operation =
      file.status === 'untracked'
        ? () => gitDeleteUntracked(this.repoPath, file.path)
        : () => gitDiscardChanges(this.repoPath, file.path);

    try {
      await this.queue.enqueueMutation(operation);
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
