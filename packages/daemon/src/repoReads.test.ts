/**
 * Repo-level read endpoints over a real unix socket: GET /worktrees and
 * GET /head-message.
 *
 * Self-contained: own daemon instance, own socket, and own fixture repos
 * under /tmp (mkdtemp) — a linked worktree is added next to the main one,
 * so nothing touches the package's shared fixture dir.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createDaemon, Daemon } from './server.js';

const SOCKET = path.join(os.tmpdir(), `diffstalkerd-reads-${process.pid}.sock`);

let daemon: Daemon;
let repoDir: string;
let linkedDir: string;
let repoId: string;
let emptyRepoId: string;
let headHash: string;
const tempDirs: string[] = [];

interface WireWorktree {
  path: string;
  branch: string | null;
  head: string | null;
  isBare: boolean;
  lastActivity: number | null;
  aheadOfBase: number | null;
}

function gitExec(cwd: string, command: string): string {
  return execSync(`git ${command}`, {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}

/** A fresh temp git repo under /tmp, configured for committing. */
function makeRepo(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tempDirs.push(dir);
  gitExec(dir, 'init --initial-branch=main');
  gitExec(dir, 'config user.email "test@test.com"');
  gitExec(dir, 'config user.name "Test User"');
  return dir;
}

function request(pathname: string): Promise<Response> {
  return fetch(`http://localhost${pathname}`, { unix: SOCKET } as RequestInit);
}

async function openRepo(repoPath: string): Promise<string> {
  const res = await fetch(`http://localhost/repos`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: repoPath }),
    unix: SOCKET,
  } as RequestInit);
  expect([200, 201]).toContain(res.status);
  return ((await res.json()) as { id: string }).id;
}

beforeAll(async () => {
  repoDir = makeRepo('diffstalkerd-reads-');
  fs.writeFileSync(path.join(repoDir, 'a.txt'), 'a\n');
  gitExec(repoDir, 'add .');
  gitExec(repoDir, 'commit -m "subject line"');
  headHash = gitExec(repoDir, 'rev-parse HEAD').trim();

  // Linked worktree in its own /tmp dir (git refuses a nested one that
  // already exists, so let `git worktree add` create it).
  const linkedParent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'diffstalkerd-wt-')));
  tempDirs.push(linkedParent);
  linkedDir = path.join(linkedParent, 'linked');
  gitExec(repoDir, `worktree add "${linkedDir}" -b wt-branch`);

  const emptyRepoDir = makeRepo('diffstalkerd-reads-empty-');

  daemon = createDaemon();
  await daemon.listen({ socketPath: SOCKET });
  repoId = await openRepo(repoDir);
  emptyRepoId = await openRepo(emptyRepoDir);
});

afterAll(async () => {
  await daemon.close();
  fs.rmSync(SOCKET, { force: true });
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('GET /repos/:id/worktrees', () => {
  test('lists the main worktree and the linked one', async () => {
    const res = await request(`/repos/${repoId}/worktrees`);
    expect(res.status).toBe(200);
    const worktrees = (await res.json()) as WireWorktree[];
    expect(worktrees.length).toBe(2);

    const main = worktrees.find((w) => w.path === repoDir);
    expect(main).toBeDefined();
    expect(main!.branch).toBe('main');
    expect(main!.head).toBe(headHash);
    expect(main!.isBare).toBe(false);
    expect(typeof main!.lastActivity).toBe('number');
    // No remote and only one branch — no candidate base branch to compare against.
    expect(main!.aheadOfBase).toBeNull();

    const linked = worktrees.find((w) => w.path === linkedDir);
    expect(linked).toBeDefined();
    expect(linked!.branch).toBe('wt-branch');
    expect(linked!.head).toBe(headHash);
    expect(linked!.isBare).toBe(false);
    expect(typeof linked!.lastActivity).toBe('number');
    expect(linked!.aheadOfBase).toBeNull();
  });

  test('a repo without linked worktrees lists just its own', async () => {
    const res = await request(`/repos/${emptyRepoId}/worktrees`);
    expect(res.status).toBe(200);
    const worktrees = (await res.json()) as WireWorktree[];
    expect(worktrees.length).toBe(1);
    expect(worktrees[0].isBare).toBe(false);
  });

  test('unknown repo id is a 404', async () => {
    const res = await request('/repos/r999/worktrees');
    expect(res.status).toBe(404);
  });
});

describe('GET /worktrees?path=', () => {
  test('lists a repo family from a path that was never opened', async () => {
    // linkedDir is only ever created via `git worktree add`, never POSTed
    // to /repos — this must still resolve the whole family.
    const res = await request(`/worktrees?path=${encodeURIComponent(linkedDir)}`);
    expect(res.status).toBe(200);
    const worktrees = (await res.json()) as WireWorktree[];
    expect(worktrees.map((w) => w.path).sort()).toEqual([linkedDir, repoDir].sort());
  });

  test('a non-repo path yields an empty array, not an error', async () => {
    const res = await request(`/worktrees?path=${encodeURIComponent(os.tmpdir())}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  test('missing "path" is a 400', async () => {
    const res = await request('/worktrees');
    expect(res.status).toBe(400);
  });
});

describe('GET /repos/:id/head-message', () => {
  test('returns the last commit message', async () => {
    const res = await request(`/repos/${repoId}/head-message`);
    expect(res.status).toBe(200);
    expect((await res.json()) as { message: string }).toEqual({ message: 'subject line' });
  });

  test('a repo with no commits yields an empty message, not a 500', async () => {
    const res = await request(`/repos/${emptyRepoId}/head-message`);
    expect(res.status).toBe(200);
    expect((await res.json()) as { message: string }).toEqual({ message: '' });
  });

  test('unknown repo id is a 404', async () => {
    const res = await request('/repos/r999/head-message');
    expect(res.status).toBe(404);
  });
});
