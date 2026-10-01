/**
 * Browser DiffstalkerClient tests: URL/method/body shapes for the
 * read-only endpoint surface, wire decoding (ISO dates → Date,
 * hunkCounts staying plain objects), and the SSE subscription dispatch.
 * Globals stubbed. The client has no git-mutating methods — the web UI
 * is a viewer.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { DiffstalkerClient, blobUrl } from './client';
import { makeFakeFetch, FakeEventSource } from '../testing/fakes';
import type { FakeFetch } from '../testing/fakes';
import type { FetchCall } from '../testing/fakes';

let fake: FakeFetch;
let client: DiffstalkerClient;
let respond: (call: FetchCall) => { status?: number; body?: unknown };

beforeEach(() => {
  respond = () => ({ body: null });
  fake = makeFakeFetch((call) => respond(call));
  vi.stubGlobal('fetch', fake.fn);
  FakeEventSource.reset();
  vi.stubGlobal('EventSource', FakeEventSource);
  client = new DiffstalkerClient();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('daemon + repos', () => {
  test('health hits GET /health', async () => {
    respond = () => ({ body: { ok: true, ready: true } });
    await expect(client.health()).resolves.toEqual({ ok: true, ready: true });
    expect(fake.calls[0]).toMatchObject({ method: 'GET', url: '/health' });
  });

  test('openRepo posts the path to /repos', async () => {
    respond = () => ({ body: { id: 'r1', path: '/repo' } });
    await expect(client.openRepo('/repo')).resolves.toEqual({ id: 'r1', path: '/repo' });
    expect(fake.calls[0]).toMatchObject({
      method: 'POST',
      url: '/repos',
      body: { path: '/repo' },
    });
  });

  test('closeRepo sends DELETE /repos/:id with the id encoded', async () => {
    await client.closeRepo('id with spaces');
    expect(fake.calls[0]).toMatchObject({
      method: 'DELETE',
      url: '/repos/id%20with%20spaces',
    });
  });

  test('getFollow hits GET /follow', async () => {
    respond = () => ({
      body: { targetFile: '/t', enabled: true, followedRepoId: null, followedPath: null },
    });
    await client.getFollow();
    expect(fake.calls[0].url).toBe('/follow');
  });
});

describe('working tree', () => {
  test('diff without options queries the whole tree', async () => {
    respond = () => ({ body: { lines: [] } });
    await client.diff('r1');
    expect(fake.calls[0].url).toBe('/repos/r1/diff');
  });

  test('diff includes path and an explicit staged=false', async () => {
    respond = () => ({ body: { lines: [] } });
    await client.diff('r1', { path: 'src/a.ts', staged: false });
    expect(fake.calls[0].url).toBe('/repos/r1/diff?path=src%2Fa.ts&staged=false');
  });

  test('status returns hunkCounts as plain objects, untouched', async () => {
    respond = () => ({
      body: {
        status: { files: [], branch: { current: 'main', ahead: 0, behind: 0 }, isRepo: true },
        hunkCounts: { staged: { 'a.ts': 2 }, unstaged: { 'b.ts': 1 } },
        error: null,
        stashList: [],
        operationInProgress: null,
      },
    });
    const state = await client.status('r1');
    expect(state.hunkCounts).toEqual({ staged: { 'a.ts': 2 }, unstaged: { 'b.ts': 1 } });
    expect(state.hunkCounts!.staged instanceof Map).toBe(false);
  });
});

describe('history / compare decoding', () => {
  test('history revives ISO date strings to Date', async () => {
    respond = () => ({
      body: [{ hash: 'abc', message: 'm', author: 'a', date: '2026-07-01T12:00:00.000Z' }],
    });
    const commits = await client.history('r1', 50);
    expect(fake.calls[0].url).toBe('/repos/r1/history?count=50');
    expect(commits[0].date).toBeInstanceOf(Date);
    expect(commits[0].date.toISOString()).toBe('2026-07-01T12:00:00.000Z');
  });

  test('history without a count sends no query', async () => {
    respond = () => ({ body: [] });
    await client.history('r1');
    expect(fake.calls[0].url).toBe('/repos/r1/history');
  });

  test('commitDiff encodes the hash', async () => {
    respond = () => ({ body: { lines: [] } });
    await client.commitDiff('r1', 'abc/def');
    expect(fake.calls[0].url).toBe('/repos/r1/commits/abc%2Fdef/diff');
  });

  test('commitFiles encodes the hash', async () => {
    respond = () => ({ body: [] });
    await client.commitFiles('r1', 'abc/def');
    expect(fake.calls[0].url).toBe('/repos/r1/commits/abc%2Fdef/files');
  });

  test('compare revives commit dates and forwards query flags', async () => {
    respond = () => ({
      body: {
        baseBranch: 'origin/main',
        stats: { filesChanged: 1, additions: 2, deletions: 0 },
        files: [],
        commits: [{ hash: 'abc', message: 'm', author: 'a', date: '2026-07-02T00:00:00.000Z' }],
        uncommittedCount: 0,
      },
    });
    const diff = await client.compare('r1', { staged: true, unstaged: true, untracked: false });
    expect(fake.calls[0].url).toBe(
      '/repos/r1/compare?staged=true&unstaged=true&untracked=false'
    );
    expect(diff.commits[0].date).toBeInstanceOf(Date);
  });

  test('compareFileDiff names the row with uncommitted=, never side=', async () => {
    // `side` is a tree name on this API (/blob); a compare row's word is
    // the one it carries in `uncommitted` on the CompareDiff.
    respond = () => ({ body: { lines: [] } });
    await client.compareFileDiff('r1', { path: 'a.ts', uncommitted: 'both', whole: true });
    await client.compareFileDiff('r1', { path: 'a.ts', base: 'origin/main' });
    expect(fake.calls.map((c) => c.url)).toEqual([
      '/repos/r1/compare/file?path=a.ts&uncommitted=both&whole=true',
      '/repos/r1/compare/file?path=a.ts&base=origin%2Fmain',
    ]);
  });

  test('compare forwards a base pick as a query param — a GET, never a PUT', async () => {
    respond = () => ({
      body: {
        baseBranch: 'origin/dev',
        stats: { filesChanged: 0, additions: 0, deletions: 0 },
        files: [],
        commits: [],
        uncommittedCount: 0,
      },
    });
    await client.compare('r1', { base: 'origin/dev' });
    expect(fake.calls[0]).toMatchObject({
      method: 'GET',
      url: '/repos/r1/compare?base=origin%2Fdev',
    });
    expect(fake.calls.every((c) => c.method === 'GET')).toBe(true);
  });

  test('compareCount asks the count endpoint and passes the payload through', async () => {
    respond = () => ({ body: { baseBranch: 'origin/main', commits: 12 } });
    await expect(client.compareCount('r1')).resolves.toEqual({
      baseBranch: 'origin/main',
      commits: 12,
    });
    expect(fake.calls[0]).toMatchObject({ method: 'GET', url: '/repos/r1/compare/count' });
  });

  test('compareCount forwards the picked base, so it counts what compare would list', async () => {
    respond = () => ({ body: { baseBranch: 'origin/dev', commits: 4 } });
    await client.compareCount('r1', { base: 'origin/dev' });
    expect(fake.calls[0].url).toBe('/repos/r1/compare/count?base=origin%2Fdev');
  });

  test('a picked stack layer rides as head= on compare, count and file, after base', async () => {
    respond = (call) =>
      call.url.includes('/compare/file')
        ? { body: { lines: [] } }
        : {
            body: {
              baseBranch: 'feature/nginx',
              stats: { filesChanged: 0, additions: 0, deletions: 0 },
              files: [],
              commits: [],
              uncommittedCount: 0,
            },
          };
    await client.compare('r1', { base: 'feature/nginx', head: 'feature/nginx-image' });
    await client.compareCount('r1', { base: 'feature/nginx', head: 'feature/nginx-image' });
    await client.compareFileDiff('r1', {
      path: 'a.ts',
      base: 'feature/nginx',
      head: 'feature/nginx-image',
      whole: true,
    });
    expect(fake.calls.map((c) => c.url)).toEqual([
      '/repos/r1/compare?base=feature%2Fnginx&head=feature%2Fnginx-image',
      '/repos/r1/compare/count?base=feature%2Fnginx&head=feature%2Fnginx-image',
      '/repos/r1/compare/file?path=a.ts&base=feature%2Fnginx&head=feature%2Fnginx-image&whole=true',
    ]);
  });

  test('compareStack reads the stack for a trunk; absent means the detected one', async () => {
    const stack = { trunk: 'upstream/main', layers: [], forkedAbove: false };
    respond = () => ({ body: stack });
    await expect(client.compareStack('r1')).resolves.toEqual(stack);
    await client.compareStack('r1', { base: 'upstream/main' });
    expect(fake.calls.map((c) => [c.method, c.url])).toEqual([
      ['GET', '/repos/r1/compare/stack'],
      ['GET', '/repos/r1/compare/stack?base=upstream%2Fmain'],
    ]);
  });
});

describe('journal', () => {
  test('journal without since sends no query; the JSON-native payload is untouched', async () => {
    const body = {
      epoch: 'mcw2a1b4-9f3ac2d1',
      prunedBefore: 0,
      entries: [
        {
          type: 'hunk',
          seq: 7,
          ts: 1750000000000,
          path: 'file.txt',
          status: 'modified',
          kind: 'edited',
          span: { start: 1, count: 2 },
          stats: { insertions: 1, deletions: 0 },
          diff: { lines: [] },
          supersedes: [3],
          siblings: 1,
          seeded: false,
        },
      ],
    };
    respond = () => ({ body });
    const result = await client.journal('r1');
    expect(fake.calls[0]).toMatchObject({ method: 'GET', url: '/repos/r1/journal' });
    // JSON-native: the entries (embedded DiffResult included) cross the
    // wire as-is, like diff() — and epoch stays an opaque string.
    expect(result).toEqual(body);
    expect(typeof result.epoch).toBe('string');
  });

  test('journal forwards since when given — 0 included (a valid seq floor)', async () => {
    respond = () => ({ body: { epoch: 'e1', prunedBefore: 0, entries: [] } });
    await client.journal('r1', 42);
    await client.journal('r1', 0);
    expect(fake.calls.map((c) => c.url)).toEqual([
      '/repos/r1/journal?since=42',
      '/repos/r1/journal?since=0',
    ]);
  });
});

describe('explorer', () => {
  test('tree forwards dir/hidden/ignored', async () => {
    respond = () => ({ body: [] });
    await client.tree('r1', { dir: 'src', hidden: true, ignored: false });
    expect(fake.calls[0].url).toBe('/repos/r1/tree?dir=src&hidden=true&ignored=false');
  });

  test('file queries the path', async () => {
    respond = () => ({
      body: {
        content: '',
        binary: false,
        truncated: false,
        tooLarge: false,
        size: 0,
        totalLines: 0,
      },
    });
    await client.file('r1', 'src/a.ts');
    expect(fake.calls[0].url).toBe('/repos/r1/file?path=src%2Fa.ts');
  });
});

describe('media', () => {
  const emptyPair = { old: null, new: null };

  test('media asks /media with staged spelled true/false, like every boolean param', async () => {
    respond = () => ({ body: emptyPair });
    await client.media('r1', 'logo.png', false);
    await client.media('r1', 'logo.png', true);
    expect(fake.calls.map((c) => c.url)).toEqual([
      '/repos/r1/media?path=logo.png&staged=false',
      '/repos/r1/media?path=logo.png&staged=true',
    ]);
    expect(fake.calls.every((c) => c.method === 'GET')).toBe(true);
  });

  test('media encodes the id and the path', async () => {
    respond = () => ({ body: emptyPair });
    await client.media('id with spaces', 'img/a b&c.png', false);
    expect(fake.calls[0].url).toBe(
      '/repos/id%20with%20spaces/media?path=img%2Fa%20b%26c.png&staged=false'
    );
  });

  test('a pair of nulls is a normal answer, passed through untouched', async () => {
    respond = () => ({ body: emptyPair });
    await expect(client.media('r1', 'notes.txt', false)).resolves.toEqual(emptyPair);
  });

  test('blobUrl is re-exported here, so a component gets bytes and metadata from one module', () => {
    // Bytes are fetched by the browser from this URL as an <img src>, never
    // by the client: a fetch() to /blob is a 403 by design.
    expect(typeof blobUrl).toBe('function');
    expect(blobUrl('r1', { path: 'logo.png', side: 'worktree', version: '12-345' })).toBe(
      '/repos/r1/blob?path=logo.png&side=worktree&v=12-345'
    );
  });
});

describe('read-only surface', () => {
  test('the client exposes file-level stage/unstage but NO other git mutations', () => {
    // The near-viewer stance, asserted structurally: file-level
    // stage/unstage exist; every other mutation method does not.
    expect(typeof (client as unknown as Record<string, unknown>).stage).toBe('function');
    expect(typeof (client as unknown as Record<string, unknown>).unstage).toBe('function');
    const forbidden = [
      'stageAll',
      'unstageAll',
      'discard',
      'commit',
      'stageHunk',
      'unstageHunk',
      'push',
      'fetch',
      'pull',
      'stash',
      'stashPop',
      'switchBranch',
      'createBranch',
      'softReset',
      'cherryPick',
      'revert',
      'abort',
      'rebaseContinue',
      'setCompareBase',
    ];
    for (const name of forbidden) {
      expect((client as unknown as Record<string, unknown>)[name]).toBeUndefined();
    }
  });
});

describe('SSE subscription (one stream)', () => {
  function daemonHandlers() {
    return {
      onSnapshot: vi.fn(),
      onRepoOpened: vi.fn(),
      onRepoClosed: vi.fn(),
      onFollowChange: vi.fn(),
      onSettingsChange: vi.fn(),
      onDiscoveryChange: vi.fn(),
      onError: vi.fn(),
    };
  }

  function repoHandlers() {
    return {
      onSnapshot: vi.fn(),
      onStateChange: vi.fn(),
      onJournalAppend: vi.fn(),
      onMissing: vi.fn(),
      onError: vi.fn(),
    };
  }

  test('without a repo it opens /events and dispatches the daemon-scope events', () => {
    const handlers = daemonHandlers();
    client.subscribeEvents(handlers);

    const source = FakeEventSource.latest();
    expect(source.url).toBe('/events');
    source.emit('snapshot', [{ id: 'r1', path: '/repo' }]);
    source.emit('repo-opened', { id: 'r2', path: '/other' });
    source.emit('repo-closed', { id: 'r1' });
    source.emit('follow-change', { repoId: 'r2', path: '/other', rawContent: '/other/f.ts' });
    source.emit('settings-change', { watchRoots: ['/w'], persisted: true });
    source.emit('discovery-change', { roots: [] });
    expect(handlers.onSnapshot).toHaveBeenCalledWith([{ id: 'r1', path: '/repo' }]);
    expect(handlers.onRepoOpened).toHaveBeenCalledWith({ id: 'r2', path: '/other' });
    expect(handlers.onRepoClosed).toHaveBeenCalledWith({ id: 'r1' });
    expect(handlers.onFollowChange).toHaveBeenCalledWith({
      repoId: 'r2',
      path: '/other',
      rawContent: '/other/f.ts',
    });
    expect(handlers.onSettingsChange).toHaveBeenCalledWith({ watchRoots: ['/w'], persisted: true });
    expect(handlers.onDiscoveryChange).toHaveBeenCalledWith({ roots: [] });
  });

  test('with a repo it opens /events?repo=<id> (encoded) and routes the repo events', () => {
    const daemon = daemonHandlers();
    const repo = repoHandlers();
    client.subscribeEvents(daemon, { id: 'id with spaces', handlers: repo });

    const source = FakeEventSource.latest();
    expect(source.url).toBe('/events?repo=id%20with%20spaces');
    // Both halves on the same EventSource.
    source.emit('snapshot', [{ id: 'r1', path: '/repo' }]);
    source.emit('repo-snapshot', { status: null, error: null });
    source.emit('state-change', { status: null, error: 'x' });
    source.emit('journal-append', { epoch: 'e1', entries: [{ type: 'boundary', seq: 1 }] });
    source.emit('repo-missing', { id: 'id with spaces' });
    expect(daemon.onSnapshot).toHaveBeenCalledWith([{ id: 'r1', path: '/repo' }]);
    expect(repo.onSnapshot).toHaveBeenCalledWith({ status: null, error: null });
    expect(repo.onStateChange).toHaveBeenCalledWith({ status: null, error: 'x' });
    // journal-append routes to its own handler, never into state-change.
    expect(repo.onJournalAppend).toHaveBeenCalledWith({
      epoch: 'e1',
      entries: [{ type: 'boundary', seq: 1 }],
    });
    expect(repo.onStateChange).toHaveBeenCalledTimes(1);
    expect(repo.onMissing).toHaveBeenCalledWith({ id: 'id with spaces' });
    // The daemon snapshot (the repo list) never lands on the repo side.
    expect(repo.onSnapshot).toHaveBeenCalledTimes(1);
  });

  test('without a journal handler, journal-append is ignored', () => {
    const repo = { onSnapshot: vi.fn(), onStateChange: vi.fn(), onMissing: vi.fn() };
    client.subscribeEvents(daemonHandlers(), { id: 'r1', handlers: repo });

    FakeEventSource.latest().emit('journal-append', { epoch: 'e1', entries: [] });
    expect(repo.onStateChange).not.toHaveBeenCalled();
  });

  test('a stream error reaches both handler sets', () => {
    const daemon = daemonHandlers();
    const repo = repoHandlers();
    client.subscribeEvents(daemon, { id: 'r1', handlers: repo });

    FakeEventSource.latest().fail();
    expect(daemon.onError).toHaveBeenCalledTimes(1);
    expect(repo.onError).toHaveBeenCalledTimes(1);
  });

  test('the web client has no caller of the per-repo stream endpoint', () => {
    // /repos/:id/events still exists for the CLI; the web UI must not open
    // it, or every tab is back to two connections.
    expect((client as unknown as Record<string, unknown>).subscribeRepo).toBeUndefined();
    expect((client as unknown as Record<string, unknown>).subscribeDaemon).toBeUndefined();
  });
});
