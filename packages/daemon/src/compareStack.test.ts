/**
 * Stacked compare over a real unix socket (docs/stacked-compare.md §4):
 * `GET /compare/stack`, and `?head=` on /compare, /compare/count and
 * /compare/file.
 *
 * Self-contained: own daemons (one per API mode, since the stack is a
 * read and must be routed on both), own sockets, own fixture repo, and an
 * own XDG_CACHE_HOME so the base-branch cache never touches the user's.
 *
 * Fixture shape: main with one commit and a remote-tracking upstream/main
 * at its tip; a three-layer stack bottom (1 commit) < middle (2) < top (1)
 * checked out at top, each layer with an upstream/ copy; an uncommitted
 * edit to a tracked file at HEAD.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CompareStack } from '@diffstalker/core/types/stack';
import { createDaemon, Daemon } from './server.js';
import { createFixtureRepo, removeFixtureRepo, writeFixtureFile, gitExec } from './test-helpers.js';

const FIXTURE = 'daemon-compare-stack';
const SOCKET = path.join(os.tmpdir(), `diffstalkerd-stack-${process.pid}.sock`);
const WEB_SOCKET = path.join(os.tmpdir(), `diffstalkerd-stack-web-${process.pid}.sock`);

let daemon: Daemon;
let webDaemon: Daemon;
let repoPath: string;
let repoId: string;
let webRepoId: string;
let cacheHome: string;
let savedCacheHome: string | undefined;

interface WireCompareDiff {
  baseBranch: string;
  files: Array<{ path: string; uncommitted?: string }>;
  commits: Array<{ message: string }>;
}

function request(pathname: string, socket: string = SOCKET): Promise<Response> {
  return fetch(`http://localhost${pathname}`, { unix: socket } as RequestInit);
}

async function errorOf(res: Response): Promise<string> {
  return ((await res.json()) as { error: string }).error;
}

function commit(file: string, message: string): void {
  writeFixtureFile(repoPath, file, `${message}\n`);
  gitExec(repoPath, `add ${file}`);
  gitExec(repoPath, `commit -m "${message}"`);
}

async function openOn(socket: string): Promise<string> {
  const res = await fetch('http://localhost/repos', {
    method: 'POST',
    unix: socket,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: repoPath }),
  } as RequestInit);
  expect([200, 201]).toContain(res.status);
  return ((await res.json()) as { id: string }).id;
}

beforeAll(async () => {
  savedCacheHome = process.env.XDG_CACHE_HOME;
  cacheHome = fs.mkdtempSync(path.join(os.tmpdir(), 'diffstalkerd-stack-xdg-'));
  process.env.XDG_CACHE_HOME = cacheHome;

  repoPath = createFixtureRepo(FIXTURE);
  commit('base.txt', 'base');
  gitExec(repoPath, 'update-ref refs/remotes/upstream/main main');
  gitExec(repoPath, 'checkout -b bottom');
  commit('bottom.txt', 'bottom');
  gitExec(repoPath, 'update-ref refs/remotes/upstream/bottom bottom');
  gitExec(repoPath, 'checkout -b middle');
  commit('middle.txt', 'middle one');
  commit('middle.txt', 'middle two');
  gitExec(repoPath, 'update-ref refs/remotes/upstream/middle middle');
  gitExec(repoPath, 'checkout -b top');
  commit('top.txt', 'top');
  writeFixtureFile(repoPath, 'base.txt', 'base\ndirty\n');

  daemon = createDaemon({ apiMode: 'full', updateCheck: false });
  webDaemon = createDaemon({ apiMode: 'web', updateCheck: false });
  await daemon.listen({ socketPath: SOCKET });
  await webDaemon.listen({ socketPath: WEB_SOCKET });
  repoId = await openOn(SOCKET);
  webRepoId = await openOn(WEB_SOCKET);
});

afterAll(async () => {
  await daemon.close();
  await webDaemon.close();
  removeFixtureRepo(FIXTURE);
  fs.rmSync(SOCKET, { force: true });
  fs.rmSync(WEB_SOCKET, { force: true });
  fs.rmSync(cacheHome, { recursive: true, force: true });
  if (savedCacheHome === undefined) {
    delete process.env.XDG_CACHE_HOME;
  } else {
    process.env.XDG_CACHE_HOME = savedCacheHome;
  }
});

describe('GET /compare/stack', () => {
  test('lists the layers bottom to top with their refs and counts', async () => {
    const res = await request(`/repos/${repoId}/compare/stack?base=upstream/main`);
    expect(res.status).toBe(200);
    const stack = (await res.json()) as CompareStack;
    expect(stack.trunk).toBe('upstream/main');
    expect(stack.forkedAbove).toBe(false);
    expect(stack.layers.map((l) => [l.name, l.commits, l.isHead])).toEqual([
      ['bottom', 1, false],
      ['middle', 2, false],
      ['top', 1, true],
    ]);
    expect(stack.layers[0].refs).toEqual(['bottom', 'upstream/bottom']);
    expect(stack.layers[2].refs).toEqual(['top']);
    for (const layer of stack.layers) expect(layer.tip).toMatch(/^[0-9a-f]{40}$/);
  });

  test('without base resolves the same base /compare would', async () => {
    // Nothing persisted: the discovered default is upstream/main, the one
    // remote-tracking ref in recent history.
    const res = await request(`/repos/${repoId}/compare/stack`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as CompareStack).trunk).toBe('upstream/main');
  });

  test('an unknown or flag-shaped base is a 400, as on /compare', async () => {
    const unknown = await request(`/repos/${repoId}/compare/stack?base=doesnotexist`);
    expect(unknown.status).toBe(400);
    expect(await errorOf(unknown)).toBe('Unknown base ref: doesnotexist');
    const flag = await request(`/repos/${repoId}/compare/stack?base=--output=x`);
    expect(flag.status).toBe(400);
  });

  test('is routed in web mode too', async () => {
    const res = await request(`/repos/${webRepoId}/compare/stack?base=upstream/main`, WEB_SOCKET);
    expect(res.status).toBe(200);
    expect(((await res.json()) as CompareStack).layers).toHaveLength(3);
  });
});

describe('?head= on the compare routes', () => {
  test('GET /compare?head= reads one layer: base...head', async () => {
    const res = await request(`/repos/${repoId}/compare?base=bottom&head=middle`);
    expect(res.status).toBe(200);
    const diff = (await res.json()) as WireCompareDiff;
    expect(diff.baseBranch).toBe('bottom');
    expect(diff.files.map((f) => f.path)).toEqual(['middle.txt']);
    expect(diff.commits.map((c) => c.message)).toEqual(['middle two', 'middle one']);
  });

  test('GET /compare/count?head= counts the same range', async () => {
    const res = await request(`/repos/${repoId}/compare/count?base=bottom&head=middle`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ baseBranch: 'bottom', commits: 2 });
    // The merge-base is against the head: from top, main...bottom is
    // bottom's one commit, not the whole stack.
    const bottom = await request(`/repos/${repoId}/compare/count?base=upstream/main&head=bottom`);
    expect(await bottom.json()).toEqual({ baseBranch: 'upstream/main', commits: 1 });
  });

  test('GET /compare/file?head= reads the file inside base...head', async () => {
    const res = await request(
      `/repos/${repoId}/compare/file?path=middle.txt&base=bottom&head=middle`
    );
    expect(res.status).toBe(200);
    const diff = (await res.json()) as { lines: { content: string }[] };
    const text = diff.lines.map((l) => l.content).join('\n');
    expect(text).toContain('+middle two');
    expect(text).not.toContain('top');
  });

  test('an absent head is HEAD: the answer is unchanged', async () => {
    const implicit = (await (
      await request(`/repos/${repoId}/compare?base=upstream/main`)
    ).json()) as WireCompareDiff;
    const explicit = (await (
      await request(`/repos/${repoId}/compare?base=upstream/main&head=top`)
    ).json()) as WireCompareDiff;
    expect(explicit).toEqual(implicit);
    expect(implicit.commits).toHaveLength(4);
  });

  test('an unknown head is a 400 naming the ref, on every route', async () => {
    for (const route of ['compare', 'compare/count', 'compare/file?path=middle.txt&x=']) {
      const sep = route.includes('?') ? '&' : '?';
      const res = await request(`/repos/${repoId}/${route}${sep}base=bottom&head=nope`);
      expect(res.status).toBe(400);
      expect(await errorOf(res)).toBe('Unknown head ref: nope');
    }
  });

  test('a flag-shaped or empty head is refused before git sees it', async () => {
    const flag = await request(`/repos/${repoId}/compare?base=bottom&head=--output=x`);
    expect(flag.status).toBe(400);
    expect(await errorOf(flag)).toContain('must not start with "-"');
    const empty = await request(`/repos/${repoId}/compare/count?base=bottom&head=`);
    expect(empty.status).toBe(400);
    expect(await errorOf(empty)).toContain('expected a ref');
  });

  test('head together with any uncommitted flag is a 400', async () => {
    // Uncommitted work only exists against HEAD; the client never sends
    // this, and the daemon must not pick one of the two.
    for (const flag of ['staged', 'unstaged', 'untracked']) {
      const res = await request(`/repos/${repoId}/compare?base=bottom&head=middle&${flag}=true`);
      expect(res.status).toBe(400);
      expect(await errorOf(res)).toContain('head');
    }
    // ...and with the flags false it is the plain layer compare.
    const ok = await request(
      `/repos/${repoId}/compare?base=bottom&head=middle&staged=false&unstaged=false`
    );
    expect(ok.status).toBe(200);
  });

  test('GET /compare/file with head and uncommitted= is a 400, untracked included', async () => {
    for (const kind of ['staged', 'unstaged', 'both', 'untracked']) {
      const res = await request(
        `/repos/${repoId}/compare/file?path=base.txt&head=middle&uncommitted=${kind}`
      );
      expect(res.status).toBe(400);
      expect(await errorOf(res)).toContain('head');
    }
  });

  test('a head with no common history is a 422, as for a base', async () => {
    gitExec(repoPath, 'checkout --orphan orphan');
    gitExec(repoPath, 'add -A');
    gitExec(repoPath, 'commit -m "orphan root"');
    gitExec(repoPath, 'checkout top');
    try {
      const res = await request(`/repos/${repoId}/compare?base=upstream/main&head=orphan`);
      expect(res.status).toBe(422);
      expect(await errorOf(res)).toContain('No common history');
    } finally {
      gitExec(repoPath, 'branch -D orphan');
    }
  });

  test('head is routed in web mode too, on all three routes', async () => {
    const count = await request(`/repos/${webRepoId}/compare/count?base=bottom&head=middle`, WEB_SOCKET);
    expect(count.status).toBe(200);
    expect(await count.json()).toEqual({ baseBranch: 'bottom', commits: 2 });

    const compare = await request(`/repos/${webRepoId}/compare?base=bottom&head=middle`, WEB_SOCKET);
    expect(compare.status).toBe(200);
    const diff = (await compare.json()) as WireCompareDiff;
    expect(diff.files.map((f) => f.path)).toEqual(['middle.txt']);
    expect(diff.commits).toHaveLength(2);

    const file = await request(
      `/repos/${webRepoId}/compare/file?path=middle.txt&base=bottom&head=middle`,
      WEB_SOCKET
    );
    expect(file.status).toBe(200);
    const lines = ((await file.json()) as { lines: { content: string }[] }).lines;
    expect(lines.map((l) => l.content).join('\n')).toContain('+middle two');

    // The refusals hold there as well.
    const mixed = await request(
      `/repos/${webRepoId}/compare?base=bottom&head=middle&unstaged=true`,
      WEB_SOCKET
    );
    expect(mixed.status).toBe(400);
  });
});
