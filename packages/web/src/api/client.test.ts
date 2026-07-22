/**
 * Browser DiffstalkerClient tests: URL/method/body shapes for the
 * read-only endpoint surface, wire decoding (ISO dates → Date,
 * hunkCounts staying plain objects), and the SSE subscription dispatch.
 * Globals stubbed. The client has no git-mutating methods — the web UI
 * is a viewer.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { DiffstalkerClient } from './client';
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
    respond = () => ({ body: { raw: '', lines: [] } });
    await client.diff('r1');
    expect(fake.calls[0].url).toBe('/repos/r1/diff');
  });

  test('diff includes path and an explicit staged=false', async () => {
    respond = () => ({ body: { raw: '', lines: [] } });
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
    respond = () => ({ body: { raw: '', lines: [] } });
    await client.commitDiff('r1', 'abc/def');
    expect(fake.calls[0].url).toBe('/repos/r1/commits/abc%2Fdef/diff');
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
    const diff = await client.compare('r1', { uncommitted: true });
    expect(fake.calls[0].url).toBe('/repos/r1/compare?uncommitted=true');
    expect(diff.commits[0].date).toBeInstanceOf(Date);
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
    await client.compare('r1', { base: 'origin/dev', uncommitted: false });
    expect(fake.calls[0]).toMatchObject({
      method: 'GET',
      url: '/repos/r1/compare?base=origin%2Fdev&uncommitted=false',
    });
    expect(fake.calls.every((c) => c.method === 'GET')).toBe(true);
  });

  test('getCompareBase unwraps {base} (read of the effective base)', async () => {
    respond = () => ({ body: { base: 'origin/main' } });
    await expect(client.getCompareBase('r1')).resolves.toBe('origin/main');
    expect(fake.calls[0]).toMatchObject({ method: 'GET', url: '/repos/r1/compare/base' });
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
          diff: { raw: '@@ -1,2 +1,3 @@\n+added', lines: [] },
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

describe('read-only surface', () => {
  test('the client exposes NO git-mutating methods', () => {
    // The viewer stance, asserted structurally: none of the removed
    // mutation methods exist on the client anymore.
    const forbidden = [
      'stage',
      'unstage',
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

describe('SSE subscriptions', () => {
  test('subscribeRepo dispatches snapshot, state-change, and journal-append', () => {
    const onSnapshot = vi.fn();
    const onStateChange = vi.fn();
    const onJournalAppend = vi.fn();
    client.subscribeRepo('r1', { onSnapshot, onStateChange, onJournalAppend });

    const source = FakeEventSource.latest();
    expect(source.url).toBe('/repos/r1/events');
    source.emit('snapshot', { status: null, error: null });
    source.emit('state-change', { status: null, error: 'x' });
    source.emit('journal-append', { entries: [{ type: 'boundary', seq: 1 }] });
    expect(onSnapshot).toHaveBeenCalledWith({ status: null, error: null });
    expect(onStateChange).toHaveBeenCalledWith({ status: null, error: 'x' });
    // journal-append routes to its own handler, never into state-change.
    expect(onJournalAppend).toHaveBeenCalledWith({ entries: [{ type: 'boundary', seq: 1 }] });
    expect(onStateChange).toHaveBeenCalledTimes(1);
  });

  test('subscribeRepo without a journal handler ignores journal-append', () => {
    const onSnapshot = vi.fn();
    const onStateChange = vi.fn();
    client.subscribeRepo('r1', { onSnapshot, onStateChange });

    const source = FakeEventSource.latest();
    source.emit('journal-append', { entries: [] });
    expect(onStateChange).not.toHaveBeenCalled();
  });

  test('subscribeDaemon dispatches all four daemon-scope events', () => {
    const onSnapshot = vi.fn();
    const onRepoOpened = vi.fn();
    const onRepoClosed = vi.fn();
    const onFollowChange = vi.fn();
    client.subscribeDaemon({ onSnapshot, onRepoOpened, onRepoClosed, onFollowChange });

    const source = FakeEventSource.latest();
    expect(source.url).toBe('/events');
    source.emit('snapshot', [{ id: 'r1', path: '/repo' }]);
    source.emit('repo-opened', { id: 'r2', path: '/other' });
    source.emit('repo-closed', { id: 'r1' });
    source.emit('follow-change', { repoId: 'r2', path: '/other', rawContent: '/other/f.ts' });
    expect(onSnapshot).toHaveBeenCalledWith([{ id: 'r1', path: '/repo' }]);
    expect(onRepoOpened).toHaveBeenCalledWith({ id: 'r2', path: '/other' });
    expect(onRepoClosed).toHaveBeenCalledWith({ id: 'r1' });
    expect(onFollowChange).toHaveBeenCalledWith({
      repoId: 'r2',
      path: '/other',
      rawContent: '/other/f.ts',
    });
  });
});
