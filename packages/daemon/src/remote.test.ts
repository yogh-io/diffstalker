/**
 * Remote / branch / undo endpoints over a real unix socket: push, fetch,
 * pull, stash round-trip, branch create/switch, soft reset, cherry-pick,
 * revert, abort/rebase-continue recovery, plus the conflict->409,
 * in-progress->409, and flag-injection->400 paths.
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
import type { RepoHandle } from './repoRegistry.js';
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

/** The unified mutation envelope: refreshed shared state + result text. */
interface WireEnvelope {
  state: {
    status: {
      files: { path: string; staged: boolean }[];
      branch: { current: string };
      isRepo: boolean;
    } | null;
    stashList: { index: number; message: string }[];
    operationInProgress: string | null;
    error: string | null;
  };
  result: string | null;
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
      const body = (await res.json()) as WireEnvelope;
      expect(typeof body.result).toBe('string');
      // The envelope carries the refreshed shared state, not just a string.
      expect(body.state.status?.isRepo).toBe(true);
      expect(body.state.status?.branch.current).toBe('main');
      expect(body.state.error).toBeNull();

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
      const body = (await res.json()) as WireEnvelope;
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
      const body = (await res.json()) as WireEnvelope;
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
      const stashed = (await stashRes.json()) as WireEnvelope;
      expect(stashed.result).toBe('Stashed');
      // The wire state exposes the stash list, so stash-pop {index} is
      // actually usable by a client.
      expect(stashed.state.stashList).toHaveLength(1);
      expect(stashed.state.stashList[0].message).toContain('wip from test');
      expect(gitExec(repoPath, 'status --porcelain').trim()).toBe('');
      expect(gitExec(repoPath, 'stash list')).toContain('wip from test');

      const popRes = await postJson(`/repos/${repoId}/stash-pop`, {});
      expect(popRes.status).toBe(200);
      const popped = (await popRes.json()) as WireEnvelope;
      expect(popped.result).toBe('Stash popped');
      expect(popped.state.stashList).toHaveLength(0);
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
      const createRes = await postJson(`/repos/${repoId}/create-branch`, { name: 'feat-x' });
      expect(createRes.status).toBe(200);
      const created = (await createRes.json()) as WireEnvelope;
      expect(created.result).toBe('Created feat-x');
      expect(created.state.status?.branch.current).toBe('feat-x');
      expect(gitExec(repoPath, 'branch --show-current').trim()).toBe('feat-x');

      const branchesRes = await request(`/repos/${repoId}/branches`);
      expect(branchesRes.status).toBe(200);
      const branches = (await branchesRes.json()) as { name: string; current: boolean }[];
      expect(branches.find((b) => b.current)?.name).toBe('feat-x');
      expect(branches.map((b) => b.name)).toContain('main');

      const switchRes = await postJson(`/repos/${repoId}/switch-branch`, { name: 'main' });
      expect(switchRes.status).toBe(200);
      const switched = (await switchRes.json()) as WireEnvelope;
      expect(switched.result).toBe('Switched to main');
      expect(switched.state.status?.branch.current).toBe('main');
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
      const switchRes = await postJson(`/repos/${repoId}/switch-branch`, {});
      expect(switchRes.status).toBe(400);
      const createRes = await postJson(`/repos/${repoId}/create-branch`, { name: '' });
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

      const res = await postJson(`/repos/${repoId}/soft-reset`, { count: 1 });
      expect(res.status).toBe(200);
      const body = (await res.json()) as WireEnvelope;
      expect(body.result).toBe('Reset done');
      // The refreshed state already shows the re-staged file.
      expect(
        body.state.status?.files.some((f) => f.path === 'second.txt' && f.staged)
      ).toBe(true);

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
      const res = await postJson(`/repos/${repoId}/soft-reset`, { count: 0 });
      expect(res.status).toBe(400);
    } finally {
      await closeRepo(repoId);
      removeFixtureRepo(name);
      removeFixtureRepo(`${name}-origin`);
    }
  });

  test('resetting past the root commit is a clear 400, not a git 500', async () => {
    const name = 'daemon-rem-reset-pastroot';
    const { repoPath } = makeRepoWithOrigin(name);
    const repoId = await openRepo(repoPath);
    try {
      // One commit exists; HEAD~1 does not.
      const res = await postJson(`/repos/${repoId}/soft-reset`, { count: 1 });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('HEAD~1');
      expect(gitExec(repoPath, 'rev-list --count HEAD').trim()).toBe('1');
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
      expect(((await res.json()) as WireEnvelope).result).toBe('Cherry-picked');

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
      expect(((await res.json()) as WireEnvelope).result).toBe('Reverted');

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

describe('flag injection guards', () => {
  test('a flag-shaped branch name is a 400 and the working tree survives', async () => {
    const name = 'daemon-rem-inject-switch';
    const { repoPath } = makeRepoWithOrigin(name);
    const repoId = await openRepo(repoPath);
    try {
      // Uncommitted work that `git checkout -f` would have destroyed.
      writeFixtureFile(repoPath, 'base.txt', 'precious uncommitted change\n');

      for (const evil of ['-f', '--detach', '--force']) {
        const res = await postJson(`/repos/${repoId}/switch-branch`, { name: evil });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: string };
        expect(body.error).toContain('must not start with "-"');
      }

      // The uncommitted content is untouched and HEAD never moved.
      expect(fs.readFileSync(path.join(repoPath, 'base.txt'), 'utf-8')).toBe(
        'precious uncommitted change\n'
      );
      expect(gitExec(repoPath, 'branch --show-current').trim()).toBe('main');
    } finally {
      await closeRepo(repoId);
      removeFixtureRepo(name);
      removeFixtureRepo(`${name}-origin`);
    }
  });

  test('flag-shaped create-branch names and cherry-pick/revert hashes are 400s', async () => {
    const name = 'daemon-rem-inject-rest';
    const { repoPath } = makeRepoWithOrigin(name);
    const repoId = await openRepo(repoPath);
    try {
      const create = await postJson(`/repos/${repoId}/create-branch`, { name: '-f' });
      expect(create.status).toBe(400);

      // '--abort' as a "hash" would have run `git cherry-pick --abort`.
      const pick = await postJson(`/repos/${repoId}/cherry-pick`, { hash: '--abort' });
      expect(pick.status).toBe(400);

      const revert = await postJson(`/repos/${repoId}/revert`, { hash: '--continue' });
      expect(revert.status).toBe(400);

      expect(gitExec(repoPath, 'branch --show-current').trim()).toBe('main');
    } finally {
      await closeRepo(repoId);
      removeFixtureRepo(name);
      removeFixtureRepo(`${name}-origin`);
    }
  });
});

describe('conflicting pull: wedge detection and recovery', () => {
  /**
   * A repo wedged mid-rebase: origin and local both rewrote base.txt, then
   * pull --rebase hit the conflict. Returns the repo paths and open id.
   */
  async function makeWedgedRepo(name: string): Promise<{ repoPath: string; repoId: string }> {
    const { repoPath, originPath } = makeRepoWithOrigin(name);
    pushExternalCommit(originPath, `${name}-ext`, 'base.txt', 'external version\n');
    writeFixtureFile(repoPath, 'base.txt', 'local version\n');
    gitExec(repoPath, 'commit -am "local version"');
    const repoId = await openRepo(repoPath);

    const pullRes = await postJson(`/repos/${repoId}/pull`, {});
    expect(pullRes.status).toBe(409);
    const body = (await pullRes.json()) as { error: string };
    expect(body.error.toLowerCase()).toContain('conflict');
    return { repoPath, repoId };
  }

  test('conflicting pull is a 409; /status shows the wedge; /abort recovers', async () => {
    const name = 'daemon-rem-wedge-abort';
    const { repoPath, repoId } = await makeWedgedRepo(name);
    try {
      // The client can SEE it is wedged.
      const statusRes = await request(`/repos/${repoId}/status`);
      expect(statusRes.status).toBe(200);
      const wire = (await statusRes.json()) as { operationInProgress: string | null };
      expect(wire.operationInProgress).toBe('rebase');
      expect(fs.existsSync(path.join(repoPath, '.git', 'rebase-merge'))).toBe(true);

      // And recover from it through the API.
      const abortRes = await postJson(`/repos/${repoId}/abort`, {});
      expect(abortRes.status).toBe(200);
      const aborted = (await abortRes.json()) as WireEnvelope;
      expect(aborted.result).toBe('Aborted rebase');
      expect(aborted.state.operationInProgress).toBeNull();

      // HEAD is reattached to the branch and the rebase dir is gone.
      expect(gitExec(repoPath, 'branch --show-current').trim()).toBe('main');
      expect(fs.existsSync(path.join(repoPath, '.git', 'rebase-merge'))).toBe(false);
      expect(fs.readFileSync(path.join(repoPath, 'base.txt'), 'utf-8')).toBe('local version\n');
    } finally {
      await closeRepo(repoId);
      removeFixtureRepo(name);
      removeFixtureRepo(`${name}-origin`);
    }
  });

  test('abort with nothing in progress is a 409', async () => {
    const name = 'daemon-rem-noop-abort';
    const { repoPath } = makeRepoWithOrigin(name);
    const repoId = await openRepo(repoPath);
    try {
      const res = await postJson(`/repos/${repoId}/abort`, {});
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('No operation in progress');

      const cont = await postJson(`/repos/${repoId}/rebase-continue`, {});
      expect(cont.status).toBe(409);
    } finally {
      await closeRepo(repoId);
      removeFixtureRepo(name);
      removeFixtureRepo(`${name}-origin`);
    }
  });

  test('rebase-continue finishes the rebase after conflicts are resolved', async () => {
    const name = 'daemon-rem-wedge-continue';
    const { repoPath, repoId } = await makeWedgedRepo(name);
    try {
      // Resolve the conflict out-of-band, the way a client edit would.
      writeFixtureFile(repoPath, 'base.txt', 'merged version\n');
      gitExec(repoPath, 'add base.txt');

      const contRes = await postJson(`/repos/${repoId}/rebase-continue`, {});
      expect(contRes.status).toBe(200);
      const cont = (await contRes.json()) as WireEnvelope;
      expect(cont.result).toBe('Rebase continued');
      expect(cont.state.operationInProgress).toBeNull();

      expect(gitExec(repoPath, 'branch --show-current').trim()).toBe('main');
      expect(fs.readFileSync(path.join(repoPath, 'base.txt'), 'utf-8')).toBe('merged version\n');
      // The local commit was replayed on top of the external one.
      expect(gitExec(repoPath, 'log --format=%s').trim().split('\n')).toEqual([
        'local version',
        'external',
        'initial',
      ]);
    } finally {
      await closeRepo(repoId);
      removeFixtureRepo(name);
      removeFixtureRepo(`${name}-origin`);
    }
  });
});

describe('conflicting stash pop', () => {
  test('a pop that conflicts is a 409 and the stash entry is kept', async () => {
    const name = 'daemon-rem-stash-conflict';
    const { repoPath } = makeRepoWithOrigin(name);
    const repoId = await openRepo(repoPath);
    try {
      // Stash a change to base.txt, then move the branch so the pop conflicts.
      writeFixtureFile(repoPath, 'base.txt', 'stashed version\n');
      gitExec(repoPath, 'stash push -m "conflicting wip"');
      writeFixtureFile(repoPath, 'base.txt', 'committed version\n');
      gitExec(repoPath, 'commit -am "diverge"');

      const res = await postJson(`/repos/${repoId}/stash-pop`, {});
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string };
      expect(body.error.toLowerCase()).toContain('conflict');
      expect(body).not.toHaveProperty('result');

      // git keeps the entry on a conflicting pop — nothing was lost.
      expect(gitExec(repoPath, 'stash list')).toContain('conflicting wip');
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

  const stubHandle = (state: Partial<RemoteOperationManager['remoteState']>) =>
    ({
      id: 'stub',
      path: '/nowhere',
      refCount: 1,
      manager: {
        remote: {
          remoteState: {
            operation: null,
            inProgress: false,
            error: null,
            lastResult: null,
            ...state,
          },
        },
        workingTree: {},
      },
    }) as unknown as RepoHandle;

  const fakeRes = {} as http.ServerResponse;

  test('rejects with 409 when an operation is already in progress', async () => {
    const handle = stubHandle({ operation: 'push', inProgress: true });
    let called = false;
    const attempt = runRemoteMutation(handle, fakeRes, async () => {
      called = true;
      return null;
    });
    await expect(attempt).rejects.toBeInstanceOf(HttpError);
    await expect(attempt).rejects.toMatchObject({ status: 409 });
    expect(called).toBe(false);
  });

  test('rejects with 409 when the manager refused the call (lost race)', async () => {
    // The manager returns null when another op won the race — the loser
    // must get a clean 409, never another operation's result.
    const handle = stubHandle({ operation: 'pull', inProgress: false });
    const attempt = runRemoteMutation(handle, fakeRes, async () => null);
    await expect(attempt).rejects.toBeInstanceOf(HttpError);
    await expect(attempt).rejects.toMatchObject({ status: 409 });
  });
});
