/**
 * Browser DiffstalkerClient tests: URL/method/body shapes for the full
 * endpoint surface, wire decoding (ISO dates → Date, hunkCounts staying
 * plain objects), and the SSE subscription dispatch. Globals stubbed.
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

  test('stage/unstage post the file path', async () => {
    respond = () => ({ body: { state: {} } });
    await client.stage('r1', 'a.ts');
    await client.unstage('r1', 'a.ts');
    expect(fake.calls[0]).toMatchObject({ url: '/repos/r1/stage', body: { path: 'a.ts' } });
    expect(fake.calls[1]).toMatchObject({ url: '/repos/r1/unstage', body: { path: 'a.ts' } });
  });

  test('commit omits amend unless given, includes it when set', async () => {
    respond = () => ({ body: { state: {} } });
    await client.commit('r1', 'msg');
    await client.commit('r1', 'msg', { amend: true });
    expect(fake.calls[0].body).toEqual({ message: 'msg' });
    expect(fake.calls[1].body).toEqual({ message: 'msg', amend: true });
  });

  test('stageHunk/unstageHunk post the patch', async () => {
    respond = () => ({ body: { state: {} } });
    await client.stageHunk('r1', 'PATCH');
    await client.unstageHunk('r1', 'PATCH');
    expect(fake.calls[0]).toMatchObject({ url: '/repos/r1/stage-hunk', body: { patch: 'PATCH' } });
    expect(fake.calls[1]).toMatchObject({
      url: '/repos/r1/unstage-hunk',
      body: { patch: 'PATCH' },
    });
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

  test('headMessage unwraps {message}', async () => {
    respond = () => ({ body: { message: 'last commit' } });
    await expect(client.headMessage('r1')).resolves.toBe('last commit');
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

  test('getCompareBase/setCompareBase unwrap {base}', async () => {
    respond = () => ({ body: { base: 'origin/main' } });
    await expect(client.getCompareBase('r1')).resolves.toBe('origin/main');
    await expect(client.setCompareBase('r1', 'origin/dev')).resolves.toBe('origin/main');
    expect(fake.calls[1]).toMatchObject({
      method: 'PUT',
      url: '/repos/r1/compare/base',
      body: { branch: 'origin/dev' },
    });
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

describe('remote / branch / undo bodies', () => {
  test('stash omits an empty body message; stashPop sends the index', async () => {
    respond = () => ({ body: { state: {} } });
    await client.stash('r1');
    await client.stash('r1', 'wip');
    await client.stashPop('r1', 2);
    await client.stashPop('r1');
    expect(fake.calls[0].body).toEqual({});
    expect(fake.calls[1].body).toEqual({ message: 'wip' });
    expect(fake.calls[2].body).toEqual({ index: 2 });
    expect(fake.calls[3].body).toEqual({});
  });

  test('branch, reset, cherry-pick, revert, abort, rebase-continue endpoints', async () => {
    respond = () => ({ body: { state: {} } });
    await client.switchBranch('r1', 'main');
    await client.createBranch('r1', 'feat');
    await client.softReset('r1', 2);
    await client.cherryPick('r1', 'abc');
    await client.revert('r1', 'abc');
    await client.abort('r1');
    await client.rebaseContinue('r1');
    expect(fake.calls.map((c) => c.url)).toEqual([
      '/repos/r1/switch-branch',
      '/repos/r1/create-branch',
      '/repos/r1/soft-reset',
      '/repos/r1/cherry-pick',
      '/repos/r1/revert',
      '/repos/r1/abort',
      '/repos/r1/rebase-continue',
    ]);
    expect(fake.calls[0].body).toEqual({ name: 'main' });
    expect(fake.calls[2].body).toEqual({ count: 2 });
    expect(fake.calls[3].body).toEqual({ hash: 'abc' });
  });

  test('push/fetch/pull are bodyless POSTs', async () => {
    respond = () => ({ body: { state: {}, result: 'Pushed' } });
    const envelope = await client.push('r1');
    await client.fetch('r1');
    await client.pull('r1');
    expect(envelope.result).toBe('Pushed');
    expect(fake.calls.map((c) => [c.method, c.url, c.body])).toEqual([
      ['POST', '/repos/r1/push', undefined],
      ['POST', '/repos/r1/fetch', undefined],
      ['POST', '/repos/r1/pull', undefined],
    ]);
  });
});

describe('SSE subscriptions', () => {
  test('subscribeRepo dispatches snapshot and state-change', () => {
    const onSnapshot = vi.fn();
    const onStateChange = vi.fn();
    client.subscribeRepo('r1', { onSnapshot, onStateChange });

    const source = FakeEventSource.latest();
    expect(source.url).toBe('/repos/r1/events');
    source.emit('snapshot', { status: null, error: null });
    source.emit('state-change', { status: null, error: 'x' });
    expect(onSnapshot).toHaveBeenCalledWith({ status: null, error: null });
    expect(onStateChange).toHaveBeenCalledWith({ status: null, error: 'x' });
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
