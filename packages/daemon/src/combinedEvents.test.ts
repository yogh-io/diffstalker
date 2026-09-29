/**
 * The combined SSE stream: GET /events?repo=<id> carries the daemon events
 * AND one repo's events on one connection, over real HTTP on a unix
 * socket. The per-repo GET /repos/:id/events stream is covered in
 * server.test.ts and journal.test.ts; this file checks what the combined
 * form adds — the connect order, an unknown (or empty) repo, journal
 * appends riding along, the repo closing under a live stream (alone, and
 * beside a per-repo stream on the same repo), and teardown when the
 * client goes away.
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

const FIXTURE = 'daemon-combined-events';
const SOCKET = path.join(os.tmpdir(), `dsd-combined-${process.pid}.sock`);

let daemon: Daemon;
let repoPath: string;

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

/** Open the fixture repo (one ref) and return its id. */
async function openRepo(): Promise<string> {
  const res = await postJson('/repos', { path: repoPath });
  expect([200, 201]).toContain(res.status);
  return ((await res.json()) as { id: string }).id;
}

interface WireStatus {
  status: { files: { path: string; staged: boolean }[] } | null;
  hunkCounts: unknown;
}

interface WireJournalEntry {
  type: 'hunk' | 'boundary';
  seq: number;
  path?: string;
  seeded?: boolean;
}

/** Poll the journal until pred holds (the seeding observation is async). */
async function journalWhen(
  id: string,
  pred: (entries: WireJournalEntry[]) => boolean,
  timeoutMs = 5000
): Promise<WireJournalEntry[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await request(`/repos/${id}/journal`);
    expect(res.status).toBe(200);
    const { entries } = (await res.json()) as { entries: WireJournalEntry[] };
    if (pred(entries)) return entries;
    if (Date.now() > deadline) throw new Error('Timed out waiting for journal entries');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Read events until the predicate accepts one; returns every event seen. */
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

beforeAll(async () => {
  repoPath = createFixtureRepo(FIXTURE);
  writeFixtureFile(repoPath, 'file.txt', 'original line\n');
  gitExec(repoPath, 'add .');
  gitExec(repoPath, 'commit -m "initial commit"');
  // An unstaged change, so a stage mutation has something to do.
  writeFixtureFile(repoPath, 'file.txt', 'original line\nmodified line\n');

  daemon = createDaemon({ fetchLatestVersion: () => Promise.resolve('99.0.0') });
  await daemon.listen({ socketPath: SOCKET });
});

afterAll(async () => {
  await daemon.close();
  removeFixtureRepo(FIXTURE);
  fs.rmSync(SOCKET, { force: true });
});

describe('GET /events?repo= (combined stream)', () => {
  test('daemon snapshot first, then repo-snapshot, then the repo state-change', async () => {
    const id = await openRepo();
    const res = await request(`/events?repo=${id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');

    const sse = new SseReader(res.body!);
    try {
      const first = await sse.next(3000);
      expect(first.event).toBe('snapshot');
      expect(JSON.parse(first.data)).toEqual([{ id, path: repoPath }]);

      // The repo's own initial state rides second, under its own name.
      const second = await sse.next(3000);
      expect(second.event).toBe('repo-snapshot');
      const snapshot = JSON.parse(second.data) as WireStatus;
      expect(snapshot).toHaveProperty('status');
      expect(snapshot).toHaveProperty('hunkCounts');

      // A mutation refreshes the manager, which fans out state-change on
      // this same stream, with the same payload the per-repo stream sends.
      const stage = await postJson(`/repos/${id}/stage`, { path: 'file.txt' });
      expect(stage.status).toBe(200);
      await collectUntil(
        sse,
        (evt) =>
          evt.event === 'state-change' &&
          ((JSON.parse(evt.data) as WireStatus).status?.files ?? []).some(
            (f) => f.path === 'file.txt' && f.staged
          ),
        5000
      );
      await postJson(`/repos/${id}/unstage`, { path: 'file.txt' });
    } finally {
      await sse.close();
      await request(`/repos/${id}`, { method: 'DELETE' });
    }
  }, 15000);

  test('an unknown repo is a 200 with repo-missing, and the daemon events still flow', async () => {
    const res = await request('/events?repo=not-open');
    expect(res.status).toBe(200);

    const sse = new SseReader(res.body!);
    try {
      const first = await sse.next(3000);
      expect(first.event).toBe('snapshot');
      expect(JSON.parse(first.data)).toEqual([]);

      const missing = await sse.next(3000);
      expect(missing.event).toBe('repo-missing');
      expect(JSON.parse(missing.data)).toEqual({ id: 'not-open' });

      // The stream is the daemon stream: opening a repo announces itself
      // here, which is how a reconnected page recovers.
      const id = await openRepo();
      const opened = await sse.next(5000);
      expect(opened.event).toBe('repo-opened');
      expect(JSON.parse(opened.data)).toEqual({ id, path: repoPath });
      await request(`/repos/${id}`, { method: 'DELETE' });
    } finally {
      await sse.close();
    }
  }, 15000);

  test('closing the repo under a live stream says repo-missing and keeps the stream up', async () => {
    const id = await openRepo();
    const res = await request(`/events?repo=${id}`);
    const sse = new SseReader(res.body!);
    try {
      expect((await sse.next(3000)).event).toBe('snapshot');
      expect((await sse.next(3000)).event).toBe('repo-snapshot');

      // Last ref gone: the registry disposes the repo. The repo channel
      // must detach this response, not end it.
      await request(`/repos/${id}`, { method: 'DELETE' });
      const seen = await collectUntil(sse, (evt) => evt.event === 'repo-closed', 5000);
      const names = seen.map((evt) => evt.event);
      // The repo side says goodbye BEFORE the daemon side announces the
      // close: a client that reacts to repo-closed finds no repo events
      // still pending behind it.
      expect(names).toContain('repo-missing');
      expect(names.indexOf('repo-missing')).toBeLessThan(names.indexOf('repo-closed'));
      const missing = seen[names.indexOf('repo-missing')];
      expect(JSON.parse(missing.data)).toEqual({ id });
      expect(JSON.parse(seen[seen.length - 1].data)).toEqual({ id });

      // Still a live daemon stream: a later broadcast arrives.
      const reopened = await openRepo();
      expect(reopened).toBe(id);
      const opened = await sse.next(5000);
      expect(opened.event).toBe('repo-opened');
      expect(JSON.parse(opened.data)).toEqual({ id, path: repoPath });
      await request(`/repos/${id}`, { method: 'DELETE' });
    } finally {
      await sse.close();
    }
  }, 15000);

  test('an empty repo= is no repo at all: the plain daemon stream, no repo-missing', async () => {
    const res = await request('/events?repo=');
    expect(res.status).toBe(200);

    const sse = new SseReader(res.body!);
    try {
      expect((await sse.next(3000)).event).toBe('snapshot');
      // Nothing follows: no repo-missing for an id that was never given.
      await expect(sse.next(500)).rejects.toThrow('Timed out');
    } finally {
      await sse.close();
    }
  }, 15000);

  test('journal-append rides the combined stream', async () => {
    const id = await openRepo();
    const res = await request(`/events?repo=${id}`);
    const sse = new SseReader(res.body!);
    try {
      expect((await sse.next(3000)).event).toBe('snapshot');
      expect((await sse.next(3000)).event).toBe('repo-snapshot');
      // Seeding is async: the start boundary and the seeded hunk for the
      // fixture's edit must be in before a new edit can supersede it.
      await journalWhen(id, (entries) => entries.length >= 2);

      // Grow the tracked edit, then force a refresh through a mutation:
      // the observation classifies the changed hunk and appends.
      writeFixtureFile(repoPath, 'file.txt', 'original line\nmodified line\nthird line\n');
      await postJson(`/repos/${id}/stage`, { path: 'file.txt' });

      const seen = await collectUntil(
        sse,
        (evt) =>
          evt.event === 'journal-append' &&
          (JSON.parse(evt.data) as { entries: WireJournalEntry[] }).entries.some(
            (e) => e.type === 'hunk' && e.path === 'file.txt' && !e.seeded
          ),
        5000
      );
      const payload = JSON.parse(seen[seen.length - 1].data) as {
        epoch: string;
        entries: WireJournalEntry[];
      };
      // The same payload the per-repo stream sends: the store's epoch
      // rides along so a client can spot a reset store.
      expect(typeof payload.epoch).toBe('string');
      expect(payload.epoch.length).toBeGreaterThan(0);
      await postJson(`/repos/${id}/unstage`, { path: 'file.txt' });
    } finally {
      await sse.close();
      await request(`/repos/${id}`, { method: 'DELETE' });
    }
  }, 15000);

  test('a per-repo stream and a combined stream share one channel; closing ends only the owned one', async () => {
    const id = await openRepo();
    const manager = daemon.getRepo(id)!.manager;
    const baseline = manager.workingTree.listenerCount('state-change');
    const owned = new SseReader((await request(`/repos/${id}/events`)).body!);
    const attached = new SseReader((await request(`/events?repo=${id}`)).body!);
    let fresh: SseReader | null = null;
    try {
      expect((await owned.next(3000)).event).toBe('snapshot');
      expect((await attached.next(3000)).event).toBe('snapshot');
      expect((await attached.next(3000)).event).toBe('repo-snapshot');
      // One channel, two subscribers: the manager has ONE listener.
      expect(manager.workingTree.listenerCount('state-change')).toBe(baseline + 1);

      // Last ref gone. The owned stream ends; the attached one stays up
      // and hears repo-missing first, then the daemon's repo-closed.
      await request(`/repos/${id}`, { method: 'DELETE' });
      await expect(owned.next(3000)).rejects.toThrow('SSE stream ended unexpectedly');
      const seen = await collectUntil(attached, (evt) => evt.event === 'repo-closed', 5000);
      const names = seen.map((evt) => evt.event);
      expect(names.indexOf('repo-missing')).toBeLessThan(names.indexOf('repo-closed'));
      expect(JSON.parse(seen[names.indexOf('repo-missing')].data)).toEqual({ id });

      // Reopen the same id with a new combined stream. The old attached
      // stream is a daemon stream now: it hears repo-opened, and nothing
      // of the repo's — the new channel has only the fresh subscriber.
      expect(await openRepo()).toBe(id);
      const opened = await attached.next(5000);
      expect(opened.event).toBe('repo-opened');
      fresh = new SseReader((await request(`/events?repo=${id}`)).body!);
      expect((await fresh.next(3000)).event).toBe('snapshot');
      expect((await fresh.next(3000)).event).toBe('repo-snapshot');
      const reopened = daemon.getRepo(id)!.manager;
      expect(reopened.workingTree.listenerCount('state-change')).toBe(baseline + 1);

      await postJson(`/repos/${id}/stage`, { path: 'file.txt' });
      await collectUntil(fresh, (evt) => evt.event === 'state-change', 5000);
      await expect(attached.next(1000)).rejects.toThrow('Timed out');
      await postJson(`/repos/${id}/unstage`, { path: 'file.txt' });
    } finally {
      await owned.close();
      await attached.close();
      await fresh?.close();
      await request(`/repos/${id}`, { method: 'DELETE' });
    }
  }, 20000);

  test('a client disconnect frees the repo channel (bun-safe teardown)', async () => {
    const id = await openRepo();
    try {
      // The daemon constructs its managers itself; reach the live one
      // through it, never core's path-keyed registry.
      const manager = daemon.getRepo(id)!.manager;
      const baseline = manager.workingTree.listenerCount('state-change');

      const controller = new AbortController();
      const res = await request(`/events?repo=${id}`, { signal: controller.signal });
      expect(res.status).toBe(200);

      const sse = new SseReader(res.body!);
      expect((await sse.next(3000)).event).toBe('snapshot');
      expect((await sse.next(3000)).event).toBe('repo-snapshot');
      expect(manager.workingTree.listenerCount('state-change')).toBe(baseline + 1);

      controller.abort();
      const deadline = Date.now() + 5000;
      while (
        manager.workingTree.listenerCount('state-change') > baseline &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(manager.workingTree.listenerCount('state-change')).toBe(baseline);
    } finally {
      await request(`/repos/${id}`, { method: 'DELETE' });
    }
  }, 15000);

  test('the per-repo stream still ends when its repo closes', async () => {
    // The CLI's stream is owned by the repo channel, so the old behaviour
    // holds there: no repo, no stream.
    const id = await openRepo();
    const res = await request(`/repos/${id}/events`);
    const sse = new SseReader(res.body!);
    try {
      expect((await sse.next(3000)).event).toBe('snapshot');
      await request(`/repos/${id}`, { method: 'DELETE' });
      await expect(sse.next(5000)).rejects.toThrow('SSE stream ended unexpectedly');
    } finally {
      await sse.close();
    }
  }, 15000);
});
