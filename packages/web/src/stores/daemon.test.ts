/**
 * useDaemonStore tests: daemon-scope SSE handling (snapshot, repo
 * opened/closed, follow-change), connection status, the repo
 * open/close/active actions, the ownership of the tab's ONE stream
 * (attachRepo / detachRepo reopen it with or without `?repo=`), and the
 * hidden-tab pause (a hidden tab holds no stream). Globals stubbed — no
 * daemon.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import {
  useDaemonStore,
  FOLLOW_LOAD_ATTEMPTS,
  FOLLOW_RETRY_DELAY_MS,
  HIDDEN_CLOSE_DELAY_MS,
  VERSION_POLL_MS,
} from './daemon';
import { makeFakeFetch, FakeEventSource } from '../testing/fakes';
import type { FakeFetch, FetchCall, FakeResponse } from '../testing/fakes';

const FOLLOW_STATE = {
  targetFile: '/home/u/.cache/diffstalker/target',
  enabled: true,
  followedRepoId: null,
  followedPath: null,
};

const VERSION_STATE = {
  current: '0.8.1',
  latest: '0.9.0',
  status: 'outdated',
  install: { method: 'npm', package: 'diffstalkerd', command: 'npm install -g diffstalkerd' },
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
  if (call.url === '/version') {
    return { body: VERSION_STATE };
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
  // The store listens on the shared document for visibility changes and
  // may hold a paused stream; disconnect drops both, or a later test's
  // visibility change would wake this test's store.
  useDaemonStore().disconnect();
  vi.unstubAllGlobals();
  // A test that enables fake timers must not leave them on: flush() is a
  // real setTimeout and would hang in whatever runs next.
  vi.useRealTimers();
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
    // No followed target yet — nothing to seed.
    expect(store.lastFollowChange).toBeNull();
  });

  test('loadFollow seeds lastFollowChange from a pre-existing follow target', async () => {
    onRequest = (call) =>
      call.url === '/follow'
        ? { body: { ...FOLLOW_STATE, followedRepoId: 'r2', followedPath: '/other' } }
        : undefined;
    const store = useDaemonStore();

    await store.loadFollow();

    // The target was set before this page loaded (no live event), so
    // the synthesized event lets useFollowMode act on it.
    expect(store.follow).toMatchObject({ followedRepoId: 'r2', followedPath: '/other' });
    expect(store.lastFollowChange).toEqual({
      repoId: 'r2',
      path: '/other',
      rawContent: '/other',
    });
  });

  test('loadFollow never overwrites a real live follow-change event', async () => {
    onRequest = (call) =>
      call.url === '/follow'
        ? { body: { ...FOLLOW_STATE, followedRepoId: 'r2', followedPath: '/other' } }
        : undefined;
    const store = useDaemonStore();
    const live = { repoId: 'r9', path: '/live/src/a.ts', rawContent: '/live/src/a.ts' };
    store.lastFollowChange = live;

    await store.loadFollow();

    expect(store.lastFollowChange).toEqual(live);
  });

  test('loadFollow retries a transient /follow failure and still populates follow', async () => {
    vi.useFakeTimers();
    let followCalls = 0;
    onRequest = (call) => {
      if (call.url !== '/follow') return undefined;
      followCalls += 1;
      // Fail the first two attempts, then answer.
      return followCalls < FOLLOW_LOAD_ATTEMPTS
        ? { status: 503, body: { error: 'flaky' } }
        : { body: FOLLOW_STATE };
    };
    const store = useDaemonStore();

    const load = store.loadFollow();
    await vi.advanceTimersByTimeAsync(FOLLOW_RETRY_DELAY_MS * FOLLOW_LOAD_ATTEMPTS);
    await load;

    // Bounded retries closed the transient gap — no permanent null.
    expect(followCalls).toBe(FOLLOW_LOAD_ATTEMPTS);
    expect(store.follow).toEqual(FOLLOW_STATE);
    vi.useRealTimers();
  });

  test('overlapping loadFollow calls do not stack — one in-flight load owns the retry', async () => {
    vi.useFakeTimers();
    let followCalls = 0;
    onRequest = (call) => {
      if (call.url !== '/follow') return undefined;
      followCalls += 1;
      return { status: 503, body: { error: 'follow down' } };
    };
    const store = useDaemonStore();

    // Three overlapping snapshots would stack three retry loops without
    // the guard; only the first runs.
    const loads = Promise.all([store.loadFollow(), store.loadFollow(), store.loadFollow()]);
    await vi.advanceTimersByTimeAsync(FOLLOW_RETRY_DELAY_MS * FOLLOW_LOAD_ATTEMPTS);
    await loads;

    // Exactly one retry loop ran: FOLLOW_LOAD_ATTEMPTS GETs, not 3× that.
    expect(followCalls).toBe(FOLLOW_LOAD_ATTEMPTS);
    vi.useRealTimers();
  });

  test('a reconnect re-seeds lastFollowChange when the follow target changed', async () => {
    let target = { followedRepoId: 'r2', followedPath: '/other' };
    onRequest = (call) =>
      call.url === '/follow' ? { body: { ...FOLLOW_STATE, ...target } } : undefined;
    const store = useDaemonStore();

    // First (cold) load seeds the initial target.
    await store.loadFollow();
    expect(store.lastFollowChange).toEqual({ repoId: 'r2', path: '/other', rawContent: '/other' });

    // The daemon moved to a new target while the stream was dead; the
    // reconnect snapshot re-pulls /follow.
    target = { followedRepoId: 'r3', followedPath: '/third' };
    await store.loadFollow();

    expect(store.follow).toMatchObject({ followedRepoId: 'r3', followedPath: '/third' });
    expect(store.lastFollowChange).toEqual({ repoId: 'r3', path: '/third', rawContent: '/third' });
  });

  test('a reopen does not re-seed a target whose repo did not change, even with a stale root', async () => {
    let followState: Record<string, unknown> = FOLLOW_STATE;
    onRequest = (call) => (call.url === '/follow' ? { body: followState } : undefined);
    const store = useDaemonStore();
    store.connect();
    FakeEventSource.latest().emit('snapshot', []);
    await flush(); // cold load: no target

    // A live follow-change for a repo NOT in the open-repo list (its
    // repo-opened was missed): the handler records the id but keeps the
    // previous root, so follow.followedPath is stale (null here).
    const live = { repoId: 'r2', path: '/other/src/a.ts', rawContent: '/other/src/a.ts' };
    FakeEventSource.latest().emit('follow-change', live);
    expect(store.follow).toMatchObject({ followedRepoId: 'r2', followedPath: null });
    expect(store.lastFollowChange).toEqual(live);

    // The user picks another repo: the stream reopens, the snapshot
    // re-pulls /follow, which now reports r2 with its real root. Same
    // repo, so this must NOT count as a changed target — re-seeding here
    // is what made follow mode pull the user back to r2.
    followState = { ...FOLLOW_STATE, followedRepoId: 'r2', followedPath: '/other' };
    store.attachRepo('r1', {
      onSnapshot: vi.fn(),
      onStateChange: vi.fn(),
      onMissing: vi.fn(),
    });
    FakeEventSource.latest().emit('snapshot', [{ id: 'r1', path: '/repo' }]);
    await flush();

    expect(store.follow).toMatchObject({ followedRepoId: 'r2', followedPath: '/other' });
    // Still the live event (a re-seed would carry the root, '/other').
    expect(store.lastFollowChange).toEqual(live);
  });

  test('a reconnect with an unchanged target leaves a newer live event untouched', async () => {
    onRequest = (call) =>
      call.url === '/follow'
        ? { body: { ...FOLLOW_STATE, followedRepoId: 'r2', followedPath: '/other' } }
        : undefined;
    const store = useDaemonStore();

    // Cold load: follow.value and lastFollowChange both at r2/other.
    await store.loadFollow();

    // A newer live event advanced lastFollowChange past follow.value.
    const live = { repoId: 'r9', path: '/live', rawContent: '/live/src/a.ts' };
    store.lastFollowChange = live;

    // Reconnect: /follow still reports the OLD r2/other (target unchanged
    // since the cold load), so the newer live event must survive.
    await store.loadFollow();

    expect(store.lastFollowChange).toEqual(live);
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

  test('follow-change records the event and resolves followedPath to the repo root', async () => {
    const store = useDaemonStore();
    store.connect();
    const source = FakeEventSource.latest();
    source.emit('snapshot', []);
    await flush(); // follow state loaded

    // repo-opened lands before follow-change (the daemon's ordering).
    source.emit('repo-opened', { id: 'r2', path: '/other' });

    // The event's `path` is the hook file CONTENT — here a file inside r2.
    const event = { repoId: 'r2', path: '/other/src/a.ts', rawContent: '/other/src/a.ts' };
    source.emit('follow-change', event);

    expect(store.lastFollowChange).toEqual(event);
    // followedRepoId tracks the event; followedPath is the repo ROOT (from
    // the open-repo list) — NOT the hook file path — matching GET /follow.
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

  test('snapshot pulls the version state', async () => {
    const store = useDaemonStore();
    store.connect();
    FakeEventSource.latest().emit('snapshot', []);
    await flush();

    expect(store.version).toEqual(VERSION_STATE);
  });

  test('a connected tab keeps re-asking for the version on its own', async () => {
    // The bug this pins: loadVersion used to run ONLY on (re)connect, so a
    // tab left open on a second monitor — the intended use — never asked
    // again and the indicator froze at whatever was true when it opened.
    vi.useFakeTimers();
    const store = useDaemonStore();
    store.connect();
    FakeEventSource.latest().emit('snapshot', []);
    await vi.advanceTimersByTimeAsync(0);
    const afterConnect = fake.callsTo('/version').length;
    expect(afterConnect).toBe(1);

    await vi.advanceTimersByTimeAsync(VERSION_POLL_MS);
    expect(fake.callsTo('/version').length).toBe(2);
    await vi.advanceTimersByTimeAsync(VERSION_POLL_MS);
    expect(fake.callsTo('/version').length).toBe(3);

    // and it stops when the store is torn down, so nothing leaks
    store.disconnect();
    await vi.advanceTimersByTimeAsync(VERSION_POLL_MS * 3);
    expect(fake.callsTo('/version').length).toBe(3);
  });

  test('a daemon restarted on a new version marks the bundle stale', async () => {
    vi.useFakeTimers();
    const store = useDaemonStore();
    store.connect();
    FakeEventSource.latest().emit('snapshot', []);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.servedBy).toBe(VERSION_STATE.current);
    expect(store.daemonUpgraded).toBe(false);

    // The daemon comes back on a newer version than the one that served us.
    onRequest = (call) =>
      call.url === '/version'
        ? { status: 200, body: { current: '0.10.0', latest: '0.10.0', status: 'current' } }
        : undefined;
    await vi.advanceTimersByTimeAsync(VERSION_POLL_MS);

    expect(store.daemonUpgraded).toBe(true);
    // servedBy is what SERVED this page and must never move, or the check
    // silently stops firing.
    expect(store.servedBy).toBe(VERSION_STATE.current);
  });

  test('a failing /version leaves the last known state and never touches the connection', async () => {
    const store = useDaemonStore();
    store.connect();
    FakeEventSource.latest().emit('snapshot', []);
    await flush();

    onRequest = (call) =>
      call.url === '/version' ? { status: 500, body: { error: 'boom' } } : undefined;
    await store.loadVersion();

    expect(store.version).toEqual(VERSION_STATE);
    expect(store.connection).toBe('connected');
  });

  test('trackActive records the repo, makes it active, clears error — and never POSTs', () => {
    const store = useDaemonStore();
    store.error = 'stale refusal';

    store.trackActive({ id: 'r2', path: '/other' });
    expect(store.repos.map((r) => r.id)).toEqual(['r2']);
    expect(store.activeRepoId).toBe('r2');
    expect(store.error).toBeNull();
    // repoStore.open owns the POST; the daemon store only tracks (it does
    // GET the active repo's worktrees, but it never POSTs).
    expect(fake.calls.some((c) => c.method === 'POST')).toBe(false);

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

describe('the one stream: attachRepo / detachRepo', () => {
  function repoHandlers() {
    return {
      onSnapshot: vi.fn(),
      onStateChange: vi.fn(),
      onJournalAppend: vi.fn(),
      onMissing: vi.fn(),
      onError: vi.fn(),
    };
  }

  /** The streams still open: there must only ever be one. */
  function live(): FakeEventSource[] {
    return FakeEventSource.instances.filter((s) => !s.closed);
  }

  test('attachRepo reopens the ONE stream with ?repo= and routes the repo events', () => {
    const store = useDaemonStore();
    store.connect();
    const plain = FakeEventSource.latest();

    const handlers = repoHandlers();
    store.attachRepo('r1', handlers);

    expect(plain.closed).toBe(true);
    expect(live().map((s) => s.url)).toEqual(['/events?repo=r1']);
    const source = FakeEventSource.latest();
    source.emit('snapshot', [{ id: 'r1', path: '/repo' }]);
    source.emit('repo-snapshot', { status: null, error: null });
    source.emit('state-change', { status: null, error: 'x' });
    source.emit('repo-missing', { id: 'r1' });
    expect(store.repos).toEqual([{ id: 'r1', path: '/repo', branch: null }]);
    expect(handlers.onSnapshot).toHaveBeenCalledWith({ status: null, error: null });
    expect(handlers.onStateChange).toHaveBeenCalledWith({ status: null, error: 'x' });
    expect(handlers.onMissing).toHaveBeenCalledWith({ id: 'r1' });
  });

  test('attachRepo without a prior connect opens the stream; connect then stays idempotent', () => {
    const store = useDaemonStore();
    store.attachRepo('r1', repoHandlers());
    store.connect();
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(live().map((s) => s.url)).toEqual(['/events?repo=r1']);
  });

  test('switching the attached repo reopens with the new id and drops the old stream', () => {
    const store = useDaemonStore();
    store.connect();
    const first = repoHandlers();
    store.attachRepo('r1', first);
    const oldSource = FakeEventSource.latest();

    const second = repoHandlers();
    store.attachRepo('r2', second);

    expect(live().map((s) => s.url)).toEqual(['/events?repo=r2']);
    // A late event on the old stream reaches nobody — not the old
    // handlers, and certainly not the new repo's.
    oldSource.emit('state-change', { status: null, error: 'late' });
    expect(first.onStateChange).not.toHaveBeenCalled();
    expect(second.onStateChange).not.toHaveBeenCalled();
    FakeEventSource.latest().emit('state-change', { status: null, error: null });
    expect(second.onStateChange).toHaveBeenCalledTimes(1);
    expect(first.onStateChange).not.toHaveBeenCalled();
  });

  test('an intentional reopen never flips the connection to disconnected', () => {
    const store = useDaemonStore();
    store.connect();
    FakeEventSource.latest().emit('snapshot', []);
    expect(store.connection).toBe('connected');

    store.attachRepo('r1', repoHandlers());
    expect(store.connection).toBe('connected');
    store.detachRepo();
    expect(store.connection).toBe('connected');
    // Even an error on a handle that was closed by the reopen is dropped.
    for (const closed of FakeEventSource.instances.filter((s) => s.closed)) closed.fail();
    expect(store.connection).toBe('connected');
  });

  test('a stream error flips to disconnected AND reaches the attached repo handlers', () => {
    const store = useDaemonStore();
    store.connect();
    FakeEventSource.latest().emit('snapshot', []);
    const handlers = repoHandlers();
    store.attachRepo('r1', handlers);

    FakeEventSource.latest().fail();
    expect(store.connection).toBe('disconnected');
    expect(handlers.onError).toHaveBeenCalledTimes(1);
  });

  test('detachRepo reopens without a repo; a no-op when nothing is attached', () => {
    const store = useDaemonStore();
    store.connect();
    const before = FakeEventSource.instances.length;
    store.detachRepo(); // nothing attached: no reopen
    expect(FakeEventSource.instances).toHaveLength(before);

    const handlers = repoHandlers();
    store.attachRepo('r1', handlers);
    const attached = FakeEventSource.latest();
    store.detachRepo();
    expect(attached.closed).toBe(true);
    expect(live().map((s) => s.url)).toEqual(['/events']);
    // The detached handlers are gone with the stream.
    attached.emit('repo-snapshot', { status: null, error: null });
    expect(handlers.onSnapshot).not.toHaveBeenCalled();
  });

  test('detachRepo while disconnected only drops the attachment; connect reopens plain', () => {
    const store = useDaemonStore();
    store.attachRepo('r1', repoHandlers());
    store.disconnect();
    const before = FakeEventSource.instances.length;
    store.detachRepo();
    expect(FakeEventSource.instances).toHaveLength(before); // no stream to reopen

    store.connect();
    expect(live().map((s) => s.url)).toEqual(['/events']);
  });

  test('disconnect keeps the attachment: connect reopens with the repo', () => {
    const store = useDaemonStore();
    store.attachRepo('r1', repoHandlers());
    store.disconnect();
    expect(live()).toHaveLength(0);

    store.connect();
    expect(live().map((s) => s.url)).toEqual(['/events?repo=r1']);
  });
});

describe('a hidden tab holds no stream', () => {
  function repoHandlers() {
    return {
      onSnapshot: vi.fn(),
      onStateChange: vi.fn(),
      onJournalAppend: vi.fn(),
      onMissing: vi.fn(),
      onError: vi.fn(),
      onResume: vi.fn(),
    };
  }

  function live(): FakeEventSource[] {
    return FakeEventSource.instances.filter((s) => !s.closed);
  }

  /** Make the tab hidden or visible and tell the page, the way a browser does. */
  function setVisibility(state: 'hidden' | 'visible'): void {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
    document.dispatchEvent(new Event('visibilitychange'));
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    // Drop the instance override so the document is visible again.
    Reflect.deleteProperty(document, 'visibilityState');
  });

  /** A connected tab with a repo attached; returns the attached stream. */
  function attachedTab(handlers = repoHandlers()): {
    store: ReturnType<typeof useDaemonStore>;
    source: FakeEventSource;
    handlers: ReturnType<typeof repoHandlers>;
  } {
    const store = useDaemonStore();
    store.connect();
    FakeEventSource.latest().emit('snapshot', [{ id: 'r1', path: '/repo' }]);
    store.attachRepo('r1', handlers);
    const source = FakeEventSource.latest();
    source.emit('snapshot', [{ id: 'r1', path: '/repo' }]);
    return { store, source, handlers };
  }

  test('hidden: the stream closes after the delay, and it is not a connection loss', () => {
    const { store, source, handlers } = attachedTab();
    expect(store.connection).toBe('connected');

    setVisibility('hidden');
    vi.advanceTimersByTime(HIDDEN_CLOSE_DELAY_MS - 1);
    expect(source.closed).toBe(false);

    vi.advanceTimersByTime(1);
    expect(source.closed).toBe(true);
    expect(live()).toHaveLength(0);
    // Intentional: the status bar keeps saying connected, and the repo
    // store is not sent into its recovery loop.
    expect(store.connection).toBe('connected');
    expect(handlers.onError).not.toHaveBeenCalled();
  });

  test('shown again within the delay: nothing closes, nothing reopens', () => {
    const { source } = attachedTab();
    const count = FakeEventSource.instances.length;

    setVisibility('hidden');
    vi.advanceTimersByTime(HIDDEN_CLOSE_DELAY_MS / 2);
    setVisibility('visible');
    vi.advanceTimersByTime(HIDDEN_CLOSE_DELAY_MS * 2);

    expect(source.closed).toBe(false);
    expect(FakeEventSource.instances).toHaveLength(count);
  });

  test('shown after the close: one new stream with the repo, told to resume once its snapshot is in', () => {
    const { store, handlers } = attachedTab();
    setVisibility('hidden');
    vi.advanceTimersByTime(HIDDEN_CLOSE_DELAY_MS);
    const count = FakeEventSource.instances.length;

    setVisibility('visible');

    expect(FakeEventSource.instances).toHaveLength(count + 1);
    expect(live().map((s) => s.url)).toEqual(['/events?repo=r1']);
    expect(store.connection).toBe('connected');
    // Not yet. The daemon subscribes the new stream before it writes
    // repo-snapshot, so a refetch fired at reopen races that subscribe:
    // an append landing in between is in neither the fetch nor the
    // stream, and the journal keeps a hole. The resume waits for the
    // snapshot, from which point the stream is live.
    expect(handlers.onResume).not.toHaveBeenCalled();
    const source = FakeEventSource.latest();
    source.emit('snapshot', [{ id: 'r1', path: '/repo' }]);
    expect(handlers.onResume).not.toHaveBeenCalled();
    source.emit('repo-snapshot', { status: null, error: null });
    expect(handlers.onSnapshot).toHaveBeenCalledWith({ status: null, error: null });
    expect(handlers.onResume).toHaveBeenCalledTimes(1);
    // The snapshot is applied first, then the resume.
    expect(handlers.onSnapshot.mock.invocationCallOrder[0]).toBeLessThan(
      handlers.onResume.mock.invocationCallOrder[0]
    );
    // Once per reopen: a later snapshot on the same stream, and a second
    // show without a pause in between, resume nothing more.
    source.emit('repo-snapshot', { status: null, error: null });
    setVisibility('visible');
    expect(FakeEventSource.instances).toHaveLength(count + 1);
    expect(handlers.onResume).toHaveBeenCalledTimes(1);
  });

  test('a repo attached after the show but before the snapshot is not told to resume', () => {
    const { store, handlers: first } = attachedTab();
    setVisibility('hidden');
    vi.advanceTimersByTime(HIDDEN_CLOSE_DELAY_MS);
    setVisibility('visible');

    // The user switches repos before the reopened stream delivered its
    // snapshot: the new repo was never paused, and the old one's stream
    // is gone with its handlers.
    const second = repoHandlers();
    store.attachRepo('r2', second);
    FakeEventSource.latest().emit('repo-snapshot', { status: null, error: null });
    expect(second.onSnapshot).toHaveBeenCalledTimes(1);
    expect(second.onResume).not.toHaveBeenCalled();
    expect(first.onResume).not.toHaveBeenCalled();
  });

  test('attachRepo while paused opens nothing; the reopen on show carries the latest attachment', () => {
    const { store, handlers: first } = attachedTab();
    setVisibility('hidden');
    vi.advanceTimersByTime(HIDDEN_CLOSE_DELAY_MS);
    const count = FakeEventSource.instances.length;

    // The repo store's recovery path (recover -> connect -> attachRepo)
    // and a repo switch both land here; neither may open a stream.
    const second = repoHandlers();
    store.attachRepo('r2', second);
    const third = repoHandlers();
    store.attachRepo('r3', third);
    expect(FakeEventSource.instances).toHaveLength(count);
    expect(live()).toHaveLength(0);

    setVisibility('visible');
    expect(live().map((s) => s.url)).toEqual(['/events?repo=r3']);
    FakeEventSource.latest().emit('repo-snapshot', { status: null, error: null });
    expect(third.onSnapshot).toHaveBeenCalledTimes(1);
    expect(second.onSnapshot).not.toHaveBeenCalled();
    expect(third.onResume).toHaveBeenCalledTimes(1);
    expect(second.onResume).not.toHaveBeenCalled();
    expect(first.onResume).not.toHaveBeenCalled();
  });

  test('attachRepo while hidden but still within the delay closes the stream at once', () => {
    const { source } = attachedTab();
    setVisibility('hidden');
    vi.advanceTimersByTime(HIDDEN_CLOSE_DELAY_MS / 2);

    useDaemonStore().attachRepo('r2', repoHandlers());

    // No stream ever exists in a hidden tab: the replacement is not
    // opened, and the pending close has nothing left to do.
    expect(source.closed).toBe(true);
    expect(live()).toHaveLength(0);
    vi.advanceTimersByTime(HIDDEN_CLOSE_DELAY_MS);
    expect(live()).toHaveLength(0);

    setVisibility('visible');
    expect(live().map((s) => s.url)).toEqual(['/events?repo=r2']);
  });

  test('a tab that loads hidden opens nothing until it is shown', () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    const store = useDaemonStore();

    store.connect();
    store.connect();
    expect(FakeEventSource.instances).toHaveLength(0);
    expect(store.connection).toBe('connecting');

    // A URL restore opens its repo over REST and attaches it meanwhile.
    const handlers = repoHandlers();
    store.attachRepo('r1', handlers);
    expect(FakeEventSource.instances).toHaveLength(0);

    setVisibility('visible');
    expect(live().map((s) => s.url)).toEqual(['/events?repo=r1']);
    // Nothing was ever received, so there is nothing to resume from; the
    // repo is still told once its snapshot is in, which is harmless.
    FakeEventSource.latest().emit('repo-snapshot', { status: null, error: null });
    expect(handlers.onResume).toHaveBeenCalledTimes(1);
  });

  test('detachRepo while paused only drops the attachment; the reopen on show is plain', () => {
    const { store } = attachedTab();
    setVisibility('hidden');
    vi.advanceTimersByTime(HIDDEN_CLOSE_DELAY_MS);
    const count = FakeEventSource.instances.length;

    store.detachRepo();
    expect(FakeEventSource.instances).toHaveLength(count);

    setVisibility('visible');
    expect(live().map((s) => s.url)).toEqual(['/events']);
  });

  test('disconnect while paused: showing the tab reopens nothing', () => {
    const { store } = attachedTab();
    setVisibility('hidden');
    vi.advanceTimersByTime(HIDDEN_CLOSE_DELAY_MS);
    store.disconnect();
    const count = FakeEventSource.instances.length;

    setVisibility('visible');
    expect(FakeEventSource.instances).toHaveLength(count);

    // connect() after that is a normal open again, with the attachment.
    store.connect();
    expect(live().map((s) => s.url)).toEqual(['/events?repo=r1']);
  });
});
