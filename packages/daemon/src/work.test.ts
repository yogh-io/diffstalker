/**
 * The Work page routes over a real unix socket, with a fake gh runner that
 * counts its calls. The methods of the refresh and the repo scan are under
 * test: the refresh runs `gh`, which sends the author's token over the
 * network, and the scan runs git over a whole repo, so both must sit
 * behind the CSRF guard. If someone "corrects" either to a GET, the first
 * test of its block fails.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { BranchPr, PrSnapshot, WorkMarks, WorkRepoFacts } from '@diffstalker/core/types/work';
import { createDaemon, type Daemon } from './server.js';
import { createWorkScanner, repoFamily } from './routes/work.js';
import { OPEN_SEARCH, type GhRunner } from './github.js';
import { createFixtureRepo, gitExec, removeFixtureRepo, writeFixtureFile } from './test-helpers.js';

const FIXTURE = 'daemon-work';
const OTHER = `${FIXTURE}-other`;
const SOCKET = path.join(os.tmpdir(), `dsd-work-${process.pid}.sock`);

let daemon: Daemon;
let repoPath: string;
let otherPath: string;
let repoId: string;
let tmpDir: string;
let watchRoot: string;
let discoveredPath: string;

const runnerCalls: Array<{ args: string[]; input: string }> = [];

function prNode(): Record<string, unknown> {
  return {
    id: 'PR_node',
    number: 9087,
    title: 'Fix it',
    url: 'https://github.com/aerius/calculator/pull/9087',
    state: 'OPEN',
    isDraft: false,
    merged: false,
    mergedAt: null,
    closedAt: null,
    updatedAt: '2026-11-20T10:00:00Z',
    body: 'Why.',
    headRefName: 'feature',
    headRefOid: 'a1b2c3',
    baseRefName: 'main',
    headRepositoryOwner: { login: 'JornC' },
    author: { __typename: 'User', login: 'JornC' },
    repository: { nameWithOwner: 'Aerius/Calculator' },
    reviewDecision: null,
    mergeable: 'MERGEABLE',
    reviewRequests: { totalCount: 0, nodes: [] },
    latestOpinionatedReviews: { nodes: [] },
    reviews: { nodes: [] },
    comments: { nodes: [] },
    reviewThreads: { nodes: [] },
    commits: { nodes: [] },
  };
}

const fakeGh: GhRunner = {
  available: () => true,
  run: (args, _timeout, input = '') => {
    runnerCalls.push({ args: [...args], input });
    const { query, variables } = JSON.parse(input) as {
      query: string;
      variables: Record<string, unknown>;
    };
    if (query.includes('search(')) {
      const nodes = variables.q === OPEN_SEARCH ? [prNode()] : [];
      return Promise.resolve(
        JSON.stringify({
          data: {
            viewer: { login: 'JornC' },
            search: { pageInfo: { hasNextPage: false, endCursor: null }, nodes },
          },
        })
      );
    }
    // A detail read of the one open PR.
    return Promise.resolve(JSON.stringify({ data: { p0: { pullRequest: prNode() } } }));
  },
};

function request(pathname: string, init?: RequestInit): Promise<Response> {
  return fetch(`http://localhost${pathname}`, { ...init, unix: SOCKET } as RequestInit);
}

function send(
  method: string,
  pathname: string,
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<Response> {
  return request(pathname, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const workRepo = (p: string) => send('POST', '/work/repo', { path: p });

beforeAll(async () => {
  removeFixtureRepo(OTHER);
  repoPath = createFixtureRepo(FIXTURE);
  writeFixtureFile(repoPath, 'file.txt', 'one\n');
  gitExec(repoPath, 'add .');
  gitExec(repoPath, 'commit -q -m initial');
  gitExec(repoPath, 'branch feature');
  gitExec(repoPath, 'remote add upstream https://github.com/aerius/calculator.git');

  otherPath = createFixtureRepo(OTHER);
  writeFixtureFile(otherPath, 'file.txt', 'one\n');
  gitExec(otherPath, 'add .');
  gitExec(otherPath, 'commit -q -m initial');

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-work-test-'));
  watchRoot = path.join(tmpDir, 'projects');
  discoveredPath = path.join(watchRoot, 'found');
  fs.mkdirSync(discoveredPath, { recursive: true });
  gitExec(discoveredPath, 'init -q --initial-branch=main');

  daemon = createDaemon({
    gh: fakeGh,
    workMarksFile: path.join(tmpDir, 'work.json'),
    settingsFile: path.join(tmpDir, 'daemon.json'),
    updateCheck: false,
  });
  await daemon.listen({ socketPath: SOCKET });
  const res = await send('POST', '/repos', { path: repoPath });
  repoId = ((await res.json()) as { id: string }).id;
});

afterAll(async () => {
  await daemon.close();
  removeFixtureRepo(FIXTURE);
  removeFixtureRepo(OTHER);
  fs.rmSync(SOCKET, { force: true });
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('the PR list', () => {
  test('is NOT reachable as a GET refresh — that would escape the CSRF guard', async () => {
    const res = await request('/work/prs/refresh');
    expect(res.status).toBe(404);
    expect(runnerCalls).toHaveLength(0);
  });

  test('starts as never, and reading it runs nothing', async () => {
    const res = await request('/work/prs');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'never', checkedAt: null, prs: [] });
    expect(runnerCalls).toHaveLength(0);
  });

  test('the branch PR is empty before a refresh, and reading it runs nothing', async () => {
    const res = await request(`/repos/${repoId}/pr?branch=feature`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      pr: null,
      status: 'never',
      message: null,
      checkedAt: null,
      viewer: null,
    });
    expect(runnerCalls).toHaveLength(0);
  });

  test('a cross-site refresh is a 403 and runs nothing', async () => {
    const res = await send('POST', '/work/prs/refresh', undefined, {
      'sec-fetch-site': 'cross-site',
    });
    expect(res.status).toBe(403);
    expect(runnerCalls).toHaveLength(0);
  });

  test('a refresh runs gh once, and the answer is cached', async () => {
    const res = await send('POST', '/work/prs/refresh');
    expect(res.status).toBe(200);
    const snapshot = (await res.json()) as PrSnapshot;
    expect(snapshot).toMatchObject({ status: 'ok', viewer: 'JornC' });
    expect(snapshot.prs.map((pr) => pr.number)).toEqual([9087]);
    // Three searches, then the one open PR read whole.
    expect(runnerCalls).toHaveLength(4);

    expect(await (await request('/work/prs')).json()).toEqual(snapshot);
    expect(runnerCalls).toHaveLength(4);
  });

  test('a body of junk and a query string change nothing gh is given', async () => {
    const res = await request('/work/prs/refresh?q=--paginate&query=evil', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: '--hostname=evil',
        q: '-F',
        after: '@/etc/passwd',
        args: ['-X', 'POST'],
      }),
    });
    expect(res.status).toBe(200);
    // Nothing changed, so no PR is read whole again.
    expect(runnerCalls).toHaveLength(7);
    for (const call of runnerCalls) {
      expect(call.args).toEqual(['api', 'graphql', '--input', '-']);
      for (const junk of ['--paginate', 'evil', '-F', '/etc/passwd', '-X']) {
        expect(call.input).not.toContain(junk);
      }
    }
  });

  test('the branch PR comes from the cache, matched by the remotes', async () => {
    const res = await request(`/repos/${repoId}/pr?branch=feature`);
    const answer = (await res.json()) as BranchPr;
    expect(answer.pr?.number).toBe(9087);
    expect(answer).toMatchObject({ status: 'ok', viewer: 'JornC' });
    expect(
      (await (await request(`/repos/${repoId}/pr?branch=main`)).json()) as BranchPr
    ).toMatchObject({ pr: null });
    expect((await request(`/repos/${repoId}/pr?branch=-x`)).status).toBe(400);
    expect((await request(`/repos/${repoId}/pr`)).status).toBe(400);
    expect(runnerCalls).toHaveLength(7);
  });

  test('/health says gh is there, from the runner', async () => {
    expect(await (await request('/health')).json()).toMatchObject({ gh: true });
  });

  test('/health says gh is missing for a daemon made without a runner', async () => {
    const socket = path.join(os.tmpdir(), `dsd-work-nogh-${process.pid}.sock`);
    const bare = createDaemon({ updateCheck: false });
    await bare.listen({ socketPath: socket });
    try {
      const res = await fetch('http://localhost/health', { unix: socket } as RequestInit);
      expect(await res.json()).toMatchObject({ gh: false });
      const refreshed = await fetch('http://localhost/work/prs/refresh', {
        method: 'POST',
        unix: socket,
      } as RequestInit);
      expect(await refreshed.json()).toMatchObject({ status: 'gh-missing', checkedAt: null });
    } finally {
      await bare.close();
      fs.rmSync(socket, { force: true });
    }
  });
});

describe('POST /work/repo', () => {
  test('is NOT reachable as a GET — that would escape the CSRF guard', async () => {
    const res = await request(`/work/repo?path=${encodeURIComponent(repoPath)}`);
    expect(res.status).toBe(404);
  });

  test('a cross-site scan is a 403', async () => {
    const res = await send(
      'POST',
      '/work/repo',
      { path: repoPath },
      { 'sec-fetch-site': 'cross-site' }
    );
    expect(res.status).toBe(403);
  });

  test('scans an open repo', async () => {
    const res = await workRepo(repoPath);
    expect(res.status).toBe(200);
    const facts = (await res.json()) as WorkRepoFacts;
    expect(facts).toMatchObject({
      path: repoPath,
      root: repoPath,
      name: FIXTURE,
      branchesCapped: false,
    });
    expect(facts.identities).toEqual(['aerius/calculator']);
    expect(facts.branches.map((b) => b.name)).toEqual(['feature', 'main']);
    expect(facts.worktrees).toEqual([
      expect.objectContaining({ path: repoPath, branch: 'main', isMain: true, uncommitted: 0 }),
    ]);
    expect(facts.drafts).toEqual([]);
  });

  test('refuses a real repo that is neither open nor discovered', async () => {
    const res = await workRepo(otherPath);
    expect(res.status).toBe(404);
  });

  test('refuses a ..-spelled path to such a repo', async () => {
    expect((await workRepo(path.join(repoPath, '..', OTHER))).status).toBe(404);
    expect((await workRepo(`${repoPath}/../${OTHER}`)).status).toBe(404);
  });

  test('allows a ..-spelled path that resolves to an open repo', async () => {
    expect((await workRepo(`${repoPath}/sub/..`)).status).toBe(200);
  });

  test('refuses a relative or missing path with a 400', async () => {
    expect((await workRepo('test-fixtures/daemon-work')).status).toBe(400);
    expect((await workRepo('~/x')).status).toBe(400);
    expect((await send('POST', '/work/repo', {})).status).toBe(400);
    expect((await send('POST', '/work/repo', { path: 7 })).status).toBe(400);
  });

  test('allows a repo found under a watch directory', async () => {
    expect((await workRepo(discoveredPath)).status).toBe(404);
    const saved = await send('PUT', '/settings', { watchRoots: [watchRoot] });
    expect(saved.status).toBe(200);
    const res = await workRepo(discoveredPath);
    expect(res.status).toBe(200);
    expect(((await res.json()) as WorkRepoFacts).name).toBe('found');
  });
});

describe('createWorkScanner', () => {
  function fakeScan() {
    const calls: string[] = [];
    const waiting: Array<{ resolve: (v: null) => void; reject: (e: Error) => void }> = [];
    const scan = (repoPath: string) => {
      calls.push(repoPath);
      return new Promise<null>((resolve, reject) => waiting.push({ resolve, reject }));
    };
    return { calls, waiting, scan };
  }

  test('a scan while one runs for the same path joins it', async () => {
    const fake = fakeScan();
    const scanWork = createWorkScanner(fake.scan);
    const first = scanWork('/a');
    const second = scanWork('/a');
    const other = scanWork('/b');
    expect(fake.calls).toEqual(['/a', '/b']);
    fake.waiting[0].resolve(null);
    fake.waiting[1].resolve(null);
    expect(await Promise.all([first, second, other])).toEqual([null, null, null]);

    const again = scanWork('/a');
    expect(fake.calls).toEqual(['/a', '/b', '/a']);
    fake.waiting[2].reject(new Error('git failed'));
    await expect(again).rejects.toThrow('git failed');
    void scanWork('/a');
    expect(fake.calls).toHaveLength(4);
  });
});

describe('one scan per repo family', () => {
  const family = (p: string) => (p.startsWith('/repo') ? '/repo/.git' : null);

  function facts(p: string): WorkRepoFacts {
    return {
      path: p,
      root: '/repo',
      name: 'repo',
      worktrees: [],
      branches: [],
      branchesCapped: false,
      identities: [],
      drafts: [],
    };
  }

  function fakeScan() {
    const calls: string[] = [];
    const waiting: Array<{ resolve: (v: WorkRepoFacts) => void; reject: (e: Error) => void }> = [];
    const scan = (repoPath: string) => {
      calls.push(repoPath);
      return new Promise<WorkRepoFacts>((resolve, reject) => waiting.push({ resolve, reject }));
    };
    return { calls, waiting, scan };
  }

  test('two paths of one repo share its scan, each answer with its own path', async () => {
    const fake = fakeScan();
    const scanWork = createWorkScanner(fake.scan, family, 1000);
    const main = scanWork('/repo');
    const linked = scanWork('/repo-linked');
    expect(fake.calls).toEqual(['/repo']);
    fake.waiting[0].resolve(facts('/repo'));
    expect(await main).toEqual(facts('/repo'));
    expect(await linked).toEqual(facts('/repo-linked'));

    // Finished, and this path was not answered yet: the same page scan, so it shares.
    expect(await scanWork('/repo-other')).toEqual(facts('/repo-other'));
    expect(fake.calls).toEqual(['/repo']);
  });

  test('asking again for a path the scan answered is a new refresh, which scans', async () => {
    const fake = fakeScan();
    const scanWork = createWorkScanner(fake.scan, family, 1000);
    const first = scanWork('/repo');
    fake.waiting[0].resolve(facts('/repo'));
    await first;

    const again = scanWork('/repo');
    const linked = scanWork('/repo-linked');
    expect(fake.calls).toEqual(['/repo', '/repo']);
    fake.waiting[1].resolve(facts('/repo'));
    expect(await again).toEqual(facts('/repo'));
    expect(await linked).toEqual(facts('/repo-linked'));
    expect(fake.calls).toHaveLength(2);
  });

  test('a finished scan is not shared once the window is over', async () => {
    const fake = fakeScan();
    const scanWork = createWorkScanner(fake.scan, family, 20);
    const main = scanWork('/repo');
    fake.waiting[0].resolve(facts('/repo'));
    await main;
    await Bun.sleep(60);
    void scanWork('/repo-linked');
    expect(fake.calls).toEqual(['/repo', '/repo-linked']);
  });

  test('a failed scan is not shared', async () => {
    const fake = fakeScan();
    const scanWork = createWorkScanner(fake.scan, family, 1000);
    const main = scanWork('/repo');
    fake.waiting[0].reject(new Error('git failed'));
    await expect(main).rejects.toThrow('git failed');
    void scanWork('/repo-linked');
    expect(fake.calls).toEqual(['/repo', '/repo-linked']);
  });

  test('a repo and its linked worktree are one family; a plain directory has none', () => {
    const linked = path.join(tmpDir, 'family-linked');
    gitExec(repoPath, `worktree add -q "${linked}" feature`);
    try {
      expect(repoFamily(repoPath)).toBe(fs.realpathSync(path.join(repoPath, '.git')));
      expect(repoFamily(linked)).toBe(repoFamily(repoPath));
      expect(repoFamily(tmpDir)).toBeNull();
    } finally {
      gitExec(repoPath, `worktree remove --force "${linked}"`);
    }
  });

  test('a discovered worktree of a discovered repo answers with its own path', async () => {
    const familyRoot = path.join(tmpDir, 'family');
    const main = path.join(familyRoot, 'main');
    const linked = path.join(familyRoot, 'main-linked');
    fs.mkdirSync(main, { recursive: true });
    gitExec(main, 'init -q --initial-branch=main');
    gitExec(main, 'config user.email t@t.t');
    gitExec(main, 'config user.name t');
    gitExec(main, 'commit -q --allow-empty -m initial');
    gitExec(main, `worktree add -q -b side "${linked}"`);
    const saved = await send('PUT', '/settings', { watchRoots: [watchRoot, familyRoot] });
    expect(saved.status).toBe(200);

    const [fromMain, fromLinked] = await Promise.all([workRepo(main), workRepo(linked)]);
    expect([fromMain.status, fromLinked.status]).toEqual([200, 200]);
    const mainFacts = (await fromMain.json()) as WorkRepoFacts;
    const linkedFacts = (await fromLinked.json()) as WorkRepoFacts;
    expect(mainFacts.path).toBe(main);
    expect(linkedFacts.path).toBe(linked);
    expect({ ...linkedFacts, path: main }).toEqual(mainFacts);
    expect(mainFacts.worktrees.map((wt) => wt.branch)).toEqual(['main', 'side']);
  });
});

describe('marks', () => {
  const KEY = '/somewhere/calculator\nfeature';

  test('PUT then GET round-trips', async () => {
    const put = await send('PUT', '/work/marks', { key: KEY, action: 'track' });
    expect(put.status).toBe(200);
    const marks = (await put.json()) as WorkMarks;
    expect(Object.keys(marks.tracked)).toEqual([KEY]);
    expect(await (await request('/work/marks')).json()).toEqual(marks);
  });

  test('a bad request is a 400', async () => {
    expect((await send('PUT', '/work/marks', { key: KEY, action: 'finish' })).status).toBe(400);
    expect((await send('PUT', '/work/marks', { key: KEY, action: 'dismiss' })).status).toBe(400);
    expect((await send('PUT', '/work/marks', { action: 'track' })).status).toBe(400);
  });

  test('a cross-site PUT is a 403', async () => {
    const res = await send(
      'PUT',
      '/work/marks',
      { key: 'x', action: 'track' },
      { 'sec-fetch-site': 'cross-site' }
    );
    expect(res.status).toBe(403);
    expect(
      Object.keys(((await (await request('/work/marks')).json()) as WorkMarks).tracked)
    ).toEqual([KEY]);
  });

  test('a write that fails is a 500 and keeps the marks', async () => {
    const socket = path.join(os.tmpdir(), `dsd-work-badmarks-${process.pid}.sock`);
    const blocker = path.join(tmpDir, 'blocker');
    fs.writeFileSync(blocker, 'a file where a directory should be');
    const broken = createDaemon({
      workMarksFile: path.join(blocker, 'work.json'),
      updateCheck: false,
    });
    await broken.listen({ socketPath: socket });
    try {
      const res = await fetch('http://localhost/work/marks', {
        method: 'PUT',
        unix: socket,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: 'x', action: 'track' }),
      } as RequestInit);
      expect(res.status).toBe(500);
      expect(((await res.json()) as { error: string }).error).toStartWith('Could not save marks:');
      const marks = await fetch('http://localhost/work/marks', { unix: socket } as RequestInit);
      expect(await marks.json()).toEqual({ tracked: {}, dismissed: {} });
    } finally {
      await broken.close();
      fs.rmSync(socket, { force: true });
    }
  });
});
