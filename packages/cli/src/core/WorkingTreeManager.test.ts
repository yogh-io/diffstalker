/**
 * Unit tests for WorkingTreeManager.
 *
 * The manager is constructed against a fixture repo without calling
 * startWatching(), so no chokidar watchers or timers are created.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WorkingTreeManager, GitState } from './WorkingTreeManager.js';
import { GitOperationQueue } from './GitOperationQueue.js';
import { FileEntry } from '../git/status.js';
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

    test('sets isRepo false and error for a non-repo directory', async () => {
      const nonRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diffstalker-nonrepo-'));
      try {
        const nonRepoManager = new WorkingTreeManager(nonRepoDir, new GitOperationQueue());
        await nonRepoManager.refresh();

        const state = nonRepoManager.state;
        expect(state.status).not.toBeNull();
        expect(state.status!.isRepo).toBe(false);
        expect(state.error).toBe('Not a git repository');
        expect(state.diff).toBeNull();
        expect(state.isLoading).toBe(false);
      } finally {
        fs.rmSync(nonRepoDir, { recursive: true, force: true });
      }
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
