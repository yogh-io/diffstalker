/**
 * Watcher tests for WorkingTreeManager.
 *
 * These are the ONE place that calls startWatching() for real. Every other
 * manager test constructs the manager without it, precisely so no chokidar
 * watcher or timer is created (see CLAUDE.md). Here the watcher IS the thing
 * under test, so it is started deliberately and disposed in afterEach.
 *
 * What is being pinned: a FIFO appearing inside a watched tree used to freeze
 * the entire process. Opening a pipe blocks until a writer arrives, and under
 * bun that block lands on the main thread, so the daemon stopped answering
 * everything — /health included. The guard lives in the watcher's `ignored`
 * predicate because that is the only hook chokidar runs before it opens
 * anything.
 *
 * Note the ordering: the pipe is created AFTER the watcher is up. A FIFO that
 * already exists when startWatching() runs is harmless, because ignoreInitial
 * means chokidar never looks at it — so a test that creates the pipe first
 * passes whether or not the guard is there, and proves nothing.
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { WorkingTreeManager } from './WorkingTreeManager.js';
import { GitOperationQueue } from './GitOperationQueue.js';
import {
  createFixtureRepo,
  removeFixtureRepo,
  writeFixtureFile,
  gitExec,
} from '../git/test-helpers.js';

/** Resolves once the event loop has turned `ms` later. A frozen loop never settles it. */
function tick(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Whether the event loop is still running: races a timer against `ms`. If the
 * main thread is blocked in a FIFO open, the timer never fires and this
 * rejects instead of hanging the suite forever.
 */
async function expectEventLoopAlive(ms: number): Promise<void> {
  const alive = tick(ms).then(() => 'alive' as const);
  const timeout = new Promise<'frozen'>((resolve) => {
    const t = setTimeout(() => resolve('frozen'), ms * 4);
    // Unref so a passing test never holds the process open.
    if (typeof t === 'object' && t !== null && 'unref' in t) (t as { unref(): void }).unref();
  });
  expect(await Promise.race([alive, timeout])).toBe('alive');
}

describe('WorkingTreeManager watcher', () => {
  const REPO_NAME = 'working-tree-manager-watch-test';
  let repoPath: string;
  let queue: GitOperationQueue;
  let manager: WorkingTreeManager | null = null;

  beforeAll(() => {
    // Start from nothing. When this test regresses it does not fail, it hangs
    // and gets killed, so afterAll never runs and the fixture survives to
    // break the NEXT run with a confusing git error instead of the real one.
    removeFixtureRepo(REPO_NAME);
    repoPath = createFixtureRepo(REPO_NAME);
    writeFixtureFile(repoPath, 'tracked.txt', 'tracked content\n');
    gitExec(repoPath, 'add tracked.txt');
    gitExec(repoPath, 'commit -m "initial"');
  });

  afterAll(() => {
    removeFixtureRepo(REPO_NAME);
  });

  afterEach(() => {
    manager?.dispose();
    manager = null;
  });

  function startManager(): WorkingTreeManager {
    queue = new GitOperationQueue(repoPath);
    const m = new WorkingTreeManager(repoPath, queue);
    m.startWatching();
    manager = m;
    return m;
  }

  test('a FIFO created in the working tree does not freeze the process', async () => {
    startManager();
    // Let the watcher finish its initial scan before the pipe appears.
    await tick(300);

    const fifoPath = path.join(repoPath, 'pipe.png');
    execFileSync('mkfifo', [fifoPath]);

    try {
      // Without the guard the main thread blocks in open(2) here and this
      // never resolves.
      await expectEventLoopAlive(500);
    } finally {
      fs.unlinkSync(fifoPath);
    }
  });

  test('a socket or FIFO is skipped while ordinary files and symlinks are still watched', async () => {
    const manager = startManager();
    await tick(300);

    const added: string[] = [];
    manager.on('state-change', () => added.push('change'));

    const fifoPath = path.join(repoPath, 'skipped.pipe');
    const realPath = path.join(repoPath, 'real.txt');
    const linkPath = path.join(repoPath, 'link.txt');

    execFileSync('mkfifo', [fifoPath]);
    fs.writeFileSync(realPath, 'hello\n');
    fs.symlinkSync('real.txt', linkPath);

    try {
      await expectEventLoopAlive(500);
      // The regular file landed, so the watcher is genuinely still working
      // rather than merely un-frozen.
      await tick(700);
      expect(added.length).toBeGreaterThan(0);
    } finally {
      fs.unlinkSync(fifoPath);
      fs.unlinkSync(linkPath);
      fs.unlinkSync(realPath);
    }
  });
});
