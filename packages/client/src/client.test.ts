/**
 * End-to-end tests: a REAL daemon (via @diffstalker/daemon, dev-dep) on a
 * /tmp unix socket against temp git repos, driven entirely through
 * DiffstalkerClient — REST methods, mutation envelopes, SSE subscriptions,
 * and typed DaemonError failures.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createDaemon, type Daemon } from '@diffstalker/daemon/src/server.ts';
import { DiffstalkerClient, DaemonError } from './index.js';
import type { RepoRef, WireSharedState } from './index.js';

const SOCKET = path.join(os.tmpdir(), `diffstalker-client-test-${process.pid}.sock`);

let daemon: Daemon;
let client: DiffstalkerClient;
let repoDir: string;
let repoId: string;
const tempDirs: string[] = [];

function gitExec(cwd: string, command: string): string {
  return execSync(`git ${command}`, {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}

/** A fresh temp git repo with one committed file. */
function makeRepo(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tempDirs.push(dir);
  gitExec(dir, 'init --initial-branch=main');
  gitExec(dir, 'config user.email "test@test.com"');
  gitExec(dir, 'config user.name "Test User"');
  fs.writeFileSync(path.join(dir, 'file.txt'), 'original line\n');
  gitExec(dir, 'add .');
  gitExec(dir, 'commit -m "initial commit"');
  return dir;
}

/** Poll an async read until the predicate holds (watcher refreshes are async). */
async function until<T>(
  fn: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 10000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await fn();
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for condition; last: ${JSON.stringify(last)}`);
}

interface LooseEmitter {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
}

/** Await one matching SSE event on a subscription. */
function waitForEvent<T>(
  subscription: unknown,
  event: string,
  predicate: (payload: T) => boolean = () => true,
  timeoutMs = 15000
): Promise<T> {
  const emitter = subscription as LooseEmitter;
  return new Promise<T>((resolve, reject) => {
    const handler = (...args: unknown[]): void => {
      const payload = args[0] as T;
      if (!predicate(payload)) return;
      clearTimeout(timer);
      emitter.off(event, handler);
      resolve(payload);
    };
    const timer = setTimeout(() => {
      emitter.off(event, handler);
      reject(new Error(`Timed out waiting for SSE event "${event}"`));
    }, timeoutMs);
    emitter.on(event, handler);
  });
}

/** Run a call expected to fail and return its DaemonError. */
async function expectDaemonError(
  run: () => Promise<unknown>,
  status: number
): Promise<DaemonError> {
  let caught: unknown;
  try {
    await run();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(DaemonError);
  const daemonError = caught as DaemonError;
  expect(daemonError.status).toBe(status);
  return daemonError;
}

beforeAll(async () => {
  repoDir = makeRepo('ds-client-repo-');
  daemon = createDaemon();
  await daemon.listen({ socketPath: SOCKET });
  client = new DiffstalkerClient({ socketPath: SOCKET });
});

afterAll(async () => {
  await daemon.close();
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('health and repos', () => {
  test('health reports ok', async () => {
    expect(await client.health()).toEqual({ ok: true, ready: true });
  });

  test('openRepo returns id + normalized path; listRepos includes it', async () => {
    const opened = await client.openRepo(repoDir);
    repoId = opened.id;
    expect(opened.path).toBe(repoDir);
    expect(opened.id.length).toBeGreaterThan(0);

    const repos = await client.listRepos();
    expect(repos.some((repo) => repo.id === repoId && repo.path === repoDir)).toBe(true);
  });

  test('unknown repo id is a 404 DaemonError', async () => {
    await expectDaemonError(() => client.status('nonexistent'), 404);
  });
});

describe('working tree', () => {
  test('status reflects an on-disk modification', async () => {
    fs.appendFileSync(path.join(repoDir, 'file.txt'), 'added line\n');
    const state = await until(
      () => client.status(repoId),
      (s) =>
        s.status !== null &&
        s.status.files.some((f) => f.path === 'file.txt' && f.status === 'modified')
    );
    expect(state.error).toBeNull();
    expect(state.operationInProgress).toBeNull();
  }, 15000);

  test('diff({path}) returns the change', async () => {
    const diff = await client.diff(repoId, { path: 'file.txt' });
    expect(diff.raw).toContain('+added line');
    // DiffLine.content keeps the raw diff prefix ('+').
    expect(
      diff.lines.some((line) => line.type === 'addition' && line.content === '+added line')
    ).toBe(true);
  });

  test('stage returns an envelope with the file staged', async () => {
    const envelope = await client.stage(repoId, 'file.txt');
    expect(envelope.state.status).not.toBeNull();
    const entry = envelope.state.status!.files.find((f) => f.path === 'file.txt');
    expect(entry?.staged).toBe(true);
  });

  test('commit advances history (dates revived to Date)', async () => {
    const envelope = await client.commit(repoId, 'second commit');
    expect(envelope.state.status!.files.length).toBe(0);

    const commits = await client.history(repoId);
    expect(commits.length).toBe(2);
    expect(commits[0].message).toBe('second commit');
    expect(commits[0].date).toBeInstanceOf(Date);
    expect(Number.isNaN(commits[0].date.getTime())).toBe(false);
  });

  test('commitDiff returns the diff of the new commit', async () => {
    const [head] = await client.history(repoId, 1);
    const diff = await client.commitDiff(repoId, head.hash);
    expect(diff.raw).toContain('+added line');
  });
});

describe('history, compare, explorer, follow', () => {
  test('branches lists main as current', async () => {
    const branches = await client.branches(repoId);
    expect(branches.some((b) => b.name === 'main' && b.current)).toBe(true);
  });

  test('no remote: base branches empty, compare base null, compare is 422', async () => {
    expect(await client.baseBranches(repoId)).toEqual([]);
    expect(await client.getCompareBase(repoId)).toBeNull();
    await expectDaemonError(() => client.compare(repoId), 422);
  });

  test('setCompareBase validates the ref', async () => {
    expect(await client.setCompareBase(repoId, 'main')).toBe('main');
    await expectDaemonError(() => client.setCompareBase(repoId, 'no-such-branch'), 400);
  });

  test('tree, file, and files serve explorer data', async () => {
    const entries = await client.tree(repoId);
    expect(entries.some((e) => e.name === 'file.txt' && e.type === 'file')).toBe(true);

    const file = await client.file(repoId, 'file.txt');
    expect(file.binary).toBe(false);
    expect(file.content).toContain('original line');

    expect(await client.files(repoId)).toContain('file.txt');
  });

  test('worktrees lists the main worktree', async () => {
    const worktrees = await client.worktrees(repoId);
    expect(worktrees.length).toBe(1);
    expect(worktrees[0].path).toBe(repoDir);
    expect(worktrees[0].branch).toBe('main');
    expect(worktrees[0].head).toMatch(/^[0-9a-f]{40}$/);
    expect(worktrees[0].isBare).toBe(false);
  });

  test('headMessage returns the HEAD commit message', async () => {
    const [head] = await client.history(repoId, 1);
    expect(await client.headMessage(repoId)).toBe(head.message);
  });

  test('getFollow reports disabled (daemon started without a follow file)', async () => {
    expect(await client.getFollow()).toEqual({
      targetFile: null,
      enabled: false,
      followedRepoId: null,
      followedPath: null,
    });
  });
});

describe('SSE subscriptions', () => {
  test('subscribeRepo: snapshot on connect, state-change after an on-disk edit', async () => {
    const subscription = client.subscribeRepo(repoId);
    try {
      const snapshot = await waitForEvent<WireSharedState>(subscription, 'snapshot');
      expect(snapshot.status).not.toBeNull();

      const changed = waitForEvent<WireSharedState>(
        subscription,
        'state-change',
        (state) => state.status?.files.some((f) => f.path === 'fresh.txt') ?? false
      );
      fs.writeFileSync(path.join(repoDir, 'fresh.txt'), 'fresh\n');
      const state = await changed;
      const entry = state.status!.files.find((f) => f.path === 'fresh.txt');
      expect(entry?.status).toBe('untracked');
    } finally {
      subscription.close();
    }
  }, 20000);

  test('subscribeDaemon: snapshot, repo-opened, repo-closed', async () => {
    const subscription = client.subscribeDaemon();
    try {
      const snapshot = await waitForEvent<RepoRef[]>(subscription, 'snapshot');
      expect(snapshot.some((repo) => repo.id === repoId)).toBe(true);

      const secondDir = makeRepo('ds-client-second-');
      const openedEvent = waitForEvent<RepoRef>(
        subscription,
        'repo-opened',
        (repo) => repo.path === secondDir
      );
      const opened = await client.openRepo(secondDir);
      expect((await openedEvent).id).toBe(opened.id);

      const closedEvent = waitForEvent<{ id: string }>(
        subscription,
        'repo-closed',
        (event) => event.id === opened.id
      );
      await client.closeRepo(opened.id);
      await closedEvent;
    } finally {
      subscription.close();
    }
  }, 20000);
});

describe('typed errors', () => {
  test('staging a file not in status is a 404 with the daemon message', async () => {
    const err = await expectDaemonError(() => client.stage(repoId, 'no-such-file.txt'), 404);
    expect(err.message).toContain('no-such-file.txt');
    expect(err.name).toBe('DaemonError');
  });

  test('an empty commit message is a 400', async () => {
    await expectDaemonError(() => client.commit(repoId, ''), 400);
  });

  test('discarding a staged file is a 409', async () => {
    const staged = await client.stage(repoId, 'fresh.txt');
    expect(staged.state.status!.files.find((f) => f.path === 'fresh.txt')?.staged).toBe(true);
    await expectDaemonError(() => client.discard(repoId, 'fresh.txt'), 409);
    // Restore: unstage so the fixture ends where the test found it.
    const unstaged = await client.unstage(repoId, 'fresh.txt');
    expect(unstaged.state.status!.files.find((f) => f.path === 'fresh.txt')?.staged).toBe(false);
  });
});
