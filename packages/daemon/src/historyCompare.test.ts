/**
 * History + compare endpoints over a real unix socket.
 *
 * Self-contained: own daemon instance, own socket, own fixture repos, and
 * an own XDG_CACHE_HOME so the base-branch cache never touches the user's
 * real cache (and starts empty).
 *
 * Fixture shape: two commits on main, a remote-tracking ref origin/main at
 * main's tip (getCandidateBaseBranches only surfaces remote branches), a
 * feature branch with one extra commit checked out, and an uncommitted
 * modification to a tracked file.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { setCachedBaseBranch } from '@diffstalker/core/utils/baseBranchCache';
import { createDaemon, Daemon } from './server.js';
import { createFixtureRepo, removeFixtureRepo, writeFixtureFile, gitExec } from './test-helpers.js';

/** The diff text of a wire diff — the wire carries lines only. */
function wireDiffText(diff: { lines: { content: string }[] }): string {
  return diff.lines.map((l) => l.content).join('\n') + '\n';
}



const FIXTURE = 'daemon-history-compare';
const FIXTURE_NO_BASE = 'daemon-history-compare-nobase';
const FIXTURE_MERGE = 'daemon-history-compare-merge';
const SOCKET = path.join(os.tmpdir(), `diffstalkerd-hc-${process.pid}.sock`);

let daemon: Daemon;
let repoPath: string;
let repoId: string;
let repoHandlePath: string;
let noBaseRepoId: string;
let mergeRepoPath: string;
let mergeRepoId: string;
let mergeRepoHandlePath: string;
let mergeCommitHash: string;
let emptyCommitHash: string;
let cacheHome: string;
let savedCacheHome: string | undefined;

interface WireCommit {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  date: unknown;
  refs: string;
}

interface WireCompareDiff {
  baseBranch: string;
  stats: { filesChanged: number; additions: number; deletions: number };
  files: Array<{ path: string; status: string; isUncommitted?: boolean; diff: { raw: string } }>;
  commits: WireCommit[];
  uncommittedCount: number;
}

function request(pathname: string, init?: RequestInit): Promise<Response> {
  const options = { ...init, unix: SOCKET };
  return fetch(`http://localhost${pathname}`, options as RequestInit);
}

function sendJsonBody(method: string, pathname: string, body: unknown): Promise<Response> {
  return request(pathname, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function openRepo(repoDir: string): Promise<{ id: string; path: string }> {
  const res = await sendJsonBody('POST', '/repos', { path: repoDir });
  expect([200, 201]).toContain(res.status);
  return (await res.json()) as { id: string; path: string };
}

beforeAll(async () => {
  // Redirect the XDG cache so the persisted base-branch choice lands in a
  // throwaway dir, not the user's real ~/.cache (and starts empty).
  savedCacheHome = process.env.XDG_CACHE_HOME;
  cacheHome = fs.mkdtempSync(path.join(os.tmpdir(), 'diffstalkerd-hc-xdg-'));
  process.env.XDG_CACHE_HOME = cacheHome;

  repoPath = createFixtureRepo(FIXTURE);
  writeFixtureFile(repoPath, 'base.txt', 'line one\n');
  gitExec(repoPath, 'add .');
  gitExec(repoPath, 'commit -m "first commit"');
  writeFixtureFile(repoPath, 'base.txt', 'line one\nline two\n');
  gitExec(repoPath, 'add .');
  gitExec(repoPath, 'commit -m "second commit"');
  // Remote-tracking ref so base-branch discovery has a candidate.
  gitExec(repoPath, 'update-ref refs/remotes/origin/main main');
  gitExec(repoPath, 'checkout -b feature');
  writeFixtureFile(repoPath, 'feature.txt', 'feature line\n');
  gitExec(repoPath, 'add .');
  gitExec(repoPath, 'commit -m "feature commit"');
  // Uncommitted tracked-file change for uncommitted=true (untracked files
  // never show up in git diff, so modify a tracked one).
  writeFixtureFile(repoPath, 'base.txt', 'line one\nline two\nuncommitted line\n');

  const noBasePath = createFixtureRepo(FIXTURE_NO_BASE);
  writeFixtureFile(noBasePath, 'a.txt', 'a\n');
  gitExec(noBasePath, 'add .');
  gitExec(noBasePath, 'commit -m "init"');

  // Merge/empty/orphan fixture: a real merge commit and an --allow-empty
  // commit (both must be 200, not "Unknown commit"), an orphan branch
  // (compare across unrelated history must 422), and an origin/main ref
  // (fallback target for the stale-cache test).
  mergeRepoPath = createFixtureRepo(FIXTURE_MERGE);
  writeFixtureFile(mergeRepoPath, 'a.txt', 'a\n');
  gitExec(mergeRepoPath, 'add .');
  gitExec(mergeRepoPath, 'commit -m "init"');
  gitExec(mergeRepoPath, 'checkout -b side');
  writeFixtureFile(mergeRepoPath, 'b.txt', 'b\n');
  gitExec(mergeRepoPath, 'add .');
  gitExec(mergeRepoPath, 'commit -m "side commit"');
  gitExec(mergeRepoPath, 'checkout main');
  writeFixtureFile(mergeRepoPath, 'c.txt', 'c\n');
  gitExec(mergeRepoPath, 'add .');
  gitExec(mergeRepoPath, 'commit -m "main commit"');
  gitExec(mergeRepoPath, 'merge --no-ff side -m "merge side"');
  mergeCommitHash = gitExec(mergeRepoPath, 'rev-parse HEAD').trim();
  gitExec(mergeRepoPath, 'commit --allow-empty -m "empty commit"');
  emptyCommitHash = gitExec(mergeRepoPath, 'rev-parse HEAD').trim();
  gitExec(mergeRepoPath, 'checkout --orphan orphan');
  gitExec(mergeRepoPath, 'add -A');
  gitExec(mergeRepoPath, 'commit -m "orphan commit"');
  gitExec(mergeRepoPath, 'checkout main');
  gitExec(mergeRepoPath, 'update-ref refs/remotes/origin/main main');

  daemon = createDaemon();
  await daemon.listen({ socketPath: SOCKET });
  const opened = await openRepo(repoPath);
  repoId = opened.id;
  repoHandlePath = opened.path;
  noBaseRepoId = (await openRepo(noBasePath)).id;
  const mergeOpened = await openRepo(mergeRepoPath);
  mergeRepoId = mergeOpened.id;
  mergeRepoHandlePath = mergeOpened.path;
});

afterAll(async () => {
  await daemon.close();
  removeFixtureRepo(FIXTURE);
  removeFixtureRepo(FIXTURE_NO_BASE);
  removeFixtureRepo(FIXTURE_MERGE);
  fs.rmSync(SOCKET, { force: true });
  fs.rmSync(cacheHome, { recursive: true, force: true });
  if (savedCacheHome === undefined) {
    delete process.env.XDG_CACHE_HOME;
  } else {
    process.env.XDG_CACHE_HOME = savedCacheHome;
  }
});

describe('history endpoints', () => {
  test('GET /history returns commits newest first with ISO string dates', async () => {
    const res = await request(`/repos/${repoId}/history`);
    expect(res.status).toBe(200);
    const commits = (await res.json()) as WireCommit[];
    expect(commits).toHaveLength(3);
    expect(commits[0].message).toBe('feature commit');
    expect(commits[2].message).toBe('first commit');
    for (const commit of commits) {
      // Wire format: an ISO string, never a serialized Date object.
      expect(typeof commit.date).toBe('string');
      expect(commit.date as string).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(commit.hash).toMatch(/^[0-9a-f]{40}$/);
      expect(commit.shortHash).toBe(commit.hash.slice(0, 7));
    }
  });

  test('GET /history?count=N limits the result', async () => {
    const res = await request(`/repos/${repoId}/history?count=2`);
    expect(res.status).toBe(200);
    const commits = (await res.json()) as WireCommit[];
    expect(commits).toHaveLength(2);
    expect(commits[0].message).toBe('feature commit');
  });

  test('GET /history with a non-integer count is a 400', async () => {
    const res = await request(`/repos/${repoId}/history?count=abc`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('count');
  });

  test('GET /history for an unknown repo id is a 404', async () => {
    const res = await request('/repos/r999/history');
    expect(res.status).toBe(404);
  });

  test('GET /commits/:hash/diff returns the commit diff', async () => {
    const history = (await (
      await request(`/repos/${repoId}/history?count=1`)
    ).json()) as WireCommit[];
    const res = await request(`/repos/${repoId}/commits/${history[0].hash}/diff`);
    expect(res.status).toBe(200);
    const diff = (await res.json()) as { lines: { content: string }[] };
    expect(wireDiffText(diff)).toContain('+feature line');
    expect(diff.lines.length).toBeGreaterThan(0);
  });

  test('GET /commits/:hash/diff with an unknown hash is a 404 {error}', async () => {
    const res = await request(`/repos/${repoId}/commits/deadbeefdead/diff`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('deadbeefdead');
  });

  test('GET /commits/:hash/diff with a malformed hash is a 400', async () => {
    const res = await request(`/repos/${repoId}/commits/not-a-hash/diff`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Invalid commit hash');
  });

  test('GET /commits/:hash/diff on an --allow-empty commit is 200 with an empty diff', async () => {
    const res = await request(`/repos/${mergeRepoId}/commits/${emptyCommitHash}/diff`);
    expect(res.status).toBe(200);
    const diff = (await res.json()) as { lines: { content: string }[] };
    expect(diff.lines).toEqual([]);
  });

  test('GET /commits/:hash/diff on a merge commit is 200 (empty, CLI parity), not 404', async () => {
    const res = await request(`/repos/${mergeRepoId}/commits/${mergeCommitHash}/diff`);
    expect(res.status).toBe(200);
    const diff = (await res.json()) as { lines: { content: string }[] };
    // git show <merge> --format= without --cc/-m prints no diff; the
    // commit still exists and must not be reported "Unknown".
    expect(typeof wireDiffText(diff)).toBe('string');
  });
});

describe('branch endpoints', () => {
  test('GET /branches lists local branches with the current one marked', async () => {
    const res = await request(`/repos/${repoId}/branches`);
    expect(res.status).toBe(200);
    const branches = (await res.json()) as Array<{ name: string; current: boolean }>;
    const names = branches.map((b) => b.name).sort();
    expect(names).toEqual(['feature', 'main']);
    expect(branches.find((b) => b.name === 'feature')!.current).toBe(true);
    expect(branches.find((b) => b.name === 'main')!.current).toBe(false);
  });

  test('GET /base-branches returns remote candidates', async () => {
    const res = await request(`/repos/${repoId}/base-branches`);
    expect(res.status).toBe(200);
    const candidates = (await res.json()) as string[];
    expect(candidates).toContain('origin/main');
  });

  test('GET /base-branches is empty for a repo without remote refs', async () => {
    const res = await request(`/repos/${noBaseRepoId}/base-branches`);
    expect(res.status).toBe(200);
    expect((await res.json()) as string[]).toEqual([]);
  });
});

describe('compare endpoints', () => {
  // Every test here is order-independent: tests that need a persisted
  // base PUT it themselves, and the fallback tests use repos whose cache
  // entry no other test writes.

  test('GET /compare/base is null when nothing resolves', async () => {
    const res = await request(`/repos/${noBaseRepoId}/compare/base`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ base: null });
  });

  test('PUT /compare/base persists and a later GET reflects it', async () => {
    // (The fallback-to-default behavior with an empty cache is asserted
    // on the merge repo below, whose cache entry only one test touches.)
    const put = await sendJsonBody('PUT', `/repos/${repoId}/compare/base`, { branch: 'main' });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ base: 'main' });

    const after = await request(`/repos/${repoId}/compare/base`);
    expect(after.status).toBe(200);
    expect(await after.json()).toEqual({ base: 'main' });

    // Persisted on disk, not just in memory.
    const cacheFile = path.join(cacheHome, 'diffstalker', 'base-branches.json');
    expect(fs.existsSync(cacheFile)).toBe(true);
    const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf-8')) as Record<string, string>;
    expect(cache[repoHandlePath]).toBe('main');
  });

  test('PUT /compare/base with an unresolvable ref is a 400 and does not persist', async () => {
    // Pin a known-good base first so the outcome does not depend on
    // whether the lifecycle test ran already.
    const pin = await sendJsonBody('PUT', `/repos/${repoId}/compare/base`, { branch: 'main' });
    expect(pin.status).toBe(200);

    const bad = await sendJsonBody('PUT', `/repos/${repoId}/compare/base`, {
      branch: 'no-such-branch',
    });
    expect(bad.status).toBe(400);
    const body = (await bad.json()) as { error: string };
    expect(body.error).toContain('no-such-branch');

    // The garbage never landed: the effective base is still the pin.
    const get = await request(`/repos/${repoId}/compare/base`);
    expect(await get.json()).toEqual({ base: 'main' });
    const cacheFile = path.join(cacheHome, 'diffstalker', 'base-branches.json');
    expect(fs.readFileSync(cacheFile, 'utf-8')).not.toContain('no-such-branch');
  });

  test('PUT /compare/base without a branch string is a 400', async () => {
    const res = await sendJsonBody('PUT', `/repos/${repoId}/compare/base`, {});
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('"branch"');
  });

  test('GET /compare?base=main returns the branch-only CompareDiff', async () => {
    const res = await request(`/repos/${repoId}/compare?base=main`);
    expect(res.status).toBe(200);
    const diff = (await res.json()) as WireCompareDiff;
    expect(diff.baseBranch).toBe('main');
    expect(diff.files.map((f) => f.path)).toEqual(['feature.txt']);
    expect(diff.files[0].status).toBe('added');
    expect(wireDiffText(diff.files[0].diff)).toContain('+feature line');
    expect(diff.commits).toHaveLength(1);
    expect(diff.commits[0].message).toBe('feature commit');
    expect(typeof diff.commits[0].date).toBe('string');
  });

  test('GET /compare without base resolves the persisted one', async () => {
    // Persist 'main' ourselves; omitting base must then use it.
    const put = await sendJsonBody('PUT', `/repos/${repoId}/compare/base`, { branch: 'main' });
    expect(put.status).toBe(200);
    const res = await request(`/repos/${repoId}/compare`);
    expect(res.status).toBe(200);
    const diff = (await res.json()) as WireCompareDiff;
    expect(diff.baseBranch).toBe('main');
  });

  test('GET /compare?uncommitted=true includes the working-tree change', async () => {
    const res = await request(`/repos/${repoId}/compare?base=main&uncommitted=true`);
    expect(res.status).toBe(200);
    const diff = (await res.json()) as WireCompareDiff;
    const uncommitted = diff.files.filter((f) => f.isUncommitted);
    expect(uncommitted.map((f) => f.path)).toEqual(['base.txt']);
    expect(wireDiffText(uncommitted[0].diff)).toContain('+uncommitted line');
    // The committed side is still there too.
    expect(diff.files.some((f) => f.path === 'feature.txt' && !f.isUncommitted)).toBe(true);
  });

  test('GET /compare with a malformed uncommitted param is a 400', async () => {
    const res = await request(`/repos/${repoId}/compare?base=main&uncommitted=yes`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('uncommitted');
  });

  test('GET /compare with an unknown base ref is a 400 naming the ref', async () => {
    const res = await request(`/repos/${repoId}/compare?base=doesnotexist`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Unknown base ref: doesnotexist');
  });

  test('GET /compare with no resolvable base is a 422, not a client error', async () => {
    const res = await request(`/repos/${noBaseRepoId}/compare`);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('No usable base branch');
  });

  test('GET /compare across unrelated history is a 422, not a silent empty diff', async () => {
    const res = await request(`/repos/${mergeRepoId}/compare?base=orphan`);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('No common history');
  });

  test('a stale persisted base falls back to the discovered default, never a 400', async () => {
    // Only this test touches the merge repo's cache entry. Before any
    // persistence its effective base is the discovered default...
    const before = await request(`/repos/${mergeRepoId}/compare/base`);
    expect(await before.json()).toEqual({ base: 'origin/main' });

    // ...poison the shared cache the way a deleted branch (or corrupt
    // cache file) would; the PUT endpoint validates, so write directly
    // under the daemon's normalized repo path.
    setCachedBaseBranch(mergeRepoHandlePath, 'vanished-branch');

    // A base-less request must not surface git's error as a 400: the
    // daemon falls back to the discovered default and answers 200.
    const res = await request(`/repos/${mergeRepoId}/compare`);
    expect(res.status).toBe(200);
    const diff = (await res.json()) as WireCompareDiff;
    expect(diff.baseBranch).toBe('origin/main');
  });
});
