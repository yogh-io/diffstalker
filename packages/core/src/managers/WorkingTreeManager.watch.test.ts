/**
 * Watcher tests for WorkingTreeManager.
 *
 * These are the ONE place that calls startWatching() for real. Every other
 * manager test constructs the manager without it, precisely so no watcher
 * or timer is created (see CLAUDE.md). Here the watcher IS the thing under
 * test, so it is started deliberately and disposed in afterEach.
 *
 * Besides the FIFO case below, the scenarios pin what the watcher costs and
 * what it sees: one inotify watch per directory and none per file, nothing
 * watched that git ignores (global and info/exclude rules included), new and
 * recreated directories picked up, git's own writes seen without polling,
 * and an unviewed repo that only goes stale.
 *
 * What is being pinned: a FIFO inside a watched tree must never freeze the
 * process. Opening a pipe blocks until a writer arrives. On bun 1.3, fs.watch
 * opened every entry of a watched directory (on a pool thread, holding its
 * watcher mutex), so one pipe froze the whole daemon — /health included —
 * and the code carried a guard in chokidar's `ignored` hook. Bun 1.4 opens
 * with O_PATH, which never blocks, and Node never opened the entries, so the
 * guard is gone. These tests stay to catch a runtime that regresses.
 *
 * The scenarios run in a CHILD process. When the main thread is stuck in
 * open(2) or on a mutex, no timer fires, so neither bun's per-test timeout
 * nor a Promise.race can fail the test: the whole suite hangs until CI
 * kills the job. The parent runs `bun test` on this same file with
 * DIFFSTALKER_WATCH_SCENARIO set, waits with a hard timeout, and SIGKILLs a
 * child that does not come back. A regression is then a failed test, not a
 * hung run.
 */

import { describe, test, expect, beforeAll, afterAll, afterEach, setDefaultTimeout } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { WorkingTreeManager } from './WorkingTreeManager.js';
import { GitOperationQueue } from './GitOperationQueue.js';
import { TreeWatcher } from './TreeWatcher.js';
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
  'a FIFO beside ordinary files and symlinks does not stop the watcher',
  'root and nested .gitignore rules decide what the watcher reports',
  'one watch per directory, none per file, none for ignored directories',
  'the global ignore file and info/exclude are applied',
  'a directory made after the start, or removed and made again, is watched',
  'a commit from the shell refreshes without polling',
  'an unviewed repo only goes stale until it is viewed',
  'a .gitignore edit re-applies the rules',
  'a resync during the first crawl leaves a newly skipped tree unwatched',
  'an entry named like its folder costs no recrawl',
  'a worktree removed and added back is watched again',
] as const;

/** Long enough for any refresh a change could start, spacing included. */
const QUIET_MS = 1500;

/** Resolves once the event loop has turned `ms` later. A frozen loop never settles it. */
function tick(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls until pred holds; fails after timeoutMs. */
async function waitFor(pred: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the watcher');
    await tick(50);
  }
}

/** Inotify watches this process holds, across all its inotify instances. */
function inotifyWatches(): number {
  let count = 0;
  for (const fd of fs.readdirSync('/proc/self/fd')) {
    let target: string;
    try {
      target = fs.readlinkSync(`/proc/self/fd/${fd}`);
    } catch {
      continue; // closed between the listing and the read
    }
    if (!target.includes('inotify')) continue;
    count += (fs.readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8').match(/^inotify/gm) ?? []).length;
  }
  return count;
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
  // Several scenarios wait out refresh spacing more than once; the parent's
  // hard kill still bounds them.
  setDefaultTimeout(CHILD_TIMEOUT_MS - 5_000);
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

    function startManager({ viewed = true } = {}): WorkingTreeManager {
      const m = new WorkingTreeManager(repoPath, new GitOperationQueue());
      m.startWatching();
      m.setViewed(viewed);
      manager = m;
      return m;
    }

    /** Counts state-change events from now on. */
    function countChanges(m: WorkingTreeManager): { count: number } {
      const counter = { count: 0 };
      m.on('state-change', () => counter.count++);
      return counter;
    }

    test(SCENARIOS[0], async () => {
      startManager();
      // Let the watcher finish its initial scan before the pipe appears.
      await tick(300);

      const fifoPath = path.join(repoPath, 'pipe.png');
      execFileSync('mkfifo', [fifoPath]);

      try {
        // On a runtime whose fs.watch opens the pipe, the main thread blocks
        // in open(2) here and this never resolves.
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
        await waitFor(() => added.length > 0);
      } finally {
        fs.unlinkSync(fifoPath);
        fs.unlinkSync(linkPath);
        fs.unlinkSync(realPath);
      }
    });

    test(SCENARIOS[2], async () => {
      // A root rule, an ignored directory, and a nested .gitignore whose
      // rules apply below its own directory only. The nested file is
      // committed so `git ls-files` lists it; the ignored directory
      // exists before the watcher starts so the crawl meets it.
      writeFixtureFile(repoPath, '.gitignore', '*.log\nbuild\n');
      writeFixtureFile(repoPath, 'sub/.gitignore', 'tmp/\n*.cache\n');
      fs.mkdirSync(path.join(repoPath, 'build'), { recursive: true });
      fs.mkdirSync(path.join(repoPath, 'sub/tmp'), { recursive: true });
      fs.mkdirSync(path.join(repoPath, 'sub/deep'), { recursive: true });
      gitExec(repoPath, 'add .gitignore sub/.gitignore');
      gitExec(repoPath, 'commit -m "ignore rules"');

      const manager = startManager();
      await tick(300);
      const changes: string[] = [];
      manager.on('state-change', () => changes.push('change'));

      const ignored = ['root.log', 'build/x.txt', 'sub/a.cache', 'sub/tmp/b.txt', 'sub/deep/c.cache'];
      for (const file of ignored) writeFixtureFile(repoPath, file, 'ignored\n');
      await tick(QUIET_MS);
      expect(changes.length).toBe(0);

      // The nested rule does not reach above its directory, and a plain
      // file under it is still watched.
      writeFixtureFile(repoPath, 'root.cache', 'watched\n');
      await waitFor(() => changes.length > 0);
      changes.length = 0;
      writeFixtureFile(repoPath, 'sub/kept.txt', 'watched\n');
      await waitFor(() => changes.length > 0);
    });

    test(SCENARIOS[3], async () => {
      // 200 files in one directory, and an ignored directory of 20 more.
      writeFixtureFile(repoPath, '.gitignore', 'build/\n');
      for (let i = 0; i < 200; i++) writeFixtureFile(repoPath, `many/f${i}.txt`, `${i}\n`);
      for (let i = 0; i < 20; i++) fs.mkdirSync(path.join(repoPath, `build/d${i}`), { recursive: true });

      const before = inotifyWatches();
      startManager();
      await tick(300);
      // root and many/, plus the git dir: .git, info, refs, refs/heads, refs/tags.
      const watches = inotifyWatches() - before;
      expect(watches).toBeGreaterThanOrEqual(2);
      expect(watches).toBeLessThanOrEqual(8);
    });

    test(SCENARIOS[4], async () => {
      const globalIgnore = path.join(repoPath, '.git', 'test-global-ignore');
      fs.writeFileSync(globalIgnore, 'worktrees/\n');
      gitExec(repoPath, `config core.excludesFile ${globalIgnore}`);
      fs.appendFileSync(path.join(repoPath, '.git', 'info', 'exclude'), 'scratch/\n');
      fs.mkdirSync(path.join(repoPath, 'worktrees/feat-x'), { recursive: true });
      fs.mkdirSync(path.join(repoPath, 'scratch'), { recursive: true });

      const m = startManager();
      await tick(300);
      const changes = countChanges(m);
      writeFixtureFile(repoPath, 'worktrees/feat-x/a.txt', 'ignored\n');
      writeFixtureFile(repoPath, 'scratch/b.txt', 'ignored\n');
      await tick(QUIET_MS);
      expect(changes.count).toBe(0);

      writeFixtureFile(repoPath, 'kept.txt', 'watched\n');
      await waitFor(() => changes.count > 0);
    });

    test(SCENARIOS[5], async () => {
      fs.mkdirSync(path.join(repoPath, 'again'));
      const m = startManager();
      await tick(300);
      const changes = countChanges(m);

      writeFixtureFile(repoPath, 'fresh/deep/f.txt', 'one\n');
      await waitFor(() => changes.count > 0);
      await tick(QUIET_MS);
      changes.count = 0;
      fs.appendFileSync(path.join(repoPath, 'fresh/deep/f.txt'), 'two\n');
      await waitFor(() => changes.count > 0);

      fs.rmSync(path.join(repoPath, 'again'), { recursive: true });
      fs.mkdirSync(path.join(repoPath, 'again'));
      await tick(QUIET_MS);
      changes.count = 0;
      writeFixtureFile(repoPath, 'again/x.txt', 'in the new directory\n');
      await waitFor(() => m.state.status?.files.some((f) => f.path === 'again/x.txt') === true);
      expect(changes.count).toBeGreaterThan(0);
    });

    test(SCENARIOS[6], async () => {
      const m = startManager();
      writeFixtureFile(repoPath, 'tracked.txt', 'edited from the shell\n');
      await waitFor(() => m.state.status?.files.some((f) => f.path === 'tracked.txt') === true);
      gitExec(repoPath, 'commit -am "from the shell"');
      await waitFor(() => m.state.status?.files.length === 0);
      expect(m.state.status?.branch.current).toBe('main');
    });

    test(SCENARIOS[7], async () => {
      const m = startManager({ viewed: false });
      await tick(300);
      const changes = countChanges(m);
      await m.refresh();
      changes.count = 0;
      expect(m.stale).toBe(false);

      writeFixtureFile(repoPath, 'unseen.txt', 'nobody is looking\n');
      await waitFor(() => m.stale);
      await tick(QUIET_MS);
      expect(changes.count).toBe(0);

      m.setViewed(true);
      await waitFor(() => m.state.status?.files.some((f) => f.path === 'unseen.txt') === true);
      expect(m.stale).toBe(false);
    });

    test(SCENARIOS[8], async () => {
      fs.mkdirSync(path.join(repoPath, 'gen'));
      const m = startManager();
      await tick(300);
      const changes = countChanges(m);
      writeFixtureFile(repoPath, '.gitignore', 'gen/\n');
      await waitFor(() => changes.count > 0);
      await tick(QUIET_MS);
      changes.count = 0;

      writeFixtureFile(repoPath, 'gen/out.txt', 'now ignored\n');
      await tick(QUIET_MS);
      expect(changes.count).toBe(0);
    });

    test(SCENARIOS[9], async () => {
      for (let i = 0; i < 200; i++) fs.mkdirSync(path.join(repoPath, `nm/p${i}`), { recursive: true });
      let skipNm = false;
      const watcher = new TreeWatcher(repoPath, {
        skipDir: (rel) => rel === '.git' || (skipNm && rel === 'nm'),
        onChange: () => {},
        onError: () => {},
      });
      try {
        const crawl = watcher.start();
        await tick(5); // the crawl is under way
        skipNm = true;
        await Promise.all([crawl, watcher.resync()]);
        expect(watcher.watchedDirs).toBe(1);
      } finally {
        watcher.close();
      }
    });

    test(SCENARIOS[10], async () => {
      for (let i = 0; i < 50; i++) fs.mkdirSync(path.join(repoPath, `dirs/d${i}`), { recursive: true });
      let asked = 0;
      const watcher = new TreeWatcher(repoPath, {
        skipDir: (rel) => {
          asked++;
          return rel === '.git';
        },
        onChange: () => {},
        onError: () => {},
      });
      try {
        await watcher.start();
        const afterCrawl = asked;
        const watched = watcher.watchedDirs;
        // A Go binary named after its folder, built and removed again.
        const namesake = path.join(repoPath, path.basename(repoPath));
        fs.writeFileSync(namesake, 'binary');
        await tick(200);
        fs.unlinkSync(namesake);
        await tick(300);
        expect(asked - afterCrawl).toBeLessThan(5);
        expect(watcher.watchedDirs).toBe(watched);
      } finally {
        watcher.close();
      }
    });

    test(SCENARIOS[11], async () => {
      const worktree = `${repoPath}-wt`;
      fs.rmSync(worktree, { recursive: true, force: true });
      gitExec(repoPath, `worktree add ${worktree} -b wt-branch`);
      const m = new WorkingTreeManager(worktree, new GitOperationQueue());
      manager = m;
      m.startWatching();
      m.setViewed(true);
      try {
        await waitFor(() => m.state.status !== null);
        await tick(300);
        gitExec(repoPath, `worktree remove --force ${worktree}`);
        // Long enough for the watchers to see their roots gone, short of
        // the refresh the removal schedules, which then finds it back.
        await tick(100);
        gitExec(repoPath, `worktree add ${worktree} wt-branch`);
        await tick(QUIET_MS);
        writeFixtureFile(worktree, 'after.txt', 'in the worktree that came back\n');
        await waitFor(() => m.state.status?.files.some((f) => f.path === 'after.txt') === true);
        expect(m.unavailable).toBeNull();
      } finally {
        fs.rmSync(worktree, { recursive: true, force: true });
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
