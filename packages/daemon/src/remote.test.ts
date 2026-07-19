/**
 * Remote / branch / undo endpoints over a real unix socket: push, fetch,
 * pull, stash round-trip, branch create/switch, soft reset, cherry-pick,
 * revert, plus the conflict->409 and in-progress->409 paths.
 *
 * All remotes are local bare repos (file paths) and GIT_TERMINAL_PROMPT=0
 * is forced, so nothing can hang on credentials or the network.
 *
 * Self-contained: one daemon instance on its own socket, and every test
 * builds (and removes) its own fixture repos — no shared repo state or
 * ordering between tests.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as http from 'node:http';
import type { RemoteOperationManager } from '@diffstalker/core/managers/RemoteOperationManager';
import { createDaemon, Daemon } from './server.js';
import { HttpError } from './router.js';
import { runRemoteMutation } from './routes/shared.js';
import {
  createFixtureRepo,
  createBareFixtureRepo,
  cloneFixtureRepo,
  removeFixtureRepo,
  writeFixtureFile,
  gitExec,
} from './test-helpers.js';

process.env.GIT_TERMINAL_PROMPT = '0';

const SOCKET = path.join(os.tmpdir(), `diffstalkerd-rem-${process.pid}.sock`);

let daemon: Daemon;

function request(pathname: string, init?: RequestInit): Promise<Response> {
  const options = { ...init, unix: SOCKET };
  return fetch(`http://localhost${pathname}`, options as RequestInit);
}

function postJson(pathname: string, body: unknown): Promise<Response> {
  return request(pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

interface WireOpResult {
  result: string | null;
  operation: string;
}

/** Open a fixture repo on the daemon; returns its id. */
async function openRepo(repoPath: string): Promise<string> {
  const res = await postJson('/repos', { path: repoPath });
  expect([200, 201]).toContain(res.status);
  return ((await res.json()) as { id: string }).id;
}

/** Close a repo so its manager (and watchers) are disposed. */
async function closeRepo(repoId: string): Promise<void> {
  await request(`/repos/${repoId}`, { method: 'DELETE' });
}

/**
 * A working repo with one commit (base.txt), wired to a local bare origin
 * with main pushed and tracking set up. Returns both paths; clean up with
 * removeFixtureRepo(name) and removeFixtureRepo(`${name}-origin`).
 */
function makeRepoWithOrigin(name: string): { repoPath: string; originPath: string } {
  const originPath = createBareFixtureRepo(`${name}-origin`);
  const repoPath = createFixtureRepo(name);
  writeFixtureFile(repoPath, 'base.txt', 'line one\n');
  gitExec(repoPath, 'add .');
  gitExec(repoPath, 'commit -m "initial"');
  gitExec(repoPath, `remote add origin "${originPath}"`);
  gitExec(repoPath, 'push -u origin main');
  return { repoPath, originPath };
}

/** Commit to origin from a second clone, simulating another contributor. */
function pushExternalCommit(originPath: string, name: string, file: string, content: string): string {
  const clonePath = cloneFixtureRepo(originPath, name);
  writeFixtureFile(clonePath, file, content);
  gitExec(clonePath, 'add .');
  gitExec(clonePath, 'commit -m "external"');
  gitExec(clonePath, 'push origin main');
  const hash = gitExec(clonePath, 'rev-parse HEAD').trim();
  removeFixtureRepo(name);
  return hash;
}

function headOf(repoPath: string): string {
  return gitExec(repoPath, 'rev-parse HEAD').trim();
}

beforeAll(async () => {
  daemon = createDaemon();
  await daemon.listen({ socketPath: SOCKET });
});

afterAll(async () => {
  await daemon.close();
  fs.rmSync(SOCKET, { force: true });
});

describe('push / fetch / pull', () => {
  test('push advances the bare origin to the local HEAD', async () => {
    const name = 'daemon-rem-push';
    const { repoPath, originPath } = makeRepoWithOrigin(name);
    const repoId = await openRepo(repoPath);
    try {
      writeFixtureFile(repoPath, 'new.txt', 'pushed\n');
      gitExec(repoPath, 'add .');
      gitExec(repoPath, 'commit -m "local work"');

      const res = await postJson(`/repos/${repoId}/push`, {});
      expect(res.status).toBe(200);
      const body = (await res.json()) as WireOpResult;
      expect(body.operation).toBe('push');
      expect(typeof body.result).toBe('string');

      const originHead = gitExec(originPath, 'rev-parse main').trim();
      expect(originHead).toBe(headOf(repoPath));
    } finally {
      await closeRepo(repoId);
      removeFixtureRepo(name);
      removeFixtureRepo(`${name}-origin`);
    }
  });

  test('fetch picks up an external commit on origin', async () => {
    const name = 'daemon-rem-fetch';
    const { repoPath, originPath } = makeRepoWithOrigin(name);
    const repoId = await openRepo(repoPath);
    try {
      const externalHash = pushExternalCommit(originPath, `${name}-ext`, 'ext.txt', 'external\n');

      const res = await postJson(`/repos/${repoId}/fetch`, {});
      expect(res.status).toBe(200);
      const body = (await res.json()) as WireOpResult;
      expect(body.operation).toBe('fetch');
      expect(body.result).toBe('Fetch complete');

      // origin/main advanced, local HEAD untouched.
      expect(gitExec(repoPath, 'rev-parse origin/main').trim()).toBe(externalHash);
      expect(headOf(repoPath)).not.toBe(externalHash);
    } finally {
      await closeRepo(repoId);
      removeFixtureRepo(name);
      removeFixtureRepo(`${name}-origin`);
    }
  });

  test('pull rebases onto an external commit (fast-forward)', async () => {
    const name = 'daemon-rem-pull';
    const { repoPath, originPath } = makeRepoWithOrigin(name);
    const repoId = await openRepo(repoPath);
    try {
      const externalHash = pushExternalCommit(originPath, `${name}-ext`, 'ext.txt', 'external\n');

      const res = await postJson(`/repos/${repoId}/pull`, {});
      expect(res.status).toBe(200);
      const body = (await res.json()) as WireOpResult;
      expect(body.operation).toBe('pull');
      expect(typeof body.result).toBe('string');

      expect(headOf(repoPath)).toBe(externalHash);
      expect(fs.existsSync(path.join(repoPath, 'ext.txt'))).toBe(true);
    } finally {
      await closeRepo(repoId);
      removeFixtureRepo(name);
      removeFixtureRepo(`${name}-origin`);
    }
  });

  test('rejected non-fast-forward push is a 409, not a 500', async () => {
    const name = 'daemon-rem-push-reject';
    const { repoPath, originPath } = makeRepoWithOrigin(name);
    const repoId = await openRepo(repoPath);
    try {
      // Origin moves ahead; local commits a divergent change.
      pushExternalCommit(originPath, `${name}-ext`, 'ext.txt', 'external\n');
      writeFixtureFile(repoPath, 'local.txt', 'local\n');
      gitExec(repoPath, 'add .');
      gitExec(repoPath, 'commit -m "divergent"');

      const res = await postJson(`/repos/${repoId}/push`, {});
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string };
      expect(body.error.length).toBeGreaterThan(0);
    } finally {
      await closeRepo(repoId);
      removeFixtureRepo(name);
      removeFixtureRepo(`${name}-origin`);
    }
  });
});

describe('stash / stash-pop', () => {
  test('stash cleans the working tree; stash-pop restores it', async () => {
    const name = 'daemon-rem-stash';
    const { repoPath } = makeRepoWithOrigin(name);
    const repoId = await openRepo(repoPath);
    try {
      writeFixtureFile(repoPath, 'base.txt', 'line one\nline two\n');
      expect(gitExec(repoPath, 'status --porcelain').trim()).not.toBe('');

      const stashRes = await postJson(`/repos/${repoId}/stash`, { message: 'wip from test' });
      expect(stashRes.status).toBe(200);
      expect(((await stashRes.json()) as WireOpResult).operation).toBe('stash');
      expect(gitExec(repoPath, 'status --porcelain').trim()).toBe('');
      expect(gitExec(repoPath, 'stash list')).toContain('wip from test');

      const popRes = await postJson(`/repos/${repoId}/stash-pop`, {});
      expect(popRes.status).toBe(200);
      expect(((await popRes.json()) as WireOpResult).operation).toBe('stash-pop');
      expect(gitExec(repoPath, 'status --porcelain').trim()).not.toBe('');
      expect(fs.readFileSync(path.join(repoPath, 'base.txt'), 'utf-8')).toBe(
        'line one\nline two\n'
      );
      expect(gitExec(repoPath, 'stash list').trim()).toBe('');
    } finally {
      await closeRepo(repoId);
      removeFixtureRepo(name);
      removeFixtureRepo(`${name}-origin`);
    }
  });

  test('stash-pop rejects a negative or non-integer index with 400', async () => {
    const name = 'daemon-rem-stash-badidx';
    const { repoPath } = makeRepoWithOrigin(name);
    const repoId = await openRepo(repoPath);
    try {
      const negative = await postJson(`/repos/${repoId}/stash-pop`, { index: -1 });
      expect(negative.status).toBe(400);
      const fractional = await postJson(`/repos/${repoId}/stash-pop`, { index: 1.5 });
      expect(fractional.status).toBe(400);
    } finally {
      await closeRepo(repoId);
      removeFixtureRepo(name);
      removeFixtureRepo(`${name}-origin`);
    }
  });
});

describe('branch create / switch', () => {
  test('create moves HEAD to the new branch; switch moves it back', async () => {
    const name = 'daemon-rem-branch';
    const { repoPath } = makeRepoWithOrigin(name);
    const repoId = await openRepo(repoPath);
    try {
      const createRes = await postJson(`/repos/${repoId}/branch/create`, { name: 'feat-x' });
      expect(createRes.status).toBe(200);
      expect(((await createRes.json()) as WireOpResult).result).toBe('Created feat-x');
      expect(gitExec(repoPath, 'branch --show-current').trim()).toBe('feat-x');

      const branchesRes = await request(`/repos/${repoId}/branches`);
      expect(branchesRes.status).toBe(200);
      const branches = (await branchesRes.json()) as { name: string; current: boolean }[];
      expect(branches.find((b) => b.current)?.name).toBe('feat-x');
      expect(branches.map((b) => b.name)).toContain('main');

      const switchRes = await postJson(`/repos/${repoId}/branch/switch`, { name: 'main' });
      expect(switchRes.status).toBe(200);
      expect(((await switchRes.json()) as WireOpResult).result).toBe('Switched to main');
      expect(gitExec(repoPath, 'branch --show-current').trim()).toBe('main');
    } finally {
      await closeRepo(repoId);
      removeFixtureRepo(name);
      removeFixtureRepo(`${name}-origin`);
    }
  });

  test('missing branch name is a 400', async () => {
    const name = 'daemon-rem-branch-noname';
    const { repoPath } = makeRepoWithOrigin(name);
    const repoId = await openRepo(repoPath);
    try {
      const switchRes = await postJson(`/repos/${repoId}/branch/switch`, {});
      expect(switchRes.status).toBe(400);
      const createRes = await postJson(`/repos/${repoId}/branch/create`, { name: '' });
      expect(createRes.status).toBe(400);
    } finally {
      await closeRepo(repoId);
      removeFixtureRepo(name);
      removeFixtureRepo(`${name}-origin`);
    }
  });
});

describe('soft reset', () => {
  test('count:1 moves HEAD back one commit and keeps the changes staged', async () => {
    const name = 'daemon-rem-reset';
    const { repoPath } = makeRepoWithOrigin(name);
    const repoId = await openRepo(repoPath);
    try {
      const firstHead = headOf(repoPath);
      writeFixtureFile(repoPath, 'second.txt', 'second commit\n');
      gitExec(repoPath, 'add .');
      gitExec(repoPath, 'commit -m "second"');

      const res = await postJson(`/repos/${repoId}/reset/soft`, { count: 1 });
      expect(res.status).toBe(200);
      expect(((await res.json()) as WireOpResult).operation).toBe('soft-reset');

      expect(headOf(repoPath)).toBe(firstHead);
      expect(gitExec(repoPath, 'diff --cached --name-only').trim()).toBe('second.txt');
      expect(fs.existsSync(path.join(repoPath, 'second.txt'))).toBe(true);
    } finally {
      await closeRepo(repoId);
      removeFixtureRepo(name);
      removeFixtureRepo(`${name}-origin`);
    }
  });

  test('non-positive count is a 400', async () => {
    const name = 'daemon-rem-reset-badcount';
    const { repoPath } = makeRepoWithOrigin(name);
    const repoId = await openRepo(repoPath);
    try {
      const res = await postJson(`/repos/${repoId}/reset/soft`, { count: 0 });
      expect(res.status).toBe(400);
    } finally {
      await closeRepo(repoId);
      removeFixtureRepo(name);
      removeFixtureRepo(`${name}-origin`);
    }
  });
});

describe('cherry-pick / revert', () => {
  test('cherry-pick applies a commit from another branch', async () => {
    const name = 'daemon-rem-cherry';
    const { repoPath } = makeRepoWithOrigin(name);
    const repoId = await openRepo(repoPath);
    try {
      gitExec(repoPath, 'checkout -b other');
      writeFixtureFile(repoPath, 'other.txt', 'from other branch\n');
      gitExec(repoPath, 'add .');
      gitExec(repoPath, 'commit -m "other work"');
      const otherHash = headOf(repoPath);
      gitExec(repoPath, 'checkout main');
      expect(fs.existsSync(path.join(repoPath, 'other.txt'))).toBe(false);

      const res = await postJson(`/repos/${repoId}/cherry-pick`, { hash: otherHash });
      expect(res.status).toBe(200);
      expect(((await res.json()) as WireOpResult).result).toBe('Cherry-picked');

      expect(fs.existsSync(path.join(repoPath, 'other.txt'))).toBe(true);
      expect(gitExec(repoPath, 'log -1 --format=%s').trim()).toBe('other work');
    } finally {
      await closeRepo(repoId);
      removeFixtureRepo(name);
      removeFixtureRepo(`${name}-origin`);
    }
  });

  test('revert undoes a commit with a new commit', async () => {
    const name = 'daemon-rem-revert';
    const { repoPath } = makeRepoWithOrigin(name);
    const repoId = await openRepo(repoPath);
    try {
      writeFixtureFile(repoPath, 'extra.txt', 'to be reverted\n');
      gitExec(repoPath, 'add .');
      gitExec(repoPath, 'commit -m "add extra"');
      const hash = headOf(repoPath);

      const res = await postJson(`/repos/${repoId}/revert`, { hash });
      expect(res.status).toBe(200);
      expect(((await res.json()) as WireOpResult).result).toBe('Reverted');

      expect(fs.existsSync(path.join(repoPath, 'extra.txt'))).toBe(false);
      expect(gitExec(repoPath, 'log -1 --format=%s').trim()).toContain('Revert');
    } finally {
      await closeRepo(repoId);
      removeFixtureRepo(name);
      removeFixtureRepo(`${name}-origin`);
    }
  });

  test('a conflicting cherry-pick is a 409 with the git error', async () => {
    const name = 'daemon-rem-conflict';
    const { repoPath } = makeRepoWithOrigin(name);
    const repoId = await openRepo(repoPath);
    try {
      // Both branches change base.txt from the same ancestor -> content conflict.
      gitExec(repoPath, 'checkout -b other');
      writeFixtureFile(repoPath, 'base.txt', 'other version\n');
      gitExec(repoPath, 'commit -am "other version"');
      const otherHash = headOf(repoPath);
      gitExec(repoPath, 'checkout main');
      writeFixtureFile(repoPath, 'base.txt', 'main version\n');
      gitExec(repoPath, 'commit -am "main version"');

      const res = await postJson(`/repos/${repoId}/cherry-pick`, { hash: otherHash });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string };
      expect(body.error.toLowerCase()).toContain('conflict');
    } finally {
      await closeRepo(repoId);
      removeFixtureRepo(name);
      removeFixtureRepo(`${name}-origin`);
    }
  });
});

describe('runRemoteMutation in-progress guard', () => {
  // A real race (two HTTP requests hitting the manager at the same moment)
  // is timing-dependent, so the guard branches are exercised directly with
  // a stubbed manager state instead.

  const stubRemote = (state: Partial<RemoteOperationManager['remoteState']>) =>
    ({
      remoteState: {
        operation: null,
        inProgress: false,
        error: null,
        lastResult: null,
        ...state,
      },
    }) as RemoteOperationManager;

  const fakeRes = {} as http.ServerResponse;

  test('rejects with 409 when an operation is already in progress', async () => {
    const remote = stubRemote({ operation: 'push', inProgress: true });
    let called = false;
    const attempt = runRemoteMutation(remote, fakeRes, 'fetch', async () => {
      called = true;
    });
    await expect(attempt).rejects.toBeInstanceOf(HttpError);
    await expect(attempt).rejects.toMatchObject({ status: 409 });
    expect(called).toBe(false);
  });

  test('rejects with 409 when the call hit the manager silent guard (race)', async () => {
    // fn resolves, but the state still shows another op in flight: our call
    // returned without doing anything (the manager's `if (inProgress) return`).
    const remote = stubRemote({ operation: 'pull', inProgress: false });
    const attempt = runRemoteMutation(remote, fakeRes, 'push', async () => {
      (remote.remoteState as { inProgress: boolean }).inProgress = true;
      (remote.remoteState as { operation: string }).operation = 'pull';
    });
    await expect(attempt).rejects.toBeInstanceOf(HttpError);
    await expect(attempt).rejects.toMatchObject({ status: 409 });
  });
});
