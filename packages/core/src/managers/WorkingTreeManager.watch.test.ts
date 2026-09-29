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
 * Note the ordering: the pipe is created AFTER the watcher is up. That is
 * the case the guard covers: chokidar sees the new path, asks `ignored`,
 * and never hands it to fs.watch. A pipe that already exists when a
 * directory is handed to fs.watch is a different story on bun 1.3: bun
 * lists that directory on a pool thread, after fs.watch() has returned,
 * and opens every entry with a plain blocking open while holding its
 * watcher mutex. `ignored` never sees those entries. A FIFO there parks
 * the pool thread, and the next fs.watch() call deadlocks the main
 * thread. Bun 1.4 opens with O_PATH and no longer blocks. Node never did.
 *
 * That is also why the scenarios run in a CHILD process. When the main
 * thread is stuck in open(2) or on that mutex, no timer fires, so neither
 * bun's per-test timeout nor a Promise.race can fail the test: the whole
 * suite hangs until CI kills the job. The parent runs `bun test` on this
 * same file with DIFFSTALKER_WATCH_SCENARIO set, waits with a hard
 * timeout, and SIGKILLs a child that does not come back. A regression is
 * then a failed test, not a hung run. The listing race above can still
 * lose on a slow runner while the pin is bun 1.3; it fails instead of
 * hanging.
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { WorkingTreeManager } from './WorkingTreeManager.js';
import { GitOperationQueue } from './GitOperationQueue.js';
import {
  createFixtureRepo,
  removeFixtureRepo,
  writeFixtureFile,
  gitExec,
} from '../git/test-helpers.js';

const REPO_NAME = 'working-tree-manager-watch-test';
const SCENARIO_ENV = 'DIFFSTALKER_WATCH_SCENARIO';
/** How long the parent gives the child before it is assumed frozen. */
const CHILD_TIMEOUT_MS = 20_000;

const SCENARIOS = [
  'a FIFO created in the working tree does not freeze the process',
  'a socket or FIFO is skipped while ordinary files and symlinks are still watched',
] as const;

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

/**
 * Run one scenario in a fresh `bun test` on this file, selected by name.
 * The child owns the fixture; a killed child never reaches afterAll, so
 * the fixture is removed here as well.
 */
function runScenarioInChild(name: string): void {
  const result = spawnSync(process.execPath, ['test', import.meta.filename, '-t', name], {
    cwd: path.resolve(import.meta.dirname, '../..'),
    env: { ...process.env, [SCENARIO_ENV]: '1' },
    encoding: 'utf-8',
    timeout: CHILD_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
  removeFixtureRepo(REPO_NAME);

  const output = `${result.stdout}\n${result.stderr}`;
  if (result.signal !== null) {
    throw new Error(
      `watch scenario "${name}" did not finish within ${CHILD_TIMEOUT_MS}ms and was killed ` +
        `(${result.signal}): the process froze.\n${output}`
    );
  }
  expect(result.status, output).toBe(0);
  // Guard against the name filter matching nothing: a run that skipped
  // everything also exits 0.
  expect(output).toMatch(/\b1 pass\b/);
}

if (process.env[SCENARIO_ENV] === '1') {
  describe('WorkingTreeManager watcher scenario', () => {
    let repoPath: string;
    let manager: WorkingTreeManager | null = null;

    beforeAll(() => {
      // Start from nothing: a fixture left behind by a killed run would
      // break this run with a confusing git error instead of the real one.
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
      const m = new WorkingTreeManager(repoPath, new GitOperationQueue());
      m.startWatching();
      manager = m;
      return m;
    }

    test(SCENARIOS[0], async () => {
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

    test(SCENARIOS[1], async () => {
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
} else {
  describe('WorkingTreeManager watcher', () => {
    for (const name of SCENARIOS) {
      test(name, () => runScenarioInChild(name), CHILD_TIMEOUT_MS + 5_000);
    }
  });
}
