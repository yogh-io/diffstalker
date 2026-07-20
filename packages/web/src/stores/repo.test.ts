/**
 * useRepoStore tests: the RepoSession port. Covers the applyWireState
 * sink + cascade, selection re-anchoring, the 20ms leading+trailing diff
 * debounce, the identity stale-guard, mutation envelope application,
 * wire decoding, compare-422, remote-op synthesis, and the single-flight
 * reconnect loop. Driven entirely by a stubbed fetch + FakeEventSource —
 * no daemon, fake timers throughout.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useRepoStore, CONNECTION_LOST_MESSAGE } from './repo';
import { makeFakeFetch, FakeEventSource, Deferred } from '../testing/fakes';
import type { FakeFetch, FetchCall, FakeResponse } from '../testing/fakes';
import type { WireSharedState } from '@diffstalker/client';
import type { FileEntry, FileStatus } from '@diffstalker/core/git/status';

// --- Fixtures ---

function fileEntry(path: string, overrides: Partial<FileEntry> = {}): FileEntry {
  return { path, status: 'modified' as FileStatus, staged: false, ...overrides };
}

function wireState(
  files: FileEntry[] = [],
  overrides: Partial<WireSharedState> = {}
): WireSharedState {
  return {
    status: { files, branch: { current: 'main', ahead: 0, behind: 0 }, isRepo: true },
    hunkCounts: { staged: {}, unstaged: {} },
    error: null,
    stashList: [],
    operationInProgress: null,
    ...overrides,
  };
}

function compareBody(): unknown {
  return {
    baseBranch: 'origin/main',
    stats: { filesChanged: 1, additions: 2, deletions: 0 },
    files: [
      {
        path: 'a.ts',
        status: 'modified',
        additions: 2,
        deletions: 0,
        diff: { raw: 'compare-file-diff', lines: [] },
      },
    ],
    commits: [{ hash: 'c1', message: 'm', author: 'a', date: '2026-07-01T00:00:00.000Z' }],
    uncommittedCount: 0,
  };
}

// --- Fake daemon over stubbed fetch ---

let fake: FakeFetch;
let onRequest: ((call: FetchCall) => FakeResponse | Promise<FakeResponse> | undefined) | null;

function defaultGetRoutes(url: string): FakeResponse | undefined {
  if (url === '/repos/r1/status') {
    return { body: wireState() };
  }
  if (url.startsWith('/repos/r1/diff')) {
    // Distinguishable per-query payload for stale-guard assertions.
    return { body: { raw: `diff:${url}`, lines: [] } };
  }
  if (url.startsWith('/repos/r1/history')) {
    return { body: [{ hash: 'h1', message: 'm', author: 'a', date: '2026-07-01T00:00:00.000Z' }] };
  }
  if (url.startsWith('/repos/r1/commits/')) {
    return { body: { raw: `commit-diff:${url}`, lines: [] } };
  }
  if (url.startsWith('/repos/r1/compare')) {
    return { body: compareBody() };
  }
  if (url === '/repos/r1/head-message') {
    return { body: { message: 'HEAD msg' } };
  }
  return undefined;
}

function defaultPostRoutes(call: FetchCall): FakeResponse | undefined {
  if (call.url === '/repos') {
    return { body: { id: 'r1', path: (call.body as { path: string }).path } };
  }
  if (call.url.startsWith('/repos/r1/')) {
    return { body: { state: wireState() } };
  }
  return undefined;
}

function defaultRoutes(call: FetchCall): FakeResponse {
  if (call.method === 'DELETE' && call.url.startsWith('/repos/')) {
    return { body: null };
  }
  const matched = call.method === 'GET' ? defaultGetRoutes(call.url) : defaultPostRoutes(call);
  return matched ?? { status: 404, body: { error: `no fake route: ${call.method} ${call.url}` } };
}

/** Flush microtasks under fake timers without advancing the clock. */
async function flush(): Promise<void> {
  for (let i = 0; i < 25; i++) {
    await Promise.resolve();
  }
}

/** Advance the fake clock, then settle the promise chains it released. */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await flush();
}

async function openStore(files: FileEntry[] = []) {
  const store = useRepoStore();
  await store.open('/repo');
  const source = FakeEventSource.latest();
  source.emit('snapshot', wireState(files));
  await flush();
  return { store, source };
}

function diffCalls(): string[] {
  return fake.callsTo('/repos/r1/diff').map((c) => c.url);
}

beforeEach(() => {
  setActivePinia(createPinia());
  onRequest = null;
  fake = makeFakeFetch((call) => onRequest?.(call) ?? defaultRoutes(call));
  vi.stubGlobal('fetch', fake.fn);
  FakeEventSource.reset();
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// --- Lifecycle + applyWireState ---

describe('open + applyWireState', () => {
  test('open subscribes the repo stream; the snapshot rebuilds shared state', async () => {
    const file = fileEntry('a.ts');
    const { store, source } = await openStore([file]);

    expect(store.repoId).toBe('r1');
    expect(store.isRepo).toBe(true);
    expect(source.url).toBe('/repos/r1/events');
    expect(store.shared.isLoading).toBe(false);
    expect(store.shared.status!.files).toEqual([file]);
    expect(store.shared.error).toBeNull();
  });

  test('hunkCounts stay plain objects on the wire shape', async () => {
    const { store, source } = await openStore();
    source.emit(
      'state-change',
      wireState([], { hunkCounts: { staged: { 'a.ts': 2 }, unstaged: { 'b.ts': 1 } } })
    );
    expect(store.shared.hunkCounts).toEqual({ staged: { 'a.ts': 2 }, unstaged: { 'b.ts': 1 } });
    expect(store.shared.hunkCounts!.staged instanceof Map).toBe(false);
  });

  test('a refused open lands in not-a-repo mode: null id, reason in shared.error', async () => {
    onRequest = (call) =>
      call.method === 'POST' && call.url === '/repos'
        ? { status: 400, body: { error: 'Not a git repository' } }
        : undefined;
    const store = useRepoStore();
    await store.open('/not-a-repo');

    expect(store.repoId).toBeNull();
    expect(store.isRepo).toBe(false);
    expect(store.shared.error).toBe('Not a git repository');
    expect(store.shared.isLoading).toBe(false);
    expect(FakeEventSource.instances).toHaveLength(0);

    // Everything no-ops without an id — no throws, no requests.
    const before = fake.calls.length;
    store.selectFile(fileEntry('a.ts'));
    await store.stageAll();
    await store.loadHistory();
    await flush();
    expect(fake.calls.length).toBe(before);
  });

  test('state-change events flow through the same sink as the snapshot', async () => {
    const { store, source } = await openStore();
    source.emit('state-change', wireState([fileEntry('new.ts')], { error: 'watcher hiccup' }));
    expect(store.shared.status!.files.map((f) => f.path)).toEqual(['new.ts']);
    expect(store.shared.error).toBe('watcher hiccup');
  });

  test('open returns the ref; the first open releases nothing', async () => {
    const store = useRepoStore();
    await expect(store.open('/repo')).resolves.toEqual({ id: 'r1', path: '/repo' });
    expect(fake.calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
  });

  test('switching repos releases the previous ref after the new open succeeds', async () => {
    const { store } = await openStore();

    onRequest = (call) => {
      if (call.method === 'POST' && call.url === '/repos') {
        return { body: { id: 'r2', path: (call.body as { path: string }).path } };
      }
      if (call.url.startsWith('/repos/r2/')) {
        return { body: call.url.endsWith('/status') ? wireState() : { state: wireState() } };
      }
      return undefined;
    };

    const ref = await store.open('/repo2');
    expect(ref).toEqual({ id: 'r2', path: '/repo2' });
    await flush();
    const deletes = fake.calls.filter((c) => c.method === 'DELETE');
    expect(deletes.map((c) => c.url)).toEqual(['/repos/r1']);
  });

  test('re-opening the same repo releases the extra ref (net one hold)', async () => {
    const { store } = await openStore();

    await store.open('/repo'); // POST bumps the daemon refcount to 2...
    await flush();
    // ...and the release brings it back to 1.
    const deletes = fake.calls.filter((c) => c.method === 'DELETE');
    expect(deletes.map((c) => c.url)).toEqual(['/repos/r1']);
    expect(store.repoId).toBe('r1');
  });

  test('a refused open releases nothing', async () => {
    const { store } = await openStore();
    onRequest = (call) =>
      call.method === 'POST' && call.url === '/repos'
        ? { status: 400, body: { error: 'Not a git repository' } }
        : undefined;

    await expect(store.open('/not-a-repo')).resolves.toBeNull();
    expect(fake.calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
    expect(store.shared.error).toBe('Not a git repository');
  });

  test('a connection error during open sets the calm line and recovery brings the repo up', async () => {
    let down = true;
    onRequest = (call) => {
      if (down && call.method === 'POST' && call.url === '/repos') {
        throw new TypeError('Failed to fetch');
      }
      return undefined;
    };

    const store = useRepoStore();
    await expect(store.open('/repo')).resolves.toBeNull();

    // Not a raw transport dump: the ONE calm line, no stuck loading state.
    expect(store.shared.error).toBe(CONNECTION_LOST_MESSAGE);
    expect(store.shared.isLoading).toBe(false);

    // Recovery was scheduled: once the daemon answers, the repo comes up.
    down = false;
    await advance(1000);
    expect(store.repoId).toBe('r1');
    expect(store.shared.error).toBeNull();
  });
});

// --- Selection: re-anchoring, debounce, stale-guard ---

describe('selection', () => {
  test('selectFile fetches immediately (leading) and applies the diff', async () => {
    const file = fileEntry('u.txt', { status: 'untracked' });
    const { store } = await openStore([file]);

    store.selectFile(file);
    expect(diffCalls()).toHaveLength(1); // leading edge, no wait
    await flush();
    expect(store.selection.file).toBe(file);
    expect(store.selection.diff!.raw).toContain('path=u.txt');
  });

  test('untracked files fetch unstaged only — never staged=true', async () => {
    const file = fileEntry('u.txt', { status: 'untracked' });
    const { store } = await openStore([file]);

    store.selectFile(file);
    await flush();
    expect(diffCalls()).toEqual(['/repos/r1/diff?path=u.txt']);
    expect(store.selection.combined).toEqual({
      unstaged: store.selection.diff,
      staged: { raw: '', lines: [] },
    });
  });

  test('tracked files fetch both sides; diff shows the selected side', async () => {
    const file = fileEntry('a.ts');
    const { store } = await openStore([file]);

    store.selectFile(file);
    await flush();
    expect(diffCalls()).toEqual([
      '/repos/r1/diff?path=a.ts&staged=false',
      '/repos/r1/diff?path=a.ts&staged=true',
    ]);
    expect(store.selection.diff!.raw).toContain('staged=false');
    expect(store.selection.combined!.staged.raw).toContain('staged=true');
  });

  test('no selection fetches the whole-tree staged diff', async () => {
    const { store } = await openStore();
    store.selectFile(null);
    await flush();
    expect(diffCalls()).toEqual(['/repos/r1/diff?staged=true']);
    expect(store.selection.diff!.raw).toContain('staged=true');
    expect(store.selection.combined).toBeNull();
  });

  test('rapid selectFile calls coalesce: leading fetch + one trailing fetch', async () => {
    const a = fileEntry('a.txt', { status: 'untracked' });
    const b = fileEntry('b.txt', { status: 'untracked' });
    const c = fileEntry('c.txt', { status: 'untracked' });
    const { store } = await openStore([a, b, c]);

    store.selectFile(a); // leading: fires now
    store.selectFile(b); // within 20ms: replaces the trailing fetch
    store.selectFile(c); // within 20ms: replaces it again
    expect(diffCalls()).toHaveLength(1);

    await advance(25);
    const calls = diffCalls();
    expect(calls).toHaveLength(2); // b was never fetched
    expect(calls[0]).toContain('path=a.txt');
    expect(calls[1]).toContain('path=c.txt');
    // a's response was dropped by the stale-guard; c's landed.
    expect(store.selection.diff!.raw).toContain('path=c.txt');
  });

  test('identity stale-guard drops a slow response for a stale selection', async () => {
    const a = fileEntry('a.txt', { status: 'untracked' });
    const b = fileEntry('b.txt', { status: 'untracked' });
    const { store } = await openStore([a, b]);

    const slow = new Deferred<FakeResponse>();
    onRequest = (call) => (call.url.includes('path=a.txt') ? slow.promise : undefined);

    store.selectFile(a); // leading fetch, response withheld
    await advance(25); // debounce window expires
    store.selectFile(b); // new leading fetch, resolves immediately
    await flush();
    expect(store.selection.diff!.raw).toContain('path=b.txt');

    slow.resolve({ body: { raw: 'stale diff for a', lines: [] } });
    await flush();
    // The stale a-response must not overwrite b's diff.
    expect(store.selection.diff!.raw).toContain('path=b.txt');
  });

  test('stale-guard is by object identity, not path: a same-path new object drops the old response', async () => {
    // Two entries for the SAME path but distinct objects (e.g. the old entry vs
    // the re-anchored entry after a state-change). A path-based guard would keep
    // the first response; the identity guard must drop it.
    const a1 = fileEntry('a.txt', { status: 'untracked' });
    const a2 = fileEntry('a.txt', { status: 'untracked' });
    const { store } = await openStore([a1]);

    const slow = new Deferred<FakeResponse>();
    let diffHits = 0;
    onRequest = (call) => {
      if (call.url.includes('/repos/r1/diff') && call.url.includes('path=a.txt')) {
        diffHits += 1;
        return diffHits === 1 ? slow.promise : { body: { raw: 'fresh-a2', lines: [] } };
      }
      return undefined;
    };

    store.selectFile(a1); // leading fetch -> withheld
    await advance(25); // debounce window clears
    store.selectFile(a2); // same path, different object -> new leading fetch -> fresh-a2
    await flush();
    expect(store.selection.diff!.raw).toContain('fresh-a2');

    slow.resolve({ body: { raw: 'stale-a1', lines: [] } });
    await flush();
    // a1 !== the live selection (a2), so the stale response is dropped.
    expect(store.selection.diff!.raw).toContain('fresh-a2');
  });

  test('a stale diff-fetch failure after open() does not error the newly-opened repo', async () => {
    const a = fileEntry('a.txt', { status: 'untracked' });
    const { store } = await openStore([a]);

    const slow = new Deferred<FakeResponse>();
    onRequest = (call) => {
      if (call.url === '/repos' && call.method === 'POST') {
        return { body: { id: 'r2', path: (call.body as { path: string }).path } };
      }
      if (call.url.startsWith('/repos/r2/')) {
        return { body: call.url.endsWith('/status') ? wireState() : { state: wireState() } };
      }
      if (call.url.includes('/repos/r1/diff')) return slow.promise;
      return undefined;
    };

    store.selectFile(a); // r1 diff fetch -> withheld (in flight)
    await flush();
    await store.open('/repo2'); // generation bumps; r2 loads clean
    FakeEventSource.latest().emit('snapshot', wireState());
    await flush();
    expect(store.shared.error).toBeNull();

    // r1's now-stale diff fails with a server error (a DaemonError, not a
    // connection error). The generation guard must drop it, not banner r2.
    slow.resolve({ status: 500, body: { error: 'boom' } });
    await flush();
    expect(store.shared.error).toBeNull();
  });

  test('fresh status re-anchors the selection to the new entry (same staged side first)', async () => {
    const unstagedA = fileEntry('a.ts', { staged: false });
    const { store, source } = await openStore([unstagedA]);
    store.selectFile(unstagedA);
    await advance(25);

    // New status: a.ts now exists on both sides (partially staged).
    source.emit('state-change', wireState([fileEntry('a.ts', { staged: true }), unstagedA]));
    await advance(25);

    const anchored = store.selection.file!;
    expect(anchored).toBe(store.shared.status!.files[1]); // the staged:false twin
    expect(anchored.staged).toBe(false);
  });

  test('fresh status falls back to the other staged side when the exact side vanished', async () => {
    const unstagedA = fileEntry('a.ts', { staged: false });
    const { store, source } = await openStore([unstagedA]);
    store.selectFile(unstagedA);
    await advance(25);

    source.emit('state-change', wireState([fileEntry('a.ts', { staged: true })]));
    await advance(25);
    expect(store.selection.file).toBe(store.shared.status!.files[0]);
    expect(store.selection.file!.staged).toBe(true);
  });

  test('a vanished file clears the selection', async () => {
    const file = fileEntry('a.ts');
    const { store, source } = await openStore([file]);
    store.selectFile(file);
    await advance(25);

    source.emit('state-change', wireState([]));
    await flush();
    expect(store.selection).toEqual({ file: null, diff: null, combined: null });
  });

  test('the re-anchored selection gets its diff re-fetched', async () => {
    const file = fileEntry('u.txt', { status: 'untracked' });
    const { store, source } = await openStore([file]);
    store.selectFile(file);
    await advance(25);
    const before = diffCalls().length;

    source.emit('state-change', wireState([fileEntry('u.txt', { status: 'untracked' })]));
    await advance(25);
    expect(diffCalls().length).toBeGreaterThan(before);
    expect(store.selection.file).toBe(store.shared.status!.files[0]);
  });
});

// --- Mutations ---

describe('mutations', () => {
  test('a mutation envelope state flows through applyWireState', async () => {
    const file = fileEntry('a.ts');
    const { store } = await openStore([file]);

    const staged = fileEntry('a.ts', { staged: true });
    onRequest = (call) =>
      call.url === '/repos/r1/stage' ? { body: { state: wireState([staged]) } } : undefined;

    await store.stage(file);
    expect(fake.callsTo('/stage')[0].body).toEqual({ path: 'a.ts' });
    expect(store.shared.status!.files).toEqual([staged]);
  });

  test('a mutation DaemonError lands in shared.error, never throws', async () => {
    const file = fileEntry('a.ts');
    const { store } = await openStore([file]);
    onRequest = (call) =>
      call.url === '/repos/r1/stage' ? { status: 409, body: { error: 'index locked' } } : undefined;

    await store.stage(file);
    expect(store.shared.error).toBe('Failed to stage a.ts: index locked');
  });

  test('commit posts message and amend flag', async () => {
    const { store } = await openStore();
    await store.commit('fix things', true);
    expect(fake.callsTo('/commit')[0].body).toEqual({ message: 'fix things', amend: true });
  });

  test('discard no-ops on a staged file (parity with the CLI)', async () => {
    const { store } = await openStore();
    await store.discard(fileEntry('a.ts', { staged: true }));
    expect(fake.callsTo('/discard')).toHaveLength(0);
  });

  test('a mutation hitting a dead daemon enters the reconnect state', async () => {
    const file = fileEntry('a.ts');
    const { store } = await openStore([file]);
    onRequest = (call) => {
      if (call.url === '/repos/r1/stage') throw new TypeError('Failed to fetch');
      return undefined;
    };

    await store.stage(file);
    expect(store.shared.error).toBe(CONNECTION_LOST_MESSAGE);

    // Recovery re-POSTs /repos and pulls status, clearing the line.
    onRequest = null;
    const repoPosts = () => fake.calls.filter((c) => c.method === 'POST' && c.url === '/repos');
    expect(repoPosts()).toHaveLength(1);
    await advance(1000);
    expect(repoPosts()).toHaveLength(2);
    expect(store.shared.error).toBeNull();
  });
});

// --- History ---

describe('history', () => {
  test('loadHistory pulls commits and revives dates', async () => {
    const { store } = await openStore();
    await store.loadHistory(50);
    expect(fake.callsTo('/history')[0].url).toBe('/repos/r1/history?count=50');
    expect(store.history.commits).toHaveLength(1);
    expect(store.history.commits[0].date).toBeInstanceOf(Date);
    expect(store.history.isLoading).toBe(false);
  });

  test('history is re-pulled on state-change once loaded, with the same count', async () => {
    const { store, source } = await openStore();
    await store.loadHistory(50);
    expect(fake.callsTo('/history')).toHaveLength(1);

    source.emit('state-change', wireState());
    await flush();
    expect(fake.callsTo('/history')).toHaveLength(2);
    expect(fake.callsTo('/history')[1].url).toBe('/repos/r1/history?count=50');
  });

  test('history is NOT pulled on state-change when never loaded', async () => {
    const { source } = await openStore();
    source.emit('state-change', wireState());
    await flush();
    expect(fake.callsTo('/history')).toHaveLength(0);
  });

  test('selectHistoryCommit fetches the commit diff; a stale response is dropped', async () => {
    const { store } = await openStore();
    await store.loadHistory();
    const commit = store.history.commits[0];

    const slow = new Deferred<FakeResponse>();
    onRequest = (call) => (call.url.startsWith('/repos/r1/commits/') ? slow.promise : undefined);

    const selectPromise = store.selectHistoryCommit(commit);
    expect(store.history.selectedCommit).toBe(commit);

    await store.selectHistoryCommit(null); // deselect before the diff lands
    slow.resolve({ body: { raw: 'stale commit diff', lines: [] } });
    await selectPromise;
    expect(store.history.commitDiff).toBeNull();
  });

  test('getHeadCommitMessage unwraps the message; empty on connection loss', async () => {
    const { store } = await openStore();
    await expect(store.getHeadCommitMessage()).resolves.toBe('HEAD msg');

    onRequest = (call) => {
      if (call.url === '/repos/r1/head-message') throw new TypeError('Failed to fetch');
      return undefined;
    };
    await expect(store.getHeadCommitMessage()).resolves.toBe('');
    expect(store.shared.error).toBe(CONNECTION_LOST_MESSAGE);
  });
});

// --- Compare ---

describe('compare', () => {
  test('refreshCompare loads the diff, revives commit dates, records the base', async () => {
    const { store } = await openStore();
    await store.refreshCompare();
    expect(store.compare.compareDiff!.baseBranch).toBe('origin/main');
    expect(store.compare.baseBranch).toBe('origin/main');
    expect(store.compare.compareDiff!.commits[0].date).toBeInstanceOf(Date);
    expect(store.compare.loading).toBe(false);
    expect(store.compare.noBaseBranch).toBe(false);
  });

  test('a 422 is the no-base-branch state, not an error banner', async () => {
    const { store } = await openStore();
    onRequest = (call) =>
      call.url.startsWith('/repos/r1/compare')
        ? { status: 422, body: { error: 'no base branch' } }
        : undefined;

    await store.refreshCompare();
    expect(store.compare.noBaseBranch).toBe(true);
    expect(store.compare.error).toBeNull();
    expect(store.compare.compareDiff).toBeNull();
    expect(store.compare.baseBranch).toBeNull();
    expect(store.compare.loading).toBe(false);
  });

  test('other daemon errors surface in compare.error', async () => {
    const { store } = await openStore();
    onRequest = (call) =>
      call.url.startsWith('/repos/r1/compare')
        ? { status: 500, body: { error: 'git exploded' } }
        : undefined;

    await store.refreshCompare();
    expect(store.compare.error).toBe('Failed to load compare diff: git exploded');
    expect(store.compare.noBaseBranch).toBe(false);
  });

  test('compare connection loss routes to reconnect, not the error banner', async () => {
    const { store } = await openStore();
    onRequest = (call) => {
      if (call.url.startsWith('/repos/r1/compare')) throw new TypeError('Failed to fetch');
      return undefined;
    };

    await store.refreshCompare();
    expect(store.compare.loading).toBe(false);
    expect(store.compare.error).toBeNull();
    expect(store.shared.error).toBe(CONNECTION_LOST_MESSAGE);
  });

  test('compare is re-pulled on state-change once loaded, keeping the uncommitted flag', async () => {
    const { store, source } = await openStore();
    await store.refreshCompare(true);
    expect(fake.callsTo('/compare')[0].url).toBe('/repos/r1/compare?uncommitted=true');

    source.emit('state-change', wireState());
    await flush();
    expect(fake.callsTo('/compare')).toHaveLength(2);
    expect(fake.callsTo('/compare')[1].url).toBe('/repos/r1/compare?uncommitted=true');
  });

  test('setCompareBaseBranch persists then reloads; selectCompareFile picks from the loaded diff', async () => {
    const { store } = await openStore();
    onRequest = (call) =>
      call.method === 'PUT' && call.url === '/repos/r1/compare/base'
        ? { body: { base: 'origin/dev' } }
        : undefined;

    await store.setCompareBaseBranch('origin/dev');
    expect(fake.calls.some((c) => c.method === 'PUT' && c.url === '/repos/r1/compare/base')).toBe(
      true
    );
    expect(store.compare.compareDiff).not.toBeNull();

    store.selectCompareFile(0);
    expect(store.compare.selection).toEqual({
      type: 'file',
      index: 0,
      diff: { raw: 'compare-file-diff', lines: [] },
    });

    store.selectCompareFile(99);
    expect(store.compare.selection).toEqual({ type: null, index: 0, diff: null });
  });

  test('selectCompareCommit pulls the commit diff and guards the selection', async () => {
    const { store } = await openStore();
    await store.refreshCompare();
    await store.selectCompareCommit(0);
    expect(store.compare.selection.type).toBe('commit');
    expect(store.compare.selection.diff!.raw).toContain('commit-diff:');
  });
});

// --- Remote operations (synthesized state) ---

describe('remote operations', () => {
  test('cherryPick drives the remote state machine and applies the envelope', async () => {
    const { store } = await openStore();
    const picked = fileEntry('picked.ts');
    onRequest = (call) =>
      call.url === '/repos/r1/cherry-pick'
        ? { body: { state: wireState([picked]), result: 'Cherry-picked abc' } }
        : undefined;

    await store.cherryPick('abc');
    expect(store.remote).toEqual({
      operation: 'cherryPick',
      inProgress: false,
      error: null,
      lastResult: 'Cherry-picked abc',
    });
    expect(store.shared.status!.files).toEqual([picked]);
  });

  test('a second remote op is refused while one is in flight', async () => {
    const { store } = await openStore();
    const slow = new Deferred<FakeResponse>();
    onRequest = (call) => (call.url === '/repos/r1/push' ? slow.promise : undefined);

    const pushPromise = store.push();
    expect(store.remote.inProgress).toBe(true);

    await store.pull(); // guarded: no request fired
    expect(fake.callsTo('/pull')).toHaveLength(0);

    slow.resolve({ body: { state: wireState(), result: 'Pushed' } });
    await pushPromise;
    expect(store.remote.inProgress).toBe(false);
    expect(store.remote.lastResult).toBe('Pushed');
  });

  test('a remote-op daemon error lands in remote.error', async () => {
    const { store } = await openStore();
    onRequest = (call) =>
      call.url === '/repos/r1/push' ? { status: 409, body: { error: 'push rejected' } } : undefined;

    await store.push();
    expect(store.remote.inProgress).toBe(false);
    expect(store.remote.error).toBe('push rejected');
    expect(store.shared.error).toBeNull(); // remote errors stay off the shared banner
  });

  test('clearRemoteState resets the machine', async () => {
    const { store } = await openStore();
    await store.revertCommit('abc');
    store.clearRemoteState();
    expect(store.remote).toEqual({
      operation: null,
      inProgress: false,
      error: null,
      lastResult: null,
    });
  });
});

// --- Reconnect ---

describe('reconnect', () => {
  test('a drop before the first snapshot clears isLoading beside the error line', async () => {
    const store = useRepoStore();
    await store.open('/repo');
    expect(store.shared.isLoading).toBe(true); // no snapshot yet

    FakeEventSource.latest().fail();
    expect(store.shared.error).toBe(CONNECTION_LOST_MESSAGE);
    expect(store.shared.isLoading).toBe(false); // no stuck "Loading…" beside the error
  });

  test('an SSE drop sets ONE calm line and recovery clears it', async () => {
    const { store, source } = await openStore([fileEntry('a.ts')]);

    source.fail();
    expect(store.shared.error).toBe(CONNECTION_LOST_MESSAGE);
    expect(source.closed).toBe(true); // the store owns retry, not EventSource

    // A second loss signal must not rewrite the state (no flicker).
    const before = store.shared;
    onRequest = (call) => {
      if (call.url === '/repos/r1/head-message') throw new TypeError('Failed to fetch');
      return undefined;
    };
    await store.getHeadCommitMessage();
    expect(store.shared).toBe(before);

    // Daemon back: recovery re-POSTs /repos, resubscribes, pulls status.
    onRequest = null;
    await advance(1000);
    expect(fake.calls.filter((c) => c.method === 'POST' && c.url === '/repos')).toHaveLength(2);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(store.shared.error).toBeNull();
    expect(FakeEventSource.latest().url).toBe('/repos/r1/events');
  });

  test('recovery is single-flight: overlapping loss signals cause one re-open', async () => {
    const { store, source } = await openStore();

    const slowOpen = new Deferred<FakeResponse>();
    onRequest = (call) => {
      if (call.method === 'POST' && call.url === '/repos') return slowOpen.promise;
      if (call.url === '/repos/r1/head-message') throw new TypeError('Failed to fetch');
      return undefined;
    };

    source.fail();
    await advance(1000); // recovery starts, held on the deferred

    // More failures while recovery is in flight: no second attempt.
    await store.getHeadCommitMessage();
    await advance(3000);
    const repoPosts = fake.calls.filter((c) => c.method === 'POST' && c.url === '/repos');
    expect(repoPosts).toHaveLength(2); // initial open + ONE recovery

    onRequest = null;
    slowOpen.resolve({ body: { id: 'r1', path: '/repo' } });
    await flush();
    expect(store.shared.error).toBeNull();
  });

  test('a failed recovery keeps the line and retries until the daemon returns', async () => {
    const { store, source } = await openStore();

    let refuse = true;
    onRequest = (call) => {
      if (refuse && call.method === 'POST' && call.url === '/repos') {
        throw new TypeError('Failed to fetch');
      }
      return undefined;
    };

    source.fail();
    await advance(1000); // attempt 1 fails
    expect(store.shared.error).toBe(CONNECTION_LOST_MESSAGE);

    refuse = false;
    await advance(1000); // attempt 2 succeeds
    expect(store.shared.error).toBeNull();
    expect(fake.calls.filter((c) => c.method === 'POST' && c.url === '/repos')).toHaveLength(3);
  });

  test('open() invalidates in-flight recovery of the previous repo', async () => {
    const { source } = await openStore();

    const slowOpen = new Deferred<FakeResponse>();
    onRequest = (call) =>
      call.method === 'POST' && call.url === '/repos' ? slowOpen.promise : undefined;

    source.fail();
    await advance(1000); // recovery in flight

    // User switches repos while the old recovery hangs.
    onRequest = (call) =>
      call.method === 'POST' && call.url === '/repos'
        ? { body: { id: 'r2', path: '/other' } }
        : undefined;
    const store = useRepoStore();
    await store.open('/other');
    expect(store.repoId).toBe('r2');

    // The stale recovery resolves for the OLD repo — it must not clobber r2.
    slowOpen.resolve({ body: { id: 'r1', path: '/repo' } });
    await flush();
    expect(store.repoId).toBe('r2');
  });
});
