/**
 * Unit tests for WorkingTreeManager.
 *
 * The manager is constructed against a fixture repo without calling
 * startWatching(), so no chokidar watchers or timers are created.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { rawFromLines } from '../git/diffParse.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WorkingTreeManager, GitState } from './WorkingTreeManager.js';
import { GitOperationQueue } from './GitOperationQueue.js';
import { JournalManager, createJournalStore } from './JournalManager.js';
import { FileEntry, GitStatus, InProgressOperation } from '../git/status.js';
import type { DiffResult } from '../git/diff.js';
import { OVERSIZE_UNTRACKED_MARKER } from '../types/journal.js';
import type { JournalEntry, JournalHunkEntry, JournalObservation } from '../types/journal.js';
import {
  createFixtureRepo,
  removeFixtureRepo,
  writeFixtureFile,
  gitExec,
} from '../git/test-helpers.js';

describe('WorkingTreeManager', () => {
  const REPO_NAME = 'working-tree-manager-test';
  let repoPath: string;
  let queue: GitOperationQueue;
  let manager: WorkingTreeManager;

  beforeAll(() => {
    repoPath = createFixtureRepo(REPO_NAME);
    writeFixtureFile(repoPath, 'tracked.txt', 'tracked content\n');
    writeFixtureFile(repoPath, 'other.txt', 'other content\n');
    gitExec(repoPath, 'add tracked.txt other.txt');
    gitExec(repoPath, 'commit -m "initial"');
  });

  afterAll(() => {
    removeFixtureRepo(REPO_NAME);
  });

  beforeEach(() => {
    queue = new GitOperationQueue();
    manager = new WorkingTreeManager(repoPath, queue);
  });

  /** Reset the working tree to a clean state between tests */
  function resetRepo(): void {
    gitExec(repoPath, 'checkout -- .');
    gitExec(repoPath, 'reset HEAD');
    gitExec(repoPath, 'clean -fd');
  }

  /**
   * Wait for any operations already scheduled on the queue (e.g. the status
   * refresh a mutation schedules) to finish. The queue is strictly FIFO, so
   * an enqueued no-op resolves only after everything before it ran.
   */
  async function drainQueue(): Promise<void> {
    await queue.enqueue(async () => {});
  }

  describe('refresh', () => {
    test('populates status with staged, unstaged, and untracked files', async () => {
      writeFixtureFile(repoPath, 'tracked.txt', 'staged change\n');
      gitExec(repoPath, 'add tracked.txt');
      writeFixtureFile(repoPath, 'other.txt', 'unstaged change\n');
      writeFixtureFile(repoPath, 'new.txt', 'brand new\n');

      const events: GitState[] = [];
      manager.on('state-change', (state) => events.push(state));

      await manager.refresh();

      const state = manager.state;
      expect(state.status).not.toBeNull();
      expect(state.status!.isRepo).toBe(true);
      expect(state.isLoading).toBe(false);
      expect(state.error).toBeNull();

      const staged = state.status!.files.find((f) => f.path === 'tracked.txt' && f.staged);
      expect(staged).toBeDefined();
      expect(staged!.status).toBe('modified');

      const unstaged = state.status!.files.find((f) => f.path === 'other.txt' && !f.staged);
      expect(unstaged).toBeDefined();
      expect(unstaged!.status).toBe('modified');

      const untracked = state.status!.files.find((f) => f.path === 'new.txt');
      expect(untracked).toBeDefined();
      expect(untracked!.status).toBe('untracked');
      expect(untracked!.staged).toBe(false);

      expect(state.hunkCounts).not.toBeNull();
      expect(state.hunkCounts!.staged.get('tracked.txt')).toBe(1);
      expect(state.hunkCounts!.unstaged.get('other.txt')).toBe(1);

      // Refresh emits at least a loading transition and a final state
      expect(events.length).toBeGreaterThanOrEqual(2);
      expect(events[0].isLoading).toBe(true);
      expect(events[events.length - 1].isLoading).toBe(false);

      resetRepo();
    });

    test('emits one journal-observation with HEAD oid, HEAD diff, and untracked sections', async () => {
      writeFixtureFile(repoPath, 'tracked.txt', 'staged change\n');
      gitExec(repoPath, 'add tracked.txt');
      writeFixtureFile(repoPath, 'new.txt', 'brand new\n');

      const observations: JournalObservation[] = [];
      manager.on('journal-observation', (obs) => observations.push(obs));

      await manager.refresh();

      expect(observations.length).toBe(1);
      const obs = observations[0];
      expect(obs.headOid).toMatch(/^[0-9a-f]{40}$/);
      expect(obs.headOid).toBe(gitExec(repoPath, 'rev-parse HEAD').trim());
      // Staged changes are visible on the HEAD axis...
      expect(rawFromLines(obs.headDiff.lines)).toContain('diff --git a/tracked.txt b/tracked.txt');
      expect(rawFromLines(obs.headDiff.lines)).toContain('+staged change');
      // ...and the untracked file rides along as a synthetic section.
      expect(rawFromLines(obs.headDiff.lines)).toContain('diff --git a/new.txt b/new.txt');
      expect(rawFromLines(obs.headDiff.lines)).toContain('+brand new');
      expect(obs.stashCount).toBe(0);
      expect(obs.operationInProgress).toBeNull();
      expect(obs.mtimes?.has('tracked.txt')).toBe(true);

      resetRepo();
    });

    interface GatheredInputs {
      headDiff: DiffResult;
      headOid: string;
      stashCount: number;
      operationInProgress: InProgressOperation | null;
      mtimes: Map<string, number>;
    }

    /**
     * Reach the private journal gather with the oidBefore and gatherStart
     * doRefresh now captures BEFORE the status read — the torn-window
     * contract under test.
     */
    function gatherWith(
      m: WorkingTreeManager,
      status: GitStatus,
      oidBefore: string | null,
      gatherStart: number = Date.now()
    ): Promise<GatheredInputs | null> {
      return (
        m as unknown as {
          gatherJournalInputs(
            status: GitStatus,
            oidBefore: string | null,
            gatherStart: number
          ): Promise<GatheredInputs | null>;
        }
      ).gatherJournalInputs(status, oidBefore, gatherStart);
    }

    interface GuardSnap {
      operation: InProgressOperation | null;
      stashCount: number;
      mtimes: Map<string, number>;
    }

    /**
     * Make the FIRST guard snapshot (taken before the diff reads) lie, so
     * the re-read after the diffs disagrees — a deterministic stand-in
     * for an external op/stash/write landing mid-window.
     */
    function tearFirstGuard(m: WorkingTreeManager, mutate: (snap: GuardSnap) => void): void {
      const target = m as unknown as {
        snapshotJournalGuard(status: GitStatus): Promise<GuardSnap>;
      };
      const real = target.snapshotJournalGuard.bind(m);
      let first = true;
      target.snapshotJournalGuard = async (status: GitStatus) => {
        const snap = await real(status);
        if (first) {
          first = false;
          mutate(snap);
        }
        return snap;
      };
    }

    test('journal torn window: HEAD moving after the pre-status oid capture discards the observation', async () => {
      writeFixtureFile(repoPath, 'tracked.txt', 'torn window edit\n');
      await manager.refresh();
      const status = manager.state.status!;

      // The oid doRefresh would have captured at the top, before status.
      const staleOid = gitExec(repoPath, 'rev-parse HEAD').trim();

      // An external commit lands inside the guarded window.
      gitExec(repoPath, 'add tracked.txt');
      gitExec(repoPath, 'commit -m "external commit"');

      expect(await gatherWith(manager, status, staleOid)).toBeNull();

      // A capture matching the settled HEAD observes normally.
      const freshOid = gitExec(repoPath, 'rev-parse HEAD').trim();
      writeFixtureFile(repoPath, 'tracked.txt', 'post-commit edit\n');
      await manager.refresh();
      const inputs = await gatherWith(manager, manager.state.status!, freshOid);
      expect(inputs).not.toBeNull();
      expect(inputs!.headOid).toBe(freshOid);

      resetRepo();
    });

    test('journal inputs are skipped when the pre-status oid capture failed', async () => {
      await manager.refresh();
      expect(await gatherWith(manager, manager.state.status!, null)).toBeNull();
    });

    test('widened tear guard: an op, the stash count, or a changed-file mtime moving mid-window discards the observation', async () => {
      writeFixtureFile(repoPath, 'tracked.txt', 'guard edit\n');
      await manager.refresh();
      const status = manager.state.status!;
      const oid = gitExec(repoPath, 'rev-parse HEAD').trim();

      const tears: ((snap: GuardSnap) => void)[] = [
        (snap) => {
          snap.operation = 'merge'; // an operation started/ended mid-window
        },
        (snap) => {
          snap.stashCount += 1; // an external stash landed mid-window
        },
        (snap) => {
          // a tracked file was rewritten mid-window (slow external checkout)
          snap.mtimes.set('tracked.txt', (snap.mtimes.get('tracked.txt') ?? 0) - 1000);
        },
      ];
      for (const mutate of tears) {
        const torn = new WorkingTreeManager(repoPath, new GitOperationQueue());
        tearFirstGuard(torn, mutate);
        expect(await gatherWith(torn, status, oid)).toBeNull();
      }

      // A quiet window still observes, with guard-consistent extras.
      const inputs = await gatherWith(manager, status, oid);
      expect(inputs).not.toBeNull();
      expect(inputs!.stashCount).toBe(0);
      expect(inputs!.operationInProgress).toBeNull();
      expect(inputs!.mtimes.has('tracked.txt')).toBe(true);

      resetRepo();
    });

    test('a path written during the read window discards the observation (headDiff and untracked sections)', async () => {
      writeFixtureFile(repoPath, 'tracked.txt', 'window edit\n');
      writeFixtureFile(repoPath, 'new.txt', 'untracked before\n');
      await manager.refresh();
      const staleStatus = manager.state.status!;
      expect(staleStatus.files.some((f) => f.path === 'other.txt')).toBe(false);
      const oid = gitExec(repoPath, 'rev-parse HEAD').trim();

      // A slow external checkout rewrites other.txt DURING the read
      // window: it was clean at the status read, so the pre-window mtime
      // snapshot cannot see it — only its section in the just-read
      // headDiff knows it exists.
      const gatherStart = Date.now();
      writeFixtureFile(repoPath, 'other.txt', 'rewritten mid-window\n');
      const otherPath = path.join(repoPath, 'other.txt');
      const midWindow = new Date(gatherStart + 50);
      fs.utimesSync(otherPath, midWindow, midWindow);
      expect(await gatherWith(manager, staleStatus, oid, gatherStart)).toBeNull();

      // Same for an untracked section path: a rewrite BEFORE the first
      // guard snapshot leaves both snapshots agreeing, so only the
      // gather-start floor catches it. Backdate other.txt first so the
      // untracked path is the only mid-window write.
      const past = new Date(gatherStart - 5000);
      fs.utimesSync(otherPath, past, past);
      const gatherStart2 = Date.now();
      writeFixtureFile(repoPath, 'new.txt', 'rewritten mid-window\n');
      const newPath = path.join(repoPath, 'new.txt');
      const midWindow2 = new Date(gatherStart2 + 50);
      fs.utimesSync(newPath, midWindow2, midWindow2);
      expect(await gatherWith(manager, staleStatus, oid, gatherStart2)).toBeNull();

      resetRepo();
    });

    test('a normal save predating gather-start is still observed (no over-discard)', async () => {
      writeFixtureFile(repoPath, 'tracked.txt', 'normal save\n');
      // The save that TRIGGERED the observation predates gather-start
      // (the watcher debounces ~100ms before the refresh ever runs).
      const beforeGather = new Date(Date.now() - 500);
      fs.utimesSync(path.join(repoPath, 'tracked.txt'), beforeGather, beforeGather);
      await manager.refresh();
      const status = manager.state.status!;
      const oid = gitExec(repoPath, 'rev-parse HEAD').trim();

      const inputs = await gatherWith(manager, status, oid, Date.now());
      expect(inputs).not.toBeNull();
      expect(rawFromLines(inputs!.headDiff.lines)).toContain('+normal save');

      resetRepo();
    });

    test('an untracked path already in the HEAD diff (external git add mid-window) gets no second section', async () => {
      writeFixtureFile(repoPath, 'dup.txt', 'dup content\n');
      await manager.refresh();
      const staleStatus = manager.state.status!;
      expect(staleStatus.files.find((f) => f.path === 'dup.txt')?.status).toBe('untracked');

      // External `git add` between the status read and the diff read: the
      // path now shows in `git diff HEAD` while status still says untracked.
      // Without the skip, splitDiffByFile would merge the two sections for
      // one path into a corrupt hunk (headers counted as insertions).
      gitExec(repoPath, 'add dup.txt');
      const oid = gitExec(repoPath, 'rev-parse HEAD').trim();

      const inputs = await gatherWith(manager, staleStatus, oid);
      expect(inputs).not.toBeNull();
      const sections = rawFromLines(inputs!.headDiff.lines).match(/^diff --git a\/dup\.txt /gm) ?? [];
      expect(sections).toHaveLength(1);

      resetRepo();
    });

    test('an oversize untracked file journals as a header-only marker section, never deferred forever', async () => {
      writeFixtureFile(repoPath, 'big.txt', 'x'.repeat(300 * 1024) + '\n');

      const observations: JournalObservation[] = [];
      manager.on('journal-observation', (obs) => observations.push(obs));
      await manager.refresh();

      expect(observations).toHaveLength(1);
      const raw = rawFromLines(observations[0].headDiff.lines);
      expect(raw).toContain('diff --git a/big.txt b/big.txt');
      expect(raw).toContain(OVERSIZE_UNTRACKED_MARKER);
      expect(raw.length).toBeLessThan(100 * 1024); // the content is NOT embedded

      // End to end: the journal appends a created entry with a null body
      // (the diff:null promise) instead of skipping the file.
      const journal = new JournalManager(createJournalStore());
      const batches: JournalEntry[][] = [];
      journal.on('append', (batch) => batches.push(batch));
      journal.observe(observations[0]);
      const entry = batches[0]
        .filter((e): e is JournalHunkEntry => e.type === 'hunk')
        .find((e) => e.path === 'big.txt');
      expect(entry).toMatchObject({ kind: 'created', status: 'untracked', diff: null });

      resetRepo();
    });

    test('populates mtimes for changed files: stat-backed, one entry per path, deleted omitted', async () => {
      writeFixtureFile(repoPath, 'tracked.txt', 'staged change\n');
      gitExec(repoPath, 'add tracked.txt');
      writeFixtureFile(repoPath, 'tracked.txt', 'staged and unstaged change\n');
      fs.rmSync(path.join(repoPath, 'other.txt'));

      await manager.refresh();

      const state = manager.state;
      const mtimes = state.mtimes;
      expect(mtimes).not.toBeNull();

      // tracked.txt appears twice in status (staged + unstaged) but once here,
      // stamped with the real on-disk mtime.
      const pair = state.status!.files.filter((f) => f.path === 'tracked.txt');
      expect(pair.length).toBe(2);
      const onDisk = fs.statSync(path.join(repoPath, 'tracked.txt')).mtimeMs;
      expect(mtimes!.get('tracked.txt')).toBe(onDisk);

      // Deleted file is in status but has nothing on disk to stat.
      expect(state.status!.files.some((f) => f.path === 'other.txt')).toBe(true);
      expect(mtimes!.has('other.txt')).toBe(false);

      resetRepo();
    });

    test('sets isRepo false and error for a non-repo directory', async () => {
      const nonRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diffstalker-nonrepo-'));
      try {
        const nonRepoManager = new WorkingTreeManager(nonRepoDir, new GitOperationQueue());
        await nonRepoManager.refresh();

        const state = nonRepoManager.state;
        expect(state.status).not.toBeNull();
        expect(state.status!.isRepo).toBe(false);
        expect(state.error).toBe('Not a git repository');
        expect(state.isLoading).toBe(false);
      } finally {
        fs.rmSync(nonRepoDir, { recursive: true, force: true });
      }
    });
  });

  describe('refresh coalescing', () => {
    test('a full refresh UPGRADES a pending status-only refresh instead of being swallowed', async () => {
      writeFixtureFile(repoPath, 'tracked.txt', 'coalesce edit\n');
      const observations: JournalObservation[] = [];
      manager.on('journal-observation', (obs) => observations.push(obs));

      // Hold the queue so both requests land while one slot is pending —
      // the stage+commit-within-200ms shape that used to swallow the
      // edit's full refresh into the pending status-only one.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const blocked = queue.enqueue(() => gate);

      manager.scheduleStatusRefresh();
      manager.scheduleRefresh(); // must upgrade the pending slot, not be dropped

      release();
      await blocked;
      await drainQueue();

      // The slot ran as a FULL refresh: the journal observed the edit.
      expect(observations).toHaveLength(1);
      expect(manager.state.hunkCounts?.unstaged.get('tracked.txt')).toBe(1);

      resetRepo();
    });

    test('a status-only request never downgrades a pending full refresh', async () => {
      writeFixtureFile(repoPath, 'tracked.txt', 'still full\n');
      const observations: JournalObservation[] = [];
      manager.on('journal-observation', (obs) => observations.push(obs));

      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const blocked = queue.enqueue(() => gate);

      manager.scheduleRefresh();
      manager.scheduleStatusRefresh(); // must not replace the pending full

      release();
      await blocked;
      await drainQueue();

      expect(observations).toHaveLength(1); // the full refresh still ran
      resetRepo();
    });
  });

  describe('stage / unstage', () => {
    test('stage updates state after completion', async () => {
      writeFixtureFile(repoPath, 'tracked.txt', 'staged via manager\n');
      const entry: FileEntry = { path: 'tracked.txt', status: 'modified', staged: false };

      await manager.stage(entry);
      await drainQueue();

      const state = manager.state;
      expect(state.error).toBeNull();
      expect(state.status).not.toBeNull();
      const staged = state.status!.files.find((f) => f.path === 'tracked.txt' && f.staged);
      expect(staged).toBeDefined();
      expect(staged!.status).toBe('modified');

      resetRepo();
    });

    test('unstage updates state after completion', async () => {
      writeFixtureFile(repoPath, 'tracked.txt', 'staged then unstaged\n');
      gitExec(repoPath, 'add tracked.txt');
      const entry: FileEntry = { path: 'tracked.txt', status: 'modified', staged: true };

      await manager.unstage(entry);
      await drainQueue();

      const state = manager.state;
      expect(state.error).toBeNull();
      expect(state.status).not.toBeNull();
      const staged = state.status!.files.find((f) => f.path === 'tracked.txt' && f.staged);
      expect(staged).toBeUndefined();
      const unstaged = state.status!.files.find((f) => f.path === 'tracked.txt' && !f.staged);
      expect(unstaged).toBeDefined();
      expect(unstaged!.status).toBe('modified');

      resetRepo();
    });
  });

  describe('error recovery', () => {
    test('failed stage sets error and a subsequent refresh clears it', async () => {
      const entry: FileEntry = { path: 'does-not-exist.txt', status: 'modified', staged: false };

      await manager.stage(entry);

      expect(manager.state.error).not.toBeNull();
      expect(manager.state.error).toContain('Failed to stage does-not-exist.txt');

      await manager.refresh();

      expect(manager.state.error).toBeNull();
      expect(manager.state.status).not.toBeNull();
      expect(manager.state.status!.isRepo).toBe(true);
    });
  });

  describe('setError', () => {
    test('sets state.error and emits state-change', () => {
      const events: GitState[] = [];
      manager.on('state-change', (state) => events.push(state));

      manager.setError('something went wrong');

      expect(manager.state.error).toBe('something went wrong');
      expect(events).toHaveLength(1);
      expect(events[0].error).toBe('something went wrong');
    });

    test('is cleared by the next refresh', async () => {
      manager.setError('stale error');
      expect(manager.state.error).toBe('stale error');

      await manager.refresh();

      expect(manager.state.error).toBeNull();
    });
  });
});
