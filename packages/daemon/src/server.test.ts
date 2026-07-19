/**
 * Real HTTP integration tests: the daemon listens on an ephemeral unix
 * socket and we make real requests over it (bun's fetch supports a `unix`
 * option) against a temp git repo fixture.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createDaemon, Daemon } from './server.js';
import { createFixtureRepo, removeFixtureRepo, writeFixtureFile, gitExec } from './test-helpers.js';

const FIXTURE = 'daemon-server';
const SOCKET = path.join(os.tmpdir(), `diffstalkerd-test-${process.pid}.sock`);

let daemon: Daemon;
let repoPath: string;
let repoId: string;

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

interface WireFile {
  path: string;
  status: string;
  staged: boolean;
}

interface WireStatus {
  status: {
    files: WireFile[];
    branch: { current: string };
    isRepo: boolean;
  } | null;
  hunkCounts: {
    staged: Record<string, number>;
    unstaged: Record<string, number>;
  } | null;
}

/** Poll GET status until the predicate holds (staging refreshes are async). */
async function pollStatus(
  id: string,
  predicate: (wire: WireStatus) => boolean,
  timeoutMs = 5000
): Promise<WireStatus> {
  const deadline = Date.now() + timeoutMs;
  let last: WireStatus | null = null;
  while (Date.now() < deadline) {
    const res = await request(`/repos/${id}/status`);
    expect(res.status).toBe(200);
    last = (await res.json()) as WireStatus;
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for status condition; last: ${JSON.stringify(last)}`);
}

/** Incremental SSE reader with per-event timeout. */
class SseReader {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private decoder = new TextDecoder();
  private buffer = '';

  constructor(body: ReadableStream<Uint8Array>) {
    this.reader = body.getReader();
  }

  async next(timeoutMs: number): Promise<{ event: string; data: string }> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const parsed = this.takeEvent();
      if (parsed) return parsed;

      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('Timed out waiting for SSE event');

      const result = await Promise.race([
        this.reader.read(),
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), remaining)),
      ]);
      if (result === 'timeout') throw new Error('Timed out waiting for SSE event');
      if (result.done) throw new Error('SSE stream ended unexpectedly');
      this.buffer += this.decoder.decode(result.value, { stream: true });
    }
  }

  private takeEvent(): { event: string; data: string } | null {
    const end = this.buffer.indexOf('\n\n');
    if (end === -1) return null;
    const block = this.buffer.slice(0, end);
    this.buffer = this.buffer.slice(end + 2);

    let event = '';
    let data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice(7);
      else if (line.startsWith('data: ')) data = line.slice(6);
    }
    if (!event && !data) return this.takeEvent(); // comment/ping block
    return { event, data };
  }

  async close(): Promise<void> {
    await this.reader.cancel().catch(() => {});
  }
}

beforeAll(async () => {
  repoPath = createFixtureRepo(FIXTURE);
  writeFixtureFile(repoPath, 'file.txt', 'original line\n');
  writeFixtureFile(repoPath, 'other.txt', 'other content\n');
  gitExec(repoPath, 'add .');
  gitExec(repoPath, 'commit -m "initial commit"');

  // Working tree changes the tests assert on
  writeFixtureFile(repoPath, 'file.txt', 'original line\nmodified line\n');
  writeFixtureFile(repoPath, 'untracked.txt', 'hello untracked\n');

  daemon = createDaemon();
  await daemon.listen({ socketPath: SOCKET });
});

afterAll(async () => {
  await daemon.close();
  removeFixtureRepo(FIXTURE);
  fs.rmSync(SOCKET, { force: true });
});

describe('daemon over unix socket', () => {
  test('GET /health responds ok', async () => {
    const res = await request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ready: true });
  });

  test('unknown route is a JSON 404', async () => {
    const res = await request('/nope');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain('/nope');
  });

  test('POST /repos opens the repo and GET /repos lists it', async () => {
    const res = await postJson('/repos', { path: repoPath });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; path: string };
    expect(body.id).toMatch(/^r\d+$/);
    expect(fs.realpathSync(body.path)).toBe(fs.realpathSync(repoPath));
    repoId = body.id;

    const list = await request('/repos');
    expect(list.status).toBe(200);
    const repos = (await list.json()) as Array<{ id: string; path: string }>;
    expect(repos).toHaveLength(1);
    expect(repos[0].id).toBe(repoId);
  });

  test('POST /repos is idempotent per path (refcount, same id, 200)', async () => {
    const res = await postJson('/repos', { path: repoPath });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe(repoId);

    const repos = (await (await request('/repos')).json()) as unknown[];
    expect(repos).toHaveLength(1);
  });

  test('POST /repos rejects a non-repo path', async () => {
    const res = await postJson('/repos', { path: '/definitely/not/a/repo' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(false);
  });

  test('GET /repos/:id/status reflects modified and untracked files', async () => {
    const wire = await pollStatus(repoId, (w) => w.status !== null && w.hunkCounts !== null);
    expect(wire.status!.isRepo).toBe(true);
    expect(wire.status!.branch.current).toBe('main');

    const modified = wire.status!.files.find((f) => f.path === 'file.txt');
    expect(modified).toBeDefined();
    expect(modified!.status).toBe('modified');
    expect(modified!.staged).toBe(false);

    const untracked = wire.status!.files.find((f) => f.path === 'untracked.txt');
    expect(untracked).toBeDefined();
    expect(untracked!.status).toBe('untracked');

    expect(wire.hunkCounts!.unstaged['file.txt']).toBe(1);
  });

  test('status for an unknown repo id is 404', async () => {
    const res = await request('/repos/r999/status');
    expect(res.status).toBe(404);
  });

  test('GET /repos/:id/diff returns the tracked-file change', async () => {
    const res = await request(`/repos/${repoId}/diff?path=file.txt`);
    expect(res.status).toBe(200);
    const diff = (await res.json()) as { raw: string; lines: unknown[] };
    expect(diff.raw).toContain('+modified line');
    expect(diff.lines.length).toBeGreaterThan(0);
  });

  test('GET /repos/:id/diff handles untracked files', async () => {
    const res = await request(`/repos/${repoId}/diff?path=untracked.txt`);
    expect(res.status).toBe(200);
    const diff = (await res.json()) as { raw: string };
    expect(diff.raw).toContain('+hello untracked');
  });

  test('POST stage moves a file to staged; unstage reverses it', async () => {
    const stageRes = await postJson(`/repos/${repoId}/stage`, { path: 'file.txt' });
    expect(stageRes.status).toBe(200);
    expect(await stageRes.json()).toEqual({ success: true });

    await pollStatus(repoId, (w) =>
      (w.status?.files ?? []).some((f) => f.path === 'file.txt' && f.staged)
    );

    const unstageRes = await postJson(`/repos/${repoId}/unstage`, { path: 'file.txt' });
    expect(unstageRes.status).toBe(200);

    await pollStatus(repoId, (w) =>
      (w.status?.files ?? []).some((f) => f.path === 'file.txt' && !f.staged)
    );
  });

  test('staging a file that is not in status is 404', async () => {
    const res = await postJson(`/repos/${repoId}/stage`, { path: 'no-such-file.txt' });
    expect(res.status).toBe(404);
  });

  test('SSE: snapshot on connect, state-change from the real file watcher', async () => {
    const res = await request(`/repos/${repoId}/events`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');

    const sse = new SseReader(res.body!);
    try {
      const first = await sse.next(3000);
      expect(first.event).toBe('snapshot');
      const snapshot = JSON.parse(first.data) as WireStatus;
      expect(snapshot).toHaveProperty('status');
      expect(snapshot).toHaveProperty('hunkCounts');
      expect(JSON.parse(first.data)).not.toHaveProperty('diff');

      // Real watcher path: touch a new file, wait for a state-change
      // that includes it.
      writeFixtureFile(repoPath, 'sse-new.txt', 'sse change\n');
      const deadline = Date.now() + 15000;
      for (;;) {
        const evt = await sse.next(Math.max(1, deadline - Date.now()));
        if (evt.event !== 'state-change') continue;
        const state = JSON.parse(evt.data) as WireStatus;
        if ((state.status?.files ?? []).some((f) => f.path === 'sse-new.txt')) break;
      }
    } finally {
      await sse.close();
      fs.rmSync(path.join(repoPath, 'sse-new.txt'), { force: true });
    }
  }, 20000);

  test('DELETE /repos/:id refcounts down, then removes', async () => {
    // Opened twice above: first delete only decrements.
    const first = await request(`/repos/${repoId}`, { method: 'DELETE' });
    expect(first.status).toBe(200);
    let repos = (await (await request('/repos')).json()) as unknown[];
    expect(repos).toHaveLength(1);

    const second = await request(`/repos/${repoId}`, { method: 'DELETE' });
    expect(second.status).toBe(200);
    repos = (await (await request('/repos')).json()) as unknown[];
    expect(repos).toHaveLength(0);

    const gone = await request(`/repos/${repoId}/status`);
    expect(gone.status).toBe(404);

    const alreadyGone = await request(`/repos/${repoId}`, { method: 'DELETE' });
    expect(alreadyGone.status).toBe(404);
  });
});
