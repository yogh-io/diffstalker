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
  getDiffAgainstHead,
  getDiffForUntracked,
  getHeadOid,
  countHunksPerFile,
  DiffLine,
  DiffResult,
  FileHunkCounts,
} from '../git/diff.js';
import { HunkTimeTracker } from '../git/hunkTimes.js';
import { rawFromLines } from '../git/diffParse.js';
import { resolveGitDirs } from '../git/worktree.js';
import { splitDiffByFile } from '../view/splitDiffByFile.js';
import { OVERSIZE_UNTRACKED_MARKER } from '../types/journal.js';
import type { JournalObservation } from '../types/journal.js';

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
  'journal-observation': [JournalObservation];
  error: [string];
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
  stashCount: number;
  /** Working mtimes of the status snapshot's changed files. */
  mtimes: Map<string, number>;
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
 * Whether the working-tree watcher must not touch this path: anything that is
 * neither a regular file nor a directory, so a FIFO, socket, or device.
 *
 * Opening a FIFO blocks until someone opens the other end to write. Under bun
 * that block lands on the main thread, so a pipe appearing in a watched tree
 * freezes the whole daemon — every request, /health included, not just the one
 * that touched it. Node walks the same path without trouble, which makes this a
 * workaround for a runtime difference rather than for chokidar. `ignored` is
 * the only hook that runs BEFORE chokidar opens anything, so the check has to
 * live here; by the time an event handler sees the path it is already too late.
 *
 * Two things make the obvious version wrong:
 *  - chokidar calls `ignored` twice per path, once with stats and once without,
 *    so `stats` cannot be relied on being there.
 *  - the stats it does pass describe the LINK, not its target. Rejecting
 *    everything that fails isFile() would quietly stop every symlink in the
 *    tree being watched, so symlinks get resolved here instead. statSync
 *    follows the link and is safe on a pipe: stat never blocks, only open does.
 *
 * Worth re-testing when bun updates — if the runtime stops blocking, this can go.
 */
function isUnwatchable(filePath: string, stats?: fs.Stats): boolean {
  let st = stats;
  if (!st || st.isSymbolicLink()) {
    try {
      st = fs.statSync(filePath);
    } catch {
      // Vanished, or unreadable. Leave it to chokidar, as before.
      return false;
    }
  }
  return !st.isFile() && !st.isDirectory();
}

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
    // Resolve the REAL git dirs, not `<repo>/.git`: for a linked worktree
    // (bare-repo layout) `.git` is a pointer file — HEAD/index live in the
    // per-worktree dir and refs are shared in the common dir. Watching
    // `<repo>/.git/{HEAD,index,refs}` there watches paths that never exist,
    // so a commit/rebase/fetch would fire nothing and the view would go
    // stale. `commonDir` picks up `packed-refs` (git fetch / pack-refs) for
    // plain repos too.
    const dirs = resolveGitDirs(this.repoPath);
    if (dirs === null) return;

    const indexFile = path.join(dirs.gitDir, 'index');
    const headFile = path.join(dirs.gitDir, 'HEAD');
    const refsDir = path.join(dirs.commonDir, 'refs');
    const packedRefs = path.join(dirs.commonDir, 'packed-refs');
    const gitignorePath = path.join(this.repoPath, '.gitignore');

    this.gitWatcher = watch([indexFile, headFile, refsDir, packedRefs, gitignorePath], {
      persistent: true,
      ignoreInitial: true,
      usePolling: true,
      interval: 100,
    });

    this.ignorers = this.loadGitignores();

    this.workingDirWatcher = watch(this.repoPath, {
      persistent: true,
      ignoreInitial: true,
      ignored: (filePath: string, stats?: fs.Stats) => {
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
        // After the gitignore walk, so an ignored path never pays for the stat.
        return isUnwatchable(filePath, stats);
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

  private async doStatusRefresh(): Promise<void> {
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
  }

  async refresh(): Promise<void> {
    await this.queue.enqueue(() => this.doRefresh());
  }

  private async doRefresh(): Promise<void> {
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
    // refresh itself.
    const oidBefore = await getHeadOid(this.repoPath).catch(() => null);

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
      // The journal inputs ride along in the same queue slot; their
      // gather never throws (null = skip this tick's observation).
      const [allUnstagedDiff, allStagedDiff, stashList, operationInProgress, journalInputs] =
        await Promise.all([
          getDiff(this.repoPath, undefined, false),
          getDiff(this.repoPath, undefined, true),
          gitGetStashList(this.repoPath),
          getInProgressOperation(this.repoPath),
          this.gatherJournalInputs(newStatus, oidBefore, gatherStart),
        ]);

      const hunkCounts: FileHunkCounts = {
        unstaged: countHunksPerFile(rawFromLines(allUnstagedDiff.lines)),
        staged: countHunksPerFile(rawFromLines(allStagedDiff.lines)),
      };

      // Observe every hunk so first-seen stamps are locked in as soon as a
      // change appears, then drop stamps for files that no longer have changes
      this.hunkTimes.stamp(allUnstagedDiff);
      this.hunkTimes.stamp(allStagedDiff);
      this.hunkTimes.prune(new Set(newStatus.files.map((f) => f.path)));

      const mtimes = this.statMtimes(newStatus);

      this.updateState({
        status: newStatus,
        hunkCounts,
        stashList,
        operationInProgress,
        mtimes,
        isLoading: false,
      });

      if (journalInputs !== null) {
        // stashCount/operationInProgress/mtimes come from the gather's
        // own guarded window (not the parallel state reads above), so
        // the observation is internally consistent.
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
      this.updateState({
        isLoading: false,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }

  /**
   * Snapshot the tear-guard facts: in-progress operation, stash count,
   * and the working mtimes of the status snapshot's changed files. Taken
   * once BEFORE the diff reads and once AFTER by gatherJournalInputs.
   */
  private async snapshotJournalGuard(status: GitStatus): Promise<JournalGuardSnapshot> {
    const [operation, stashes] = await Promise.all([
      getInProgressOperation(this.repoPath),
      gitGetStashList(this.repoPath),
    ]);
    return { operation, stashCount: stashes.length, mtimes: this.statMtimes(status) };
  }

  private static journalGuardMoved(a: JournalGuardSnapshot, b: JournalGuardSnapshot): boolean {
    if (a.operation !== b.operation || a.stashCount !== b.stashCount) return true;
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
   * an operation started/ended, the stash count changed, or a changed
   * file's mtime moved between the two guard snapshots, or any section
   * path of the just-read diff was WRITTEN during the read window. The
   * oid double-read alone is not enough — a slow external `git checkout`/
   * `stash`/`merge` rewrites the worktree over seconds while HEAD moves
   * last, and would otherwise classify a half-updated tree as hundreds of
   * phantom entries. A skipped tick is always safe: the next observation
   * re-derives everything from scratch. Note the diff read
   * (getDiffAgainstHead) THROWS on failure by design — a swallowed empty
   * diff would read as a phantom mass revert.
   *
   * oidBefore is captured by doRefresh at the TOP of the refresh, BEFORE
   * the status read, so the status snapshot itself sits inside the guarded
   * window; null means that capture failed and this tick is skipped.
   * gatherStart is captured there too — the write-during-window guard's
   * floor (see sectionWrittenDuringGather).
   *
   * Untracked files are invisible to `git diff HEAD`, so their synthetic
   * sections (getDiffForUntracked) are appended here. That read catches to
   * empty; a missing section for a status-listed untracked path is the
   * journal's cue to defer that path, never to classify it.
   */
  private async gatherJournalInputs(
    status: GitStatus,
    oidBefore: string | null,
    gatherStart: number
  ): Promise<JournalInputs | null> {
    if (oidBefore === null) return null;
    try {
      const guardBefore = await this.snapshotJournalGuard(status);

      const headDiff = await getDiffAgainstHead(this.repoPath);
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
        stashCount: guardAfter.stashCount,
        operationInProgress: guardAfter.operation,
        mtimes: guardAfter.mtimes,
      };
    } catch {
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
      `diff --git a/${filePath} b/${filePath}`,
      'new file mode 100644',
      `${OVERSIZE_UNTRACKED_MARKER} size=${stat.size} mtime=${Math.round(stat.mtimeMs)}`,
    ];
    lines.push(...header.map((content): DiffLine => ({ type: 'header', content })));
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
