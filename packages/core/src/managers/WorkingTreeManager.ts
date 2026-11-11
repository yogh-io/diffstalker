import * as path from 'node:path';
import * as fs from 'node:fs';
import { EventEmitter } from 'node:events';
import * as logger from '../utils/logger.js';
import { GitOperationQueue } from './GitOperationQueue.js';
import { TreeWatcher } from './TreeWatcher.js';
import { loadIgnoreRules, type IgnoreRules } from '../git/ignoreRules.js';
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
  getWholeTreeDiff,
  getDiffAgainstHead,
  getDiffForUntracked,
  getHeadOid,
  countHunksPerFile,
  DiffLine,
  DiffResult,
  FileHunkCounts,
} from '../git/diff.js';
import { HunkTimeTracker } from '../git/hunkTimes.js';
import { quoteGitPath, rawFromLines } from '../git/diffParse.js';
import { resolveGitDirs, type GitDirs } from '../git/worktree.js';
import { splitDiffByFile } from '../view/splitDiffByFile.js';
import { OVERSIZE_UNTRACKED_MARKER } from '../types/journal.js';
import type { JournalObservation } from '../types/journal.js';

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

/** Both whole-tree diffs of one refresh, hunk edit times stamped. */
export interface WholeTreeDiffs {
  unstaged: DiffResult;
  staged: DiffResult;
}

type WorkingTreeEventMap = {
  'state-change': [GitState];
  'journal-observation': [JournalObservation];
};

/** Untracked files above this size are not read for the journal; they get a header-only marker section instead. */
const MAX_UNTRACKED_JOURNAL_BYTES = 256 * 1024;

/**
 * The journal's widened tear guard: repo facts snapshotted BEFORE the
 * diff reads and re-read AFTER. If any moved, the observation window was
 * torn by an external operation (checkout/stash/merge writing the
 * worktree over seconds) and the whole observation is discarded —
 * defer-don't-decide.
 */
interface JournalGuardSnapshot {
  operation: InProgressOperation | null;
  stashList: StashEntry[];
  /** Working mtimes of the status snapshot's changed files. */
  mtimes: Map<string, number>;
  /**
   * The index file's identity (inode, size, mtime); null when there is
   * none. With nothing staged the unstaged diff stands in for the diff
   * against HEAD, which holds only while the index stands still.
   */
  index: string | null;
}

/**
 * errno codes a watch meets in a normal tree: a directory the user cannot
 * read, a path that went away or turned into a file between listing and
 * watching. Routine, so debug. Everything else (ENOSPC: the inotify
 * limit) is a real problem and stays at warn.
 */
const ROUTINE_WATCH_ERRNOS = new Set(['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR']);

/** Entries of a git dir whose change changes what a refresh reads. */
const GIT_DIR_ENTRIES = new Set([
  'index',
  'HEAD',
  'MERGE_HEAD',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'rebase-merge',
  'rebase-apply',
]);

/** How long a burst of file changes may settle before it refreshes. */
const CHANGE_SETTLE_MS = 100;
/** The least time between the end of one change-driven refresh and the start of the next. */
const MIN_REFRESH_GAP_MS = 1000;
/** Quiet after a refresh, as a multiple of how long it took. */
const REFRESH_SPACING = 4;

/**
 * How long to wait before a refresh for a file change. A burst settles
 * first, and a refresh that took D ms is followed by at least 4·D ms of
 * quiet: under a constant stream of writes a repo spends at most a fifth
 * of its time refreshing, however large its diff.
 */
export function changeRefreshDelay(now: number, lastEnd: number, lastCostMs: number): number {
  return Math.max(CHANGE_SETTLE_MS, refreshGapLeft(now, lastEnd, lastCostMs));
}

/** How much of the quiet owed after the last refresh is still to come. */
function refreshGapLeft(now: number, lastEnd: number, lastCostMs: number): number {
  return lastEnd + Math.max(MIN_REFRESH_GAP_MS, REFRESH_SPACING * lastCostMs) - now;
}

function isGitDirName(rel: string): boolean {
  return rel === '.git' || rel.endsWith('/.git');
}

function isRoutineWatchError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' && ROUTINE_WATCH_ERRNOS.has(code);
}

/** The status of a directory git does not recognize (or that is gone). */
function noRepoStatus(): GitStatus {
  return { files: [], branch: { current: '', ahead: 0, behind: 0 }, isRepo: false };
}

/** What gatherJournalInputs hands doRefresh for the journal-observation emit. */
interface JournalInputs {
  headDiff: DiffResult;
  headOid: string;
  stashCount: number;
  operationInProgress: InProgressOperation | null;
  mtimes: Map<string, number>;
}

/**
 * Manages the working tree: file watching, status, whole-tree diffs (for hunk
 * counts and edit-time stamps), staging, and commits.
 */
export class WorkingTreeManager extends EventEmitter<WorkingTreeEventMap> {
  private repoPath: string;
  private queue: GitOperationQueue;
  private hunkTimes: HunkTimeTracker;
  private watchers: TreeWatcher[] = [];
  private treeWatcher: TreeWatcher | null = null;
  /** Bumped by each startWatching, so a slow start that was superseded stands down. */
  private watchGeneration = 0;
  private ignoreRules: IgnoreRules | null = null;
  private reloadingRules = false;
  private reloadRulesAgain = false;
  private disposed = false;

  /**
   * Whether a client is looking at this repo (in the daemon: it has an SSE
   * subscriber). A file change refreshes a viewed repo. An unviewed one
   * only goes stale, and refreshes when a client next views or reads it.
   */
  private viewed = false;
  private _stale = true;

  private changeTimer: ReturnType<typeof setTimeout> | null = null;
  /** A change landed while a full refresh or a mutation ran: it gets a refresh after. */
  private changedDuringRefresh = false;
  private lastFullRefreshEnd = 0;
  private lastFullRefreshMs = 0;

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

  /**
   * The whole-tree diffs of the last full refresh, the ones its hunk
   * counts were taken from. Replaced as a whole and never written to
   * afterwards, so a consumer can serve them as they are. Null before the
   * first full refresh, and after a status-only refresh made them stale.
   */
  private _wholeTreeDiffs: WholeTreeDiffs | null = null;
  private fullRefreshRunning = false;
  /** Full refreshes begun so far; each is numbered by this count. */
  private fullRefreshesBegun = 0;
  /** Readers waiting for a full refresh numbered above `after` to end. */
  private refreshWaiters: Array<{ after: number; resolve: () => void }> = [];

  /**
   * The whole-tree diffs that match the current status. When there are
   * none, waits for a full refresh, joining one that is queued or running
   * rather than queueing another behind it. Null when that refresh
   * produced none (it failed, or the repo is gone).
   */
  async wholeTreeDiffs(): Promise<WholeTreeDiffs | null> {
    await this.catchUp();
    if (this._wholeTreeDiffs) return this._wholeTreeDiffs;
    if (this.fullRefreshRunning) await this.fullRefreshEnding(this.fullRefreshesBegun - 1);
    else await this.freshFullRefresh();
    return this._wholeTreeDiffs;
  }

  /**
   * Bring the state up to date for a client about to read it: refresh when
   * it went stale, or wait out a first refresh that is still running.
   */
  async catchUp(): Promise<void> {
    if (this._stale) await this.freshFullRefresh();
    else if (this._state.status === null && this.fullRefreshRunning) {
      await this.fullRefreshEnding(this.fullRefreshesBegun - 1);
    }
  }

  /** Waits for a full refresh that begins after now: the queued one, else a new one. */
  private freshFullRefresh(): Promise<void> {
    const ended = this.fullRefreshEnding(this.fullRefreshesBegun);
    if (this.pendingRefreshKind !== 'full') {
      this.refresh().catch((err: unknown) => {
        logger.error('Refresh for a read threw', err, { repo: this.repoPath });
      });
    }
    return ended;
  }

  private fullRefreshEnding(after: number): Promise<void> {
    return new Promise((resolve) => this.refreshWaiters.push({ after, resolve }));
  }

  /** Release the readers a full refresh numbered `ended` satisfies; all of them when null. */
  private settleRefreshWaiters(ended: number | null): void {
    const waiting = this.refreshWaiters;
    this.refreshWaiters = [];
    for (const waiter of waiting) {
      if (ended === null || ended > waiter.after) waiter.resolve();
      else this.refreshWaiters.push(waiter);
    }
  }

  /**
   * Why git cannot be run in this repo right now, or null: its directory
   * is gone, or git stopped recognizing it. The daemon reads this before
   * running a git command for a request, so the answer is one status and
   * this reason rather than a 500 with simple-git's stack.
   *
   * Kept apart from state.error: a mutation that fails after the refresh
   * that found the repo gone writes its own message there, and the reason
   * must survive that.
   */
  get unavailable(): string | null {
    return this._state.status?.isRepo === false ? this.unavailableReason : null;
  }

  private unavailableReason: string | null = null;

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

  // --- File watching ---

  /**
   * Watch the repo: the working tree, one watch per directory git does not
   * ignore, and the git dirs for index, HEAD, refs and in-progress
   * operations. Returns at once; the working tree is crawled in the
   * background once its ignore rules are read.
   */
  startWatching(): void {
    // Resolve the REAL git dirs, not `<repo>/.git`: for a linked worktree
    // (bare-repo layout) `.git` is a pointer file — HEAD/index live in the
    // per-worktree dir and refs are shared in the common dir.
    const dirs = resolveGitDirs(this.repoPath);
    if (dirs === null) return;
    const generation = ++this.watchGeneration;
    this.watchGitDirs(dirs);
    this.watchWorkingTree(dirs, generation).catch((err: unknown) => {
      logger.error('Starting the working tree watcher threw', err, { repo: this.repoPath });
    });
  }

  /**
   * A watcher whose root went away watches nothing from then on. When a
   * refresh finds the repo whole again (a worktree removed and added back
   * while it was open), start watching afresh.
   */
  private reviveWatchers(): void {
    if (this.disposed || !this.watchers.some((watcher) => watcher.rootGone)) return;
    logger.debug('Watching again: a watched root came back', undefined, { repo: this.repoPath });
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
    this.treeWatcher = null;
    this.gitDirs = undefined;
    this.startWatching();
  }

  /**
   * Git writes a file as `<name>.lock` and renames it into place, so a
   * watch on the directory sees every write; the lock files themselves
   * are noise.
   */
  private watchGitDirs(dirs: GitDirs): void {
    const onCommonEntry = (rel: string): void => {
      if (rel.endsWith('.lock')) return;
      if (rel === 'info/exclude' || rel === 'info') {
        void this.reloadIgnoreRules();
        this.onRepoChange();
      } else if (rel === 'packed-refs' || rel === 'refs' || rel.startsWith('refs/')) {
        this.onRepoChange();
      }
    };
    const onGitDirEntry = (rel: string): void => {
      if (GIT_DIR_ENTRIES.has(rel)) this.onRepoChange();
    };
    const onError = (err: unknown): void => this.onWatchError('Git dir watcher error', err);

    this.watchers.push(
      new TreeWatcher(dirs.commonDir, {
        skipDir: (rel) => !(rel === 'info' || rel === 'refs' || rel.startsWith('refs/')),
        onChange: (rel) => {
          onCommonEntry(rel);
          if (dirs.gitDir === dirs.commonDir) onGitDirEntry(rel);
        },
        onError,
      })
    );
    if (dirs.gitDir !== dirs.commonDir) {
      this.watchers.push(
        new TreeWatcher(dirs.gitDir, { skipDir: () => true, onChange: onGitDirEntry, onError })
      );
    }
    for (const watcher of this.watchers) {
      watcher.start().catch((err: unknown) => {
        logger.error('Starting a git dir watcher threw', err, { repo: this.repoPath });
      });
    }
  }

  private async watchWorkingTree(dirs: GitDirs, generation: number): Promise<void> {
    const rules = await loadIgnoreRules(this.repoPath, dirs.commonDir);
    if (this.disposed || generation !== this.watchGeneration) return;
    this.ignoreRules = rules;
    const watcher = new TreeWatcher(this.repoPath, {
      skipDir: (rel) => isGitDirName(rel) || this.ignored(rel, true),
      onChange: (rel, isDir) => this.onWorkingTreeEntry(rel, isDir),
      onError: (err) => this.onWatchError('Working dir watcher error', err),
    });
    this.treeWatcher = watcher;
    this.watchers.push(watcher);
    await watcher.start();
  }

  private ignored(rel: string, isDir: boolean): boolean {
    return this.ignoreRules?.ignores(rel, isDir) ?? false;
  }

  private onWorkingTreeEntry(rel: string, isDir: boolean): void {
    if (rel === '') {
      this.onRepoChange();
      return;
    }
    if (isGitDirName(rel)) return;
    if (rel === '.gitignore' || rel.endsWith('/.gitignore')) void this.reloadIgnoreRules();
    else if (this.ignored(rel, isDir)) return;
    this.onRepoChange();
  }

  /** Read the ignore rules again and re-decide which directories to watch. */
  private async reloadIgnoreRules(): Promise<void> {
    if (this.reloadingRules) {
      this.reloadRulesAgain = true;
      return;
    }
    const dirs = resolveGitDirs(this.repoPath);
    if (dirs === null || this.treeWatcher === null) return;
    this.reloadingRules = true;
    try {
      do {
        this.reloadRulesAgain = false;
        this.ignoreRules = await loadIgnoreRules(this.repoPath, dirs.commonDir);
        if (this.disposed) return;
        await this.treeWatcher.resync();
      } while (this.reloadRulesAgain && !this.disposed);
    } catch (err) {
      logger.error('Reloading the ignore rules threw', err, { repo: this.repoPath });
    } finally {
      this.reloadingRules = false;
    }
  }

  /**
   * Watcher errors go to the log, and the ones that are not routine also
   * to the header (cleared by the next refresh): a header line the user
   * did not catch is gone for good.
   */
  private onWatchError(what: string, err: unknown): void {
    if (isRoutineWatchError(err)) {
      logger.debug(what, err, { repo: this.repoPath });
      return;
    }
    logger.warn(what, err, { repo: this.repoPath });
    this.setError(`${what}: ${err instanceof Error ? err.message : String(err)}`);
  }

  dispose(): void {
    this.disposed = true;
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
    this.treeWatcher = null;
    if (this.changeTimer !== null) clearTimeout(this.changeTimer);
    this.changeTimer = null;
    this.settleRefreshWaiters(null);
  }

  // --- Viewing and staleness ---

  /** Changed on disk since the last full refresh began, while nobody looked; or never read. */
  get stale(): boolean {
    return this._stale;
  }

  /** Mark the state out of date; the next view or read refreshes it. */
  markStale(): void {
    this._stale = true;
    this._wholeTreeDiffs = null;
  }

  /** A client started or stopped looking at this repo. Starting brings a stale state up to date. */
  setViewed(viewed: boolean): void {
    this.viewed = viewed;
    if (viewed && this._stale) this.requestRefresh('full');
  }

  /** The working tree or the repo's git state changed on disk. */
  private onRepoChange(): void {
    if (this.disposed) return;
    if (!this.viewed) {
      this.markStale();
      return;
    }
    this.scheduleChangeRefresh();
  }

  private scheduleChangeRefresh(): void {
    if (this.changeTimer !== null) return;
    this.armChangeTimer(
      changeRefreshDelay(performance.now(), this.lastFullRefreshEnd, this.lastFullRefreshMs)
    );
  }

  private armChangeTimer(delay: number): void {
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null;
      this.runChangeRefresh();
    }, delay);
  }

  private runChangeRefresh(): void {
    if (this.disposed) return;
    if (!this.viewed) {
      this.markStale();
      return;
    }
    // A queued full refresh has not read anything yet, so it covers this.
    if (this.pendingRefreshKind === 'full') return;
    // A running refresh may have read the file already, and a mutation's
    // own refresh may be status-only: either way this one waits for it.
    if (this.fullRefreshRunning || this.queue.hasPendingMutations()) {
      this.changedDuringRefresh = true;
      return;
    }
    // A refresh may have ended since the timer was set: keep the spacing.
    const left = refreshGapLeft(performance.now(), this.lastFullRefreshEnd, this.lastFullRefreshMs);
    if (left > 0) {
      this.armChangeTimer(left);
      return;
    }
    this.requestRefresh('full');
  }

  /** A change that waited for the refresh that just ended gets its own. */
  private resumeDeferredChange(): void {
    if (!this.changedDuringRefresh) return;
    this.changedDuringRefresh = false;
    this.scheduleChangeRefresh();
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

  /**
   * The KIND of the refresh currently coalesced into the queue's pending
   * slot. Full and status-only refreshes must not share one anonymous
   * flag: a stage+commit within the debounce window used to swallow an
   * edit's full refresh into a pending status-only one, silently folding
   * the edit into the journal's commit boundary. A full request UPGRADES
   * a pending status-only slot; a status request never downgrades a full.
   */
  private pendingRefreshKind: 'full' | 'status' | null = null;

  scheduleRefresh(): void {
    this.requestRefresh('full');
  }

  scheduleStatusRefresh(): void {
    this.requestRefresh('status');
  }

  private requestRefresh(kind: 'full' | 'status'): void {
    if (this.pendingRefreshKind !== null) {
      // One slot is already queued: upgrade it if this request is
      // stronger. (Never enqueue a second slot — the coalescing the
      // queue's own flag used to provide, minus the kind blindness.)
      if (kind === 'full') this.pendingRefreshKind = 'full';
      return;
    }
    // Mirrors the queue's own guard: while mutations are pending, the
    // last mutation triggers its own refresh.
    if (this.queue.hasPendingMutations()) return;

    this.pendingRefreshKind = kind;
    this.queue.scheduleRefresh(async () => {
      // Read the slot at execution time: it may have been upgraded to
      // 'full' while this callback sat in the queue.
      const pending = this.pendingRefreshKind ?? 'full';
      this.pendingRefreshKind = null;
      if (pending === 'full') await this.doRefresh();
      else await this.doStatusRefresh();
    });
  }

  /**
   * An open repo git can no longer run in: its directory was deleted, or
   * git stopped recognizing it (.git deleted or unreadable). The header
   * says so, `unavailable` reports it; this logs it once, on the way in,
   * not on every refresh while it stays that way.
   */
  private notARepo(status: GitStatus, reason: string): void {
    if (this._state.status?.isRepo !== false) {
      logger.warn(`${reason} (was open as one)`, undefined, { repo: this.repoPath });
    }
    this.unavailableReason = reason;
    this._wholeTreeDiffs = null;
    this.updateState({ status, isLoading: false, error: reason });
  }

  /**
   * A refresh that threw. A vanished directory is the not-a-repo case,
   * not a transient failure: simple-git throws before running git, and
   * would on every refresh and every request until the repo is closed.
   * Anything else (index.lock contention, permissions) keeps the previous
   * status and surfaces the error instead of wiping the file list.
   */
  private refreshFailed(what: string, err: unknown): void {
    if (!fs.existsSync(this.repoPath)) {
      this.notARepo(noRepoStatus(), 'Repository directory no longer exists');
      return;
    }
    logger.warn(what, err, { repo: this.repoPath });
    this.updateState({
      isLoading: false,
      error: err instanceof Error ? err.message : 'Unknown error',
    });
  }

  private async doStatusRefresh(): Promise<void> {
    try {
      const newStatus = await getStatus(this.repoPath);
      if (!newStatus.isRepo) {
        this.notARepo(newStatus, 'Not a git repository');
        return;
      }
      this._wholeTreeDiffs = null;
      this.updateState({
        status: newStatus,
        mtimes: this.statMtimes(newStatus),
        isLoading: false,
      });
    } catch (err) {
      this.refreshFailed('Status refresh failed', err);
    } finally {
      this.resumeDeferredChange();
    }
  }

  async refresh(): Promise<void> {
    await this.queue.enqueue(() => this.doRefresh());
  }

  private async doRefresh(): Promise<void> {
    this.fullRefreshRunning = true;
    const number = ++this.fullRefreshesBegun;
    // What happens on disk from here on gets its own event.
    this._stale = false;
    const started = performance.now();
    try {
      await this.readFullState();
    } finally {
      this.fullRefreshRunning = false;
      this.lastFullRefreshEnd = performance.now();
      this.lastFullRefreshMs = this.lastFullRefreshEnd - started;
      this.settleRefreshWaiters(number);
      this.resumeDeferredChange();
    }
  }

  private async readFullState(): Promise<void> {
    this.updateState({ isLoading: true, error: null });

    // Gather-start for the journal's write-during-window guard: any
    // observation section path whose mtime lands AFTER this instant was
    // written DURING the read window (a slow external checkout burst)
    // and tears the observation. Captured before the status read so the
    // whole window is covered. Wall clock on purpose — it is compared
    // against file mtimes, which are wall clock too.
    const gatherStart = Date.now();

    // The journal's torn-window guard: capture HEAD's oid BEFORE the
    // status read so the status snapshot sits inside the double-oid
    // window (gatherJournalInputs re-reads it after the diff reads).
    // A failed read only skips this tick's observation, never the
    // refresh itself. Debug, not warn: an unborn branch (a repo with no
    // commit yet) fails this on every refresh, and that is not a fault.
    const oidBefore = await getHeadOid(this.repoPath).catch((err: unknown) => {
      logger.debug('HEAD oid unreadable; journal observation skipped', err, {
        repo: this.repoPath,
      });
      return null;
    });

    try {
      const newStatus = await getStatus(this.repoPath);

      if (!newStatus.isRepo) {
        this.notARepo(newStatus, 'Not a git repository');
        return;
      }
      this.reviveWatchers();

      // Stash list and in-progress operation are shared repo state (they
      // cross the daemon wire), so a full refresh recomputes them too.
      // They are read once, as the journal guard's "before" snapshot,
      // taken before any diff is read so the window it opens covers them
      // all; the state and the guard used to spawn the same two git
      // processes twice. Plain git functions, not loadStashList: this
      // already runs inside the queue, so re-enqueueing would deadlock.
      const guardBefore = await this.snapshotJournalGuard(newStatus);
      const { stashList, operation } = guardBefore;

      // A whole-tree diff git cannot make (a tracked file it cannot read,
      // a FIFO in a file's place) leaves the diffs empty and says why in
      // the header; the status still updates.
      let diffFailure: string | null = null;
      const readWholeTree = (staged: boolean): Promise<DiffResult | null> =>
        getWholeTreeDiff(this.repoPath, staged).catch((err: unknown) => {
          logger.warn(`Whole-tree diff${staged ? ' --cached' : ''} failed`, err, {
            repo: this.repoPath,
          });
          diffFailure ??= err instanceof Error ? err.message : String(err);
          return null;
        });

      // Staged first. With nothing staged the index matches HEAD, so the
      // unstaged diff (index to worktree) IS the diff against HEAD the
      // journal needs, byte for byte, and one read serves both: on a
      // tree with a large diff that is a third of the refresh. "Nothing
      // staged" takes the status too: a conflict outside an operation (a
      // stash pop) leaves `--cached` printing only a note. The guard's
      // index leg discards the observation if the index moved.
      const stagedRead = await readWholeTree(true);
      const unstagedRead = readWholeTree(false);
      const nothingStaged =
        stagedRead !== null &&
        stagedRead.lines.length === 0 &&
        newStatus.files.every((f) => !f.staged && f.status !== 'conflicted');
      const readHeadDiff = nothingStaged
        ? async (): Promise<DiffResult> => {
            const unstaged = await unstagedRead;
            if (unstaged === null) throw new Error('the unstaged diff failed');
            return unstaged;
          }
        : (oid: string) => getDiffAgainstHead(this.repoPath, oid);
      // The journal inputs ride along in the same queue slot; their
      // gather never throws (null = skip this tick's observation).
      const [unstagedResult, journalInputs] = await Promise.all([
        unstagedRead,
        this.gatherJournalInputs(newStatus, oidBefore, gatherStart, guardBefore, readHeadDiff),
      ]);
      const allUnstagedDiff = unstagedResult ?? { lines: [] };
      const allStagedDiff = stagedRead ?? { lines: [] };

      const hunkCounts: FileHunkCounts = {
        unstaged: countHunksPerFile(rawFromLines(allUnstagedDiff.lines)),
        staged: countHunksPerFile(rawFromLines(allStagedDiff.lines)),
      };

      // Observe every hunk so first-seen stamps are locked in as soon as a
      // change appears, then drop stamps for hunks that are gone
      this.hunkTimes.stampTree([allUnstagedDiff, allStagedDiff]);

      const mtimes = this.statMtimes(newStatus);

      this._wholeTreeDiffs = { unstaged: allUnstagedDiff, staged: allStagedDiff };
      this.updateState({
        status: newStatus,
        hunkCounts,
        stashList,
        operationInProgress: operation,
        mtimes,
        isLoading: false,
        error: diffFailure,
      });

      if (journalInputs !== null) {
        // stashCount/operationInProgress/mtimes come from the guard's
        // AFTER snapshot, the end of the observation window, so the
        // observation is internally consistent.
        this.emit('journal-observation', {
          status: newStatus,
          headDiff: journalInputs.headDiff,
          headOid: journalInputs.headOid,
          stashCount: journalInputs.stashCount,
          operationInProgress: journalInputs.operationInProgress,
          mtimes: journalInputs.mtimes,
          at: Date.now(),
        });
      }
    } catch (err) {
      // Surfaced in the header, and logged: the header clears on the next
      // refresh, and a refresh that keeps failing is what a log is for.
      this.refreshFailed('Refresh failed', err);
    }
  }

  /**
   * Snapshot the tear-guard facts: in-progress operation, stash list,
   * and the working mtimes of the status snapshot's changed files. Taken
   * once BEFORE the diff reads (by doRefresh, which also feeds the
   * operation and stash list into the state) and once AFTER by
   * gatherJournalInputs.
   */
  private async snapshotJournalGuard(status: GitStatus): Promise<JournalGuardSnapshot> {
    const [operation, stashList] = await Promise.all([
      getInProgressOperation(this.repoPath),
      gitGetStashList(this.repoPath),
    ]);
    return { operation, stashList, mtimes: this.statMtimes(status), index: this.indexIdentity() };
  }

  private gitDirs: GitDirs | null | undefined;

  private indexIdentity(): string | null {
    if (this.gitDirs === undefined) this.gitDirs = resolveGitDirs(this.repoPath);
    if (this.gitDirs === null) return null;
    try {
      const stat = fs.statSync(path.join(this.gitDirs.gitDir, 'index'));
      return `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    } catch {
      // No index yet: a repo nothing was ever added to.
      return null;
    }
  }

  private static journalGuardMoved(a: JournalGuardSnapshot, b: JournalGuardSnapshot): boolean {
    if (a.operation !== b.operation || a.stashList.length !== b.stashList.length) return true;
    if (a.index !== b.index) return true;
    if (a.mtimes.size !== b.mtimes.size) return true;
    for (const [p, t] of a.mtimes) {
      if (b.mtimes.get(p) !== t) return true;
    }
    return false;
  }

  /**
   * The tear guard's write-during-window leg. The pre/post mtime
   * snapshots cover only the STATUS snapshot's changed files — a slow
   * external checkout rewrites exactly the files that were still clean
   * at the status read, so their sections surface in the just-read
   * headDiff with no snapshot to compare against. Stat every section
   * path of the observation (the headDiff's section keys plus the
   * untracked paths): an mtime STRICTLY newer than gatherStart means
   * the file was written during the read window — torn. Strictly newer
   * than gatherStart, never the pre-window snapshot: a legit save that
   * TRIGGERED this refresh happened before gatherStart (the watcher
   * debounces ~100ms), so it passes — only a write inside the few-ms
   * read window (checkout/burst) discards, no starvation under normal
   * editing. Stat failures are deletion sections — nothing on disk to
   * have been written.
   */
  private sectionWrittenDuringGather(
    status: GitStatus,
    present: Set<string>,
    gatherStart: number
  ): boolean {
    const sectionPaths = new Set(present);
    for (const file of status.files) {
      if (file.status === 'untracked') sectionPaths.add(file.path);
    }
    for (const sectionPath of sectionPaths) {
      try {
        const stat = fs.statSync(path.join(this.repoPath, sectionPath));
        // Compare at whole-ms precision: Date.now() has ms resolution
        // while mtimeMs can carry fractional ms — a write in the SAME
        // millisecond as the capture must not read as "newer".
        if (Math.floor(stat.mtimeMs) > gatherStart) return true;
      } catch {
        // deleted/renamed — nothing on disk to have been written
      }
    }
    return false;
  }

  /**
   * Gather the journal's observation inputs, inside the same queue slot as
   * the refresh. Returns null — no observation this tick — on ANY failure
   * or when the window was TORN: HEAD moved between the two oid reads, or
   * an operation started/ended, the stash count changed, the index was
   * written, or a changed file's mtime moved between the two guard
   * snapshots, or any section
   * path of the just-read diff was WRITTEN during the read window. The
   * oid double-read alone is not enough — a slow external `git checkout`/
   * `stash`/`merge` rewrites the worktree over seconds while HEAD moves
   * last, and would otherwise classify a half-updated tree as hundreds of
   * phantom entries. A skipped tick is always safe: the next observation
   * re-derives everything from scratch. Note the diff read
   * (readHeadDiff: getDiffAgainstHead, or the unstaged getWholeTreeDiff
   * when nothing is staged) THROWS on failure by design — a swallowed
   * empty diff would read as a phantom mass revert.
   *
   * oidBefore is captured by doRefresh at the TOP of the refresh, BEFORE
   * the status read, so the status snapshot itself sits inside the guarded
   * window; null means that capture failed and this tick is skipped.
   * gatherStart is captured there too — the write-during-window guard's
   * floor (see sectionWrittenDuringGather). guardBefore is the "before"
   * snapshot doRefresh took before reading any diff, so the window opens
   * before the HEAD diff is read.
   *
   * Untracked files are invisible to `git diff HEAD`, so their synthetic
   * sections (getDiffForUntracked) are appended here. That read catches to
   * empty; a missing section for a status-listed untracked path is the
   * journal's cue to defer that path, never to classify it.
   */
  private async gatherJournalInputs(
    status: GitStatus,
    oidBefore: string | null,
    gatherStart: number,
    guardBefore: JournalGuardSnapshot,
    readHeadDiff: (oid: string) => Promise<DiffResult>
  ): Promise<JournalInputs | null> {
    if (oidBefore === null) return null;
    try {
      const headDiff = await readHeadDiff(oidBefore);
      const present = new Set(splitDiffByFile(headDiff).keys());
      const lines = [...headDiff.lines];
      await this.appendUntrackedSections(status, present, lines);

      const oidAfter = await getHeadOid(this.repoPath);
      if (oidBefore !== oidAfter) return null; // torn window: HEAD moved
      const guardAfter = await this.snapshotJournalGuard(status);
      if (WorkingTreeManager.journalGuardMoved(guardBefore, guardAfter)) return null; // torn window
      if (this.sectionWrittenDuringGather(status, present, gatherStart)) return null; // torn window

      return {
        headDiff: { lines },
        headOid: oidAfter,
        stashCount: guardAfter.stashList.length,
        operationInProgress: guardAfter.operation,
        mtimes: guardAfter.mtimes,
      };
    } catch (err) {
      // Torn windows return null above; reaching here means a git read
      // failed. The refresh this rides in fails on the same cause and
      // logs it at warn, so this is the detail behind that line, at debug.
      logger.debug('Journal observation skipped: git read failed', err, { repo: this.repoPath });
      return null;
    }
  }

  /**
   * Append each untracked file as a synthetic diff section: read and
   * size-capped when small enough, a header-only OVERSIZE_UNTRACKED_MARKER
   * section when too large (so the journal appends a created entry with
   * diff: null instead of deferring the file forever).
   *
   * Paths already present in the HEAD diff are skipped: an external
   * `git add` between the status read and the diff read makes an
   * untracked path appear in `git diff HEAD`, and a second synthetic
   * section for the same path would merge with it in splitDiffByFile
   * into one corrupt hunk (headers counted as insertions).
   */
  private async appendUntrackedSections(
    status: GitStatus,
    present: Set<string>,
    lines: DiffLine[]
  ): Promise<void> {
    const seen = new Set<string>();
    for (const file of status.files) {
      if (file.status !== 'untracked' || seen.has(file.path) || present.has(file.path)) continue;
      seen.add(file.path);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(path.join(this.repoPath, file.path));
      } catch {
        continue; // vanished mid-tick — defer
      }
      if (!stat.isFile()) continue;
      if (stat.size > MAX_UNTRACKED_JOURNAL_BYTES) {
        this.appendOversizeSection(file.path, stat, lines);
        continue;
      }
      const untrackedDiff = await getDiffForUntracked(this.repoPath, file.path);
      if (untrackedDiff.lines.length === 0) continue; // caught-to-empty — defer
      lines.push(...untrackedDiff.lines);
    }
  }

  /**
   * A header-only stand-in section for an oversize untracked file. The
   * size/mtime suffix makes the section's content (and so the journal's
   * silence hash) change when the file changes: created once, then an
   * edited entry per later save — always with diff: null.
   */
  private appendOversizeSection(filePath: string, stat: fs.Stats, lines: DiffLine[]): void {
    const header = [
      `diff --git ${quoteGitPath('a/' + filePath)} ${quoteGitPath('b/' + filePath)}`,
      'new file mode 100644',
      `${OVERSIZE_UNTRACKED_MARKER} size=${stat.size} mtime=${Math.round(stat.mtimeMs)}`,
    ];
    lines.push(...header.map((content): DiffLine => ({ type: 'header', content })));
  }

  // --- Staging operations ---

  /**
   * A mutation that git refused: the reason goes to the header (and from
   * there to the client that asked) and to the log. The daemon answers
   * these from state, never by throwing, so this is the failure's one
   * chance to leave a trace with the repo and the file named.
   */
  private failed(what: string, err: unknown, file?: string): void {
    logger.warn(`Failed to ${what}`, err, { repo: this.repoPath, file });
    this.updateState({
      error: `Failed to ${what}: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  async stage(file: FileEntry): Promise<void> {
    try {
      await this.queue.enqueueMutation(() => stageFile(this.repoPath, file.path));
      this.scheduleStatusRefresh();
    } catch (err) {
      await this.refresh();
      this.failed(`stage ${file.path}`, err, file.path);
    }
  }

  async unstage(file: FileEntry): Promise<void> {
    try {
      await this.queue.enqueueMutation(() => unstageFile(this.repoPath, file.path));
      this.scheduleStatusRefresh();
    } catch (err) {
      await this.refresh();
      this.failed(`unstage ${file.path}`, err, file.path);
    }
  }

  async stageHunk(patch: string): Promise<void> {
    try {
      await this.queue.enqueueMutation(async () => gitStageHunk(this.repoPath, patch));
      this.scheduleRefresh();
    } catch (err) {
      await this.refresh();
      this.failed('stage hunk', err);
    }
  }

  async unstageHunk(patch: string): Promise<void> {
    try {
      await this.queue.enqueueMutation(async () => gitUnstageHunk(this.repoPath, patch));
      this.scheduleRefresh();
    } catch (err) {
      await this.refresh();
      this.failed('unstage hunk', err);
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
      this.failed(`discard ${file.path}`, err, file.path);
    }
  }

  async stageAll(): Promise<void> {
    try {
      await this.queue.enqueueMutation(() => gitStageAll(this.repoPath));
      await this.refresh();
    } catch (err) {
      this.failed('stage all', err);
    }
  }

  async unstageAll(): Promise<void> {
    try {
      await this.queue.enqueueMutation(() => gitUnstageAll(this.repoPath));
      await this.refresh();
    } catch (err) {
      this.failed('unstage all', err);
    }
  }

  // --- Commit ---

  async commit(message: string, amend: boolean = false): Promise<void> {
    try {
      await this.queue.enqueue(() => gitCommit(this.repoPath, message, amend));
      await this.refresh();
    } catch (err) {
      this.failed('commit', err);
    }
  }

  // --- Stash list ---

  async loadStashList(): Promise<void> {
    try {
      const stashList = await this.queue.enqueue(() => gitGetStashList(this.repoPath));
      this.updateState({ stashList });
    } catch (err) {
      // The list on screen stays as it was, so the log is the only trace.
      logger.warn('Failed to load the stash list', err, { repo: this.repoPath });
    }
  }
}
