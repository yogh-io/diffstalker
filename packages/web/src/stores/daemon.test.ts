/**
 * useDaemonStore tests: daemon-scope SSE handling (snapshot, repo
 * opened/closed, follow-change), connection status, and the repo
 * open/close/active actions. Globals stubbed — no daemon.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useDaemonStore } from './daemon';
import { makeFakeFetch, FakeEventSource } from '../testing/fakes';
import type { FakeFetch, FetchCall, FakeResponse } from '../testing/fakes';

const FOLLOW_STATE = {
  targetFile: '/home/u/.cache/diffstalker/target',
  enabled: true,
  followedRepoId: null,
  followedPath: null,
};

let fake: FakeFetch;
let onRequest: ((call: FetchCall) => FakeResponse | undefined) | null;

function defaultRoutes(call: FetchCall): FakeResponse {
  if (call.method === 'GET' && call.url === '/repos') {
    return { body: [{ id: 'r1', path: '/repo', branch: 'main' }] };
  }
  if (call.method === 'DELETE' && call.url.startsWith('/repos/')) {
    return { body: null };
  }
  if (call.url === '/follow') {
    return { body: FOLLOW_STATE };
  }
  return { status: 404, body: { error: `no fake route: ${call.method} ${call.url}` } };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  setActivePinia(createPinia());
  onRequest = null;
  fake = makeFakeFetch((call) => onRequest?.(call) ?? defaultRoutes(call));
  vi.stubGlobal('fetch', fake.fn);
  FakeEventSource.reset();
  vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useDaemonStore', () => {
  test('connect subscribes /events; snapshot populates repos and pulls branches + follow', async () => {
    const store = useDaemonStore();
    expect(store.connection).toBe('connecting');
    store.connect();

    const source = FakeEventSource.latest();
    expect(source.url).toBe('/events');

    source.emit('snapshot', [{ id: 'r1', path: '/repo' }]);
    expect(store.connection).toBe('connected');
    expect(store.repos).toEqual([{ id: 'r1', path: '/repo', branch: null }]);

    await flush();
    // refreshRepos filled the branch; loadFollow landed.
    expect(store.repos).toEqual([{ id: 'r1', path: '/repo', branch: 'main' }]);
    expect(store.follow).toEqual(FOLLOW_STATE);
  });

  test('connect is idempotent: one EventSource across repeated calls', () => {
    const store = useDaemonStore();
    store.connect();
    store.connect();
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  test('repo-opened adds (no duplicates); repo-closed removes', async () => {
    const store = useDaemonStore();
    store.connect();
    const source = FakeEventSource.latest();
    source.emit('snapshot', [{ id: 'r1', path: '/repo' }]);
    await flush();

    source.emit('repo-opened', { id: 'r2', path: '/other' });
    source.emit('repo-opened', { id: 'r2', path: '/other' });
    expect(store.repos.map((r) => r.id)).toEqual(['r1', 'r2']);

    source.emit('repo-closed', { id: 'r1' });
    expect(store.repos.map((r) => r.id)).toEqual(['r2']);
  });

  test('follow-change records the event and updates the follow state', async () => {
    const store = useDaemonStore();
    store.connect();
    const source = FakeEventSource.latest();
    source.emit('snapshot', []);
    await flush(); // follow state loaded

    const event = { repoId: 'r2', path: '/other', rawContent: '/other/src/a.ts' };
    source.emit('follow-change', event);
    expect(store.lastFollowChange).toEqual(event);
    expect(store.follow).toMatchObject({ followedRepoId: 'r2', followedPath: '/other' });
  });

  test('SSE error flips to disconnected; the next snapshot restores connected and refetches', async () => {
    const store = useDaemonStore();
    store.connect();
    const source = FakeEventSource.latest();
    source.emit('snapshot', [{ id: 'r1', path: '/repo' }]);
    await flush();
    const listCalls = fake.callsTo('/repos').filter((c) => c.method === 'GET').length;

    source.fail();
    expect(store.connection).toBe('disconnected');

    // EventSource auto-reconnects; the daemon then sends a fresh snapshot.
    source.emit('snapshot', [{ id: 'r1', path: '/repo' }]);
    expect(store.connection).toBe('connected');
    await flush();
    const after = fake.callsTo('/repos').filter((c) => c.method === 'GET').length;
    expect(after).toBe(listCalls + 1);
  });

  test('trackActive records the repo, makes it active, clears error — and never POSTs', () => {
    const store = useDaemonStore();
    store.error = 'stale refusal';

    store.trackActive({ id: 'r2', path: '/other' });
    expect(store.repos.map((r) => r.id)).toEqual(['r2']);
    expect(store.activeRepoId).toBe('r2');
    expect(store.error).toBeNull();
    // repoStore.open owns the POST; the daemon store only tracks.
    expect(fake.calls).toHaveLength(0);

    // Tracking the same repo again adds no duplicate.
    store.trackActive({ id: 'r2', path: '/other' });
    expect(store.repos).toHaveLength(1);
  });

  test('closeRepo DELETEs, drops the repo, and clears an active pointer', async () => {
    const store = useDaemonStore();
    store.trackActive({ id: 'r2', path: '/other' });
    await store.closeRepo('r2');
    expect(fake.calls.some((c) => c.method === 'DELETE' && c.url === '/repos/r2')).toBe(true);
    expect(store.repos).toEqual([]);
    expect(store.activeRepoId).toBeNull();
  });

  test('toggleFollow flips the client-side gate', () => {
    const store = useDaemonStore();
    expect(store.followEnabled).toBe(true);
    expect(store.toggleFollow()).toBe(false);
    expect(store.followEnabled).toBe(false);
    expect(store.toggleFollow()).toBe(true);
  });

  test('disconnect closes the stream', () => {
    const store = useDaemonStore();
    store.connect();
    const source = FakeEventSource.latest();
    store.disconnect();
    expect(source.closed).toBe(true);

    // Events after disconnect are silenced by the transport guard.
    source.emit('snapshot', [{ id: 'r9', path: '/x' }]);
    expect(store.repos).toEqual([]);
  });
});
