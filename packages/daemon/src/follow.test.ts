/**
 * Daemon-scope SSE channel (GET /events) + follow mode, over real HTTP on
 * a unix socket, with the real chokidar hook-file watcher.
 *
 * Two daemons: one without follow (the /events repo-opened/repo-closed
 * lifecycle and the disabled GET /follow shape), one following a temp hook
 * file under /tmp (never the real ~/.cache default). Watcher timing is
 * asynchronous (chokidar + a 100ms debounce), so event assertions collect
 * from the stream under a generous deadline instead of expecting a fixed
 * sequence.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createDaemon, Daemon } from './server.js';
import {
  createFixtureRepo,
  removeFixtureRepo,
  writeFixtureFile,
  gitExec,
  SseReader,
} from './test-helpers.js';

const FIXTURE = 'daemon-follow';

function makeRepo(name: string): string {
  const repoPath = createFixtureRepo(name);
  writeFixtureFile(repoPath, 'file.txt', 'content\n');
  gitExec(repoPath, 'add .');
  gitExec(repoPath, 'commit -m "initial commit"');
  return repoPath;
}

function requestOn(socket: string, pathname: string, init?: RequestInit): Promise<Response> {
  const options = { ...init, unix: socket };
  return fetch(`http://localhost${pathname}`, options as RequestInit);
}

interface WireFollow {
  targetFile: string | null;
  enabled: boolean;
  followedRepoId: string | null;
  followedPath: string | null;
}

/**
 * Read events until the predicate accepts one; returns every event seen up
 * to and including the match (so callers can also assert on side events).
 */
async function collectUntil(
  sse: SseReader,
  predicate: (evt: { event: string; data: string }) => boolean,
  timeoutMs: number
): Promise<Array<{ event: string; data: string }>> {
  const deadline = Date.now() + timeoutMs;
  const seen: Array<{ event: string; data: string }> = [];
  for (;;) {
    const evt = await sse.next(Math.max(1, deadline - Date.now()));
    seen.push(evt);
    if (predicate(evt)) return seen;
  }
}

describe('daemon-scope /events channel (no follow)', () => {
  const SOCKET = path.join(os.tmpdir(), `dsd-events-${process.pid}.sock`);
  let daemon: Daemon;
  let repoPath: string;

  beforeAll(async () => {
    repoPath = makeRepo(`${FIXTURE}-events`);
    daemon = createDaemon();
    await daemon.listen({ socketPath: SOCKET });
  });

  afterAll(async () => {
    await daemon.close();
    removeFixtureRepo(`${FIXTURE}-events`);
    fs.rmSync(SOCKET, { force: true });
  });

  test('GET /follow without follow mode reports enabled:false', async () => {
    const res = await requestOn(SOCKET, '/follow');
    expect(res.status).toBe(200);
    expect((await res.json()) as WireFollow).toEqual({
      targetFile: null,
      enabled: false,
      followedRepoId: null,
      followedPath: null,
    });
  });

  test('snapshot on connect, repo-opened on POST, repo-closed on last DELETE', async () => {
    const res = await requestOn(SOCKET, '/events');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');

    const sse = new SseReader(res.body!);
    try {
      const first = await sse.next(3000);
      expect(first.event).toBe('snapshot');
      expect(JSON.parse(first.data)).toEqual([]);

      // Open: the daemon channel announces the new repo to every client.
      const open = await requestOn(SOCKET, '/repos', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: repoPath }),
      });
      expect(open.status).toBe(201);
      const openedBody = (await open.json()) as { id: string; path: string };

      const opened = await sse.next(5000);
      expect(opened.event).toBe('repo-opened');
      expect(JSON.parse(opened.data)).toEqual({ id: openedBody.id, path: openedBody.path });

      // Idempotent re-open takes a second ref and must NOT re-announce;
      // the first DELETE only decrements — no repo-closed either.
      await requestOn(SOCKET, '/repos', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: repoPath }),
      });
      await requestOn(SOCKET, `/repos/${openedBody.id}`, { method: 'DELETE' });

      // Dropping the LAST ref disposes the repo and announces repo-closed.
      // The SSE connection itself holds no repo ref.
      await requestOn(SOCKET, `/repos/${openedBody.id}`, { method: 'DELETE' });
      const closed = await sse.next(5000);
      expect(closed.event).toBe('repo-closed');
      expect(JSON.parse(closed.data)).toEqual({ id: openedBody.id });
    } finally {
      await sse.close();
    }
  }, 20000);

  test('snapshot lists already-open repos', async () => {
    const open = await requestOn(SOCKET, '/repos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: repoPath }),
    });
    const openedBody = (await open.json()) as { id: string; path: string };

    const res = await requestOn(SOCKET, '/events');
    const sse = new SseReader(res.body!);
    try {
      const first = await sse.next(3000);
      expect(first.event).toBe('snapshot');
      expect(JSON.parse(first.data)).toEqual([{ id: openedBody.id, path: openedBody.path }]);
    } finally {
      await sse.close();
      await requestOn(SOCKET, `/repos/${openedBody.id}`, { method: 'DELETE' });
    }
  });
});

describe('follow mode', () => {
  const SOCKET = path.join(os.tmpdir(), `dsd-follow-${process.pid}.sock`);
  const FOLLOW_FILE = path.join(os.tmpdir(), `ds-follow-${process.pid}`);
  let daemon: Daemon;
  let repoA: string;
  let repoB: string;

  beforeAll(async () => {
    repoA = makeRepo(`${FIXTURE}-a`);
    repoB = makeRepo(`${FIXTURE}-b`);
    fs.rmSync(FOLLOW_FILE, { force: true });
    daemon = createDaemon({ followFile: FOLLOW_FILE });
    await daemon.listen({ socketPath: SOCKET });
    // Give chokidar a moment to establish the hook-file watch before the
    // tests write to it.
    await new Promise((resolve) => setTimeout(resolve, 300));
  });

  afterAll(async () => {
    await daemon.close();
    removeFixtureRepo(`${FIXTURE}-a`);
    removeFixtureRepo(`${FIXTURE}-b`);
    fs.rmSync(FOLLOW_FILE, { force: true });
    fs.rmSync(SOCKET, { force: true });
  });

  test('the watcher created the hook file', () => {
    expect(fs.existsSync(FOLLOW_FILE)).toBe(true);
  });

  test('writing a repo path opens it and broadcasts follow-change', async () => {
    const res = await requestOn(SOCKET, '/events');
    const sse = new SseReader(res.body!);
    try {
      expect((await sse.next(3000)).event).toBe('snapshot');

      // Hook files are append-only in practice; the watcher reads the last
      // non-empty line.
      fs.appendFileSync(FOLLOW_FILE, `${repoA}\n`);

      const seen = await collectUntil(sse, (evt) => evt.event === 'follow-change', 15000);
      const change = JSON.parse(seen.at(-1)!.data) as {
        repoId: string;
        path: string;
        rawContent: string;
      };
      expect(change.repoId).toMatch(/^[0-9a-f]{12}$/);
      expect(fs.realpathSync(change.path)).toBe(fs.realpathSync(repoA));
      expect(change.rawContent).toBe(repoA);
      // The auto-open was announced on the same channel.
      expect(seen.some((evt) => evt.event === 'repo-opened')).toBe(true);

      // The followed repo is genuinely open (held by the follow-ref).
      const repos = (await (await requestOn(SOCKET, '/repos')).json()) as Array<{ id: string }>;
      expect(repos.map((r) => r.id)).toContain(change.repoId);

      // GET /follow reflects the hook file and the followed repo.
      const follow = (await (await requestOn(SOCKET, '/follow')).json()) as WireFollow;
      expect(follow.enabled).toBe(true);
      expect(follow.targetFile).toBe(FOLLOW_FILE);
      expect(follow.followedRepoId).toBe(change.repoId);
      expect(fs.realpathSync(follow.followedPath!)).toBe(fs.realpathSync(repoA));
    } finally {
      await sse.close();
    }
  }, 30000);

  test('switching targets releases the old follow-ref (old repo closes)', async () => {
    const oldFollow = (await (await requestOn(SOCKET, '/follow')).json()) as WireFollow;
    const oldId = oldFollow.followedRepoId!;
    expect(oldId).toBeTruthy();

    const res = await requestOn(SOCKET, '/events');
    const sse = new SseReader(res.body!);
    try {
      expect((await sse.next(3000)).event).toBe('snapshot');

      fs.appendFileSync(FOLLOW_FILE, `${repoB}\n`);

      // The switch produces follow-change for B and — since nothing else
      // held repo A — repo-closed for A. Order not asserted: collect both.
      const seen = await collectUntil(
        sse,
        (evt) =>
          evt.event === 'follow-change' &&
          (JSON.parse(evt.data) as { repoId: string }).repoId !== oldId,
        15000
      );
      const change = JSON.parse(seen.at(-1)!.data) as { repoId: string; path: string };
      expect(fs.realpathSync(change.path)).toBe(fs.realpathSync(repoB));

      const closedIds = seen
        .filter((evt) => evt.event === 'repo-closed')
        .map((evt) => (JSON.parse(evt.data) as { id: string }).id);
      expect(closedIds).toContain(oldId);

      const follow = (await (await requestOn(SOCKET, '/follow')).json()) as WireFollow;
      expect(follow.followedRepoId).toBe(change.repoId);
      expect(fs.realpathSync(follow.followedPath!)).toBe(fs.realpathSync(repoB));

      // Only the new followed repo remains open.
      const repos = (await (await requestOn(SOCKET, '/repos')).json()) as Array<{ id: string }>;
      expect(repos.map((r) => r.id)).toEqual([change.repoId]);
    } finally {
      await sse.close();
    }
  }, 30000);

  test('a non-repo path is ignored: no broadcast, follow state untouched', async () => {
    const before = (await (await requestOn(SOCKET, '/follow')).json()) as WireFollow;
    expect(before.followedRepoId).toBeTruthy();

    const res = await requestOn(SOCKET, '/events');
    const sse = new SseReader(res.body!);
    try {
      expect((await sse.next(3000)).event).toBe('snapshot');

      fs.appendFileSync(FOLLOW_FILE, '/definitely/not/a/repo\n');

      // No follow-change may arrive for the bogus path; wait past the
      // watcher debounce, then confirm silence and unchanged state.
      await expect(sse.next(1500)).rejects.toThrow('Timed out');

      const after = (await (await requestOn(SOCKET, '/follow')).json()) as WireFollow;
      expect(after.followedRepoId).toBe(before.followedRepoId);
      expect(after.followedPath).toBe(before.followedPath);
    } finally {
      await sse.close();
    }
  }, 20000);
});
