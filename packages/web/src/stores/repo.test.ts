/**
 * useRepoStore tests: the read-only RepoSession port. Covers the
 * applyWireState sink + cascade, the fetch-free active-file selection
 * and its re-anchoring, wire decoding, compare-422, the read-only
 * compare base pick, the single-flight reconnect loop, and the
 * per-file working-diff cache (auto-activation on the first snapshot,
 * hybrid whole-tree/per-file fetch, changed-set refetch, identity
 * preservation, seq stale-guards). Driven entirely by a stubbed fetch
 * + FakeEventSource — no daemon, fake timers throughout. The store
 * has no git-mutating actions — the web UI is a viewer.
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
    mtimes: {},
    ...overrides,
  };
}

/** A realistic single-file diff section, ending in one trailing newline. */
function fileDiffRaw(path: string, marker: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    `index 1111111..2222222 100644`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1 +1 @@`,
    `-old ${marker}`,
    `+new ${marker}`,
    '',
  ].join('\n');
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
  if (url === '/repos/r1/worktrees') {
    return { body: [{ path: '/repo', branch: 'main', isMain: true }] };
  }
  return undefined;
}

function defaultPostRoutes(call: FetchCall): FakeResponse | undefined {
  if (call.url === '/repos') {
    return { body: { id: 'r1', path: (call.body as { path: string }).path } };
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

  test('mtimes ride the wire into shared state as a plain object (auto mode reads them)', async () => {
    const { store, source } = await openStore();
    source.emit(
      'state-change',
      wireState([fileEntry('a.ts')], { mtimes: { 'a.ts': 1721480000000 } })
    );
    expect(store.shared.mtimes).toEqual({ 'a.ts': 1721480000000 });
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
    await store.loadHistory();
    await store.refreshCompare();
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
        return { body: wireState() };
      }
      return undefined;
    };

    const ref = await store.open('/repo2');
    expect(ref).toEqual({ id: 'r2', path: '/repo2' });
    await flush();
    const deletes = fake.calls.filter((c) => c.method === 'DELETE');
    expect(deletes.map((c) => c.url)).toEqual(['/repos/r1']);
  });

  test('a superseded open releases its own just-acquired ref; nothing leaks under churn', async () => {
    const { store } = await openStore(); // holds r1

    // open('/a') hangs on its POST; open('/b') supersedes it and wins.
    const slow = new Deferred<FakeResponse>();
    onRequest = (call) => {
      if (call.method === 'POST' && call.url === '/repos') {
        const { path } = call.body as { path: string };
        if (path === '/a') return slow.promise;
        return { body: { id: 'rb', path } };
      }
      if (call.url.startsWith('/repos/rb/')) {
        return { body: wireState() };
      }
      return undefined;
    };

    const superseded = store.open('/a');
    const ref = await store.open('/b');
    expect(ref).toEqual({ id: 'rb', path: '/b' });

    slow.resolve({ body: { id: 'ra', path: '/a' } }); // resolves out of order
    await expect(superseded).resolves.toBeNull();
    await flush();

    // The winner released the previously held r1; the superseded open
    // released ONLY the ref it acquired (ra) — never the winner's rb.
    const deletes = fake.calls.filter((c) => c.method === 'DELETE').map((c) => c.url);
    expect(deletes).toEqual(['/repos/r1', '/repos/ra']);
    expect(store.repoId).toBe('rb');
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

// --- Selection: active file only, re-anchoring ---

describe('selection', () => {
  test('selectFile records the active file and fetches NOTHING', async () => {
    const file = fileEntry('a.ts');
    const { store } = await openStore([file]);
    const before = fake.calls.length;

    store.selectFile(file);
    await advance(50);

    expect(store.selection.file).toBe(file);
    // The stacked surface reads diffs from workingDiffs — the old
    // per-selection GET /diff path is gone.
    expect(fake.calls.length).toBe(before);
  });

  test('fresh status re-anchors the selection to the new entry (same staged side first)', async () => {
    const unstagedA = fileEntry('a.ts', { staged: false });
    const { store, source } = await openStore([unstagedA]);
    store.selectFile(unstagedA);

    // New status: a.ts now exists on both sides (partially staged).
    source.emit('state-change', wireState([fileEntry('a.ts', { staged: true }), unstagedA]));
    await flush();

    const anchored = store.selection.file!;
    expect(anchored).toBe(store.shared.status!.files[1]); // the staged:false twin
    expect(anchored.staged).toBe(false);
  });

  test('fresh status falls back to the other staged side when the exact side vanished', async () => {
    const unstagedA = fileEntry('a.ts', { staged: false });
    const { store, source } = await openStore([unstagedA]);
    store.selectFile(unstagedA);

    source.emit('state-change', wireState([fileEntry('a.ts', { staged: true })]));
    await flush();
    expect(store.selection.file).toBe(store.shared.status!.files[0]);
    expect(store.selection.file!.staged).toBe(true);
  });

  test('a vanished file clears the selection', async () => {
    const file = fileEntry('a.ts');
    const { store, source } = await openStore([file]);
    store.selectFile(file);

    source.emit('state-change', wireState([]));
    await flush();
    expect(store.selection).toEqual({ file: null });
  });
});

// --- Working-diff cache ---

describe('working-diff cache', () => {
  test('the first snapshot activates the cache: whole-tree pulls split per-file, untracked fetched per-file', async () => {
    const a = fileEntry('a.ts');
    const b = fileEntry('b.ts', { staged: true });
    const u = fileEntry('u.txt', { status: 'untracked' as FileStatus });
    const rawA = fileDiffRaw('a.ts', 'A');
    const rawB = fileDiffRaw('b.ts', 'B');
    const rawU = fileDiffRaw('u.txt', 'U');
    onRequest = (call) => {
      if (call.url === '/repos/r1/diff') return { body: { raw: rawA, lines: [] } };
      if (call.url === '/repos/r1/diff?staged=true') return { body: { raw: rawB, lines: [] } };
      if (call.url === '/repos/r1/diff?path=u.txt') return { body: { raw: rawU, lines: [] } };
      return undefined;
    };

    // No explicit refreshAllDiffs: the snapshot inside openStore is the trigger.
    const { store } = await openStore([a, b, u]);

    const byKey = store.workingDiffs.byKey;
    expect([...byKey.keys()].sort()).toEqual(['s:b.ts', 'u:a.ts', 'u:u.txt']);
    expect(byKey.get('u:a.ts')!.raw).toBe(rawA);
    expect(byKey.get('s:b.ts')!.raw).toBe(rawB);
    expect(byKey.get('u:u.txt')!.raw).toBe(rawU);
    // The untracked file was fetched per-file and NEVER with staged=true.
    expect(diffCalls()).toContain('/repos/r1/diff?path=u.txt');
  });

  test('activation is single-flight: back-to-back snapshots cause ONE whole-tree pull pair', async () => {
    const store = useRepoStore();
    await store.open('/repo');
    const source = FakeEventSource.latest();
    source.emit('snapshot', wireState([fileEntry('a.ts')]));
    source.emit('state-change', wireState([fileEntry('a.ts')]));
    await flush();
    expect(diffCalls()).toEqual(['/repos/r1/diff', '/repos/r1/diff?staged=true']);
  });

  test('a state-change landing DURING the activation pull is re-diffed afterwards, not missed', async () => {
    const rawStale = fileDiffRaw('a.ts', 'stale');
    const rawFresh = fileDiffRaw('a.ts', 'fresh');
    const heldTree = new Deferred<FakeResponse>();
    onRequest = (call) => {
      if (call.url === '/repos/r1/diff') return heldTree.promise; // activation hangs
      if (call.url === '/repos/r1/diff?staged=true') return { body: { raw: '', lines: [] } };
      if (call.url === '/repos/r1/diff?path=a.ts&staged=false') {
        return { body: { raw: rawFresh, lines: [] } };
      }
      return undefined;
    };
    const store = useRepoStore();
    await store.open('/repo');
    const source = FakeEventSource.latest();
    source.emit('snapshot', wireState([fileEntry('a.ts')], { mtimes: { 'a.ts': 1 } }));
    await flush(); // activation starts, held on the whole-tree pull

    // a.ts changes on disk while the pull is in flight; the cache is
    // still inactive, so this state misses the changed-set cascade.
    source.emit('state-change', wireState([fileEntry('a.ts')], { mtimes: { 'a.ts': 2 } }));
    await flush();

    heldTree.resolve({ body: { raw: rawStale, lines: [] } }); // the STALE tree lands
    await flush();
    await advance(25); // the post-pull re-diff's refetch debounce
    expect(store.workingDiffs.byKey.get('u:a.ts')!.raw).toBe(rawFresh);
  });

  test('a failed activation retries QUIETLY on the next state-change instead of staying empty', async () => {
    let broken = true;
    const rawA = fileDiffRaw('a.ts', 'A');
    onRequest = (call) => {
      if (!call.url.startsWith('/repos/r1/diff')) return undefined;
      if (broken) return { status: 500, body: { error: 'boom' } };
      if (call.url === '/repos/r1/diff') return { body: { raw: rawA, lines: [] } };
      return { body: { raw: '', lines: [] } };
    };
    const { store, source } = await openStore([fileEntry('a.ts')]);
    // Passive warm-up: the failure must not overwrite the wire error line.
    expect(store.shared.error).toBeNull();
    expect(store.workingDiffs.byKey.size).toBe(0);

    broken = false;
    source.emit('state-change', wireState([fileEntry('a.ts')]));
    await flush();
    expect(store.workingDiffs.byKey.get('u:a.ts')!.raw).toBe(rawA);
  });

  test('an EXPLICIT refreshAllDiffs surfaces its failure in shared.error', async () => {
    const { store } = await openStore([fileEntry('a.ts')]);
    onRequest = (call) =>
      call.url.startsWith('/repos/r1/diff')
        ? { status: 500, body: { error: 'boom' } }
        : undefined;

    await store.refreshAllDiffs();
    expect(store.shared.error).toBe('Failed to load diffs: boom');
  });

  test('untracked per-file fetches run through a concurrency-6 queue', async () => {
    const files = Array.from({ length: 8 }, (_, i) =>
      fileEntry(`u${i}.txt`, { status: 'untracked' as FileStatus })
    );
    const held: Deferred<FakeResponse>[] = [];
    onRequest = (call) => {
      if (call.url === '/repos/r1/diff') return { body: { raw: '', lines: [] } };
      if (call.url === '/repos/r1/diff?staged=true') return { body: { raw: '', lines: [] } };
      if (call.url.includes('path=')) {
        const deferred = new Deferred<FakeResponse>();
        held.push(deferred);
        return deferred.promise;
      }
      return undefined;
    };

    const { store } = await openStore(files); // activation holds on the deferreds
    const pathCalls = () => diffCalls().filter((u) => u.includes('path='));
    expect(pathCalls()).toHaveLength(6); // bounded: never all 8 at once

    held[0].resolve({ body: { raw: fileDiffRaw('u0.txt', '0'), lines: [] } });
    await flush();
    expect(pathCalls()).toHaveLength(7); // a freed worker picked up the 7th

    let resolved = 1;
    while (resolved < 8) {
      await flush();
      while (resolved < held.length) {
        held[resolved].resolve({ body: { raw: '', lines: [] } });
        resolved += 1;
      }
    }
    await flush();
    expect(pathCalls()).toHaveLength(8);
    expect(store.workingDiffs.byKey.get('u:u0.txt')!.raw).toBe(fileDiffRaw('u0.txt', '0'));
  });

  test('identity preservation: an unchanged raw keeps the SAME DiffResult object and model', async () => {
    const rawA = fileDiffRaw('a.ts', 'A');
    onRequest = (call) => {
      if (call.url === '/repos/r1/diff') return { body: { raw: rawA, lines: [] } };
      if (call.url === '/repos/r1/diff?staged=true') return { body: { raw: '', lines: [] } };
      if (call.url === '/repos/r1/diff?path=a.ts&staged=false') {
        return { body: { raw: rawA, lines: [] } };
      }
      return undefined;
    };
    const { store, source } = await openStore([fileEntry('a.ts')]);
    const before = store.workingDiffs.byKey.get('u:a.ts')!;
    const modelBefore = store.diffModelFor(before.diff, false); // 'u:a.ts' -> unstaged
    const seqBefore = store.workingDiffs.seq;
    const callsBefore = diffCalls().length;

    // The file's mtime moved, so it IS refetched — but content is equal.
    source.emit('state-change', wireState([fileEntry('a.ts')], { mtimes: { 'a.ts': 1 } }));
    await advance(25);

    expect(diffCalls().slice(callsBefore)).toEqual(['/repos/r1/diff?path=a.ts&staged=false']);
    const after = store.workingDiffs.byKey.get('u:a.ts')!;
    expect(after.diff).toBe(before.diff); // same object, by raw-value comparison
    expect(store.workingDiffs.seq).toBe(seqBefore); // no reactive churn at all
    expect(store.diffModelFor(after.diff, false)).toBe(modelBefore); // WeakMap memo hit
  });

  test('state-change refetches ONLY the changed files; others keep their objects', async () => {
    const rawA1 = fileDiffRaw('a.ts', 'A1');
    const rawA2 = fileDiffRaw('a.ts', 'A2');
    const rawB = fileDiffRaw('b.ts', 'B');
    let aVersion = rawA1;
    onRequest = (call) => {
      if (call.url === '/repos/r1/diff') return { body: { raw: aVersion + rawB, lines: [] } };
      if (call.url === '/repos/r1/diff?staged=true') return { body: { raw: '', lines: [] } };
      if (call.url === '/repos/r1/diff?path=a.ts&staged=false') {
        return { body: { raw: aVersion, lines: [] } };
      }
      return undefined;
    };
    const { store, source } = await openStore([fileEntry('a.ts'), fileEntry('b.ts')]);
    const bBefore = store.workingDiffs.byKey.get('u:b.ts')!.diff;
    const callsBefore = diffCalls().length;

    aVersion = rawA2;
    source.emit(
      'state-change',
      wireState([fileEntry('a.ts'), fileEntry('b.ts')], { mtimes: { 'a.ts': 2 } })
    );
    await advance(25);

    // Only a.ts was refetched; the entry was replaced in place (never blanked).
    expect(diffCalls().slice(callsBefore)).toEqual(['/repos/r1/diff?path=a.ts&staged=false']);
    expect(store.workingDiffs.byKey.get('u:a.ts')!.raw).toBe(rawA2);
    expect(store.workingDiffs.byKey.get('u:b.ts')!.diff).toBe(bBefore);
  });

  test('a changed set past 15 files falls back to ONE whole-tree re-pull', async () => {
    const files = Array.from({ length: 16 }, (_, i) => fileEntry(`f${i}.ts`));
    const whole = files.map((f) => fileDiffRaw(f.path, f.path)).join('');
    onRequest = (call) => {
      if (call.url === '/repos/r1/diff') return { body: { raw: whole, lines: [] } };
      if (call.url === '/repos/r1/diff?staged=true') return { body: { raw: '', lines: [] } };
      return undefined;
    };
    const { store, source } = await openStore(files);
    expect(store.workingDiffs.byKey.size).toBe(16);
    const callsBefore = diffCalls().length;

    const mtimes = Object.fromEntries(files.map((f) => [f.path, 2]));
    source.emit(
      'state-change',
      wireState(
        files.map((f) => fileEntry(f.path)),
        { mtimes }
      )
    );
    await advance(25);

    // No per-file storm: exactly the two whole-tree pulls.
    expect(diffCalls().slice(callsBefore)).toEqual([
      '/repos/r1/diff',
      '/repos/r1/diff?staged=true',
    ]);
  });

  test('a stale per-file response never overwrites a newer entry (seq guard)', async () => {
    const v1 = fileDiffRaw('a.ts', 'v1');
    const v2 = fileDiffRaw('a.ts', 'v2');
    const v3 = fileDiffRaw('a.ts', 'v3');
    const slow = new Deferred<FakeResponse>();
    let pathHits = 0;
    onRequest = (call) => {
      if (call.url === '/repos/r1/diff') return { body: { raw: v1, lines: [] } };
      if (call.url === '/repos/r1/diff?staged=true') return { body: { raw: '', lines: [] } };
      if (call.url === '/repos/r1/diff?path=a.ts&staged=false') {
        pathHits += 1;
        return pathHits === 1 ? slow.promise : { body: { raw: v3, lines: [] } };
      }
      return undefined;
    };
    const { store, source } = await openStore([fileEntry('a.ts')]);

    source.emit('state-change', wireState([fileEntry('a.ts')], { mtimes: { 'a.ts': 2 } }));
    await advance(25); // refetch 1 fires — withheld
    source.emit('state-change', wireState([fileEntry('a.ts')], { mtimes: { 'a.ts': 3 } }));
    await advance(25); // refetch 2 fires — lands v3
    expect(store.workingDiffs.byKey.get('u:a.ts')!.raw).toBe(v3);

    slow.resolve({ body: { raw: v2, lines: [] } }); // refetch 1 lands LAST
    await flush();
    expect(store.workingDiffs.byKey.get('u:a.ts')!.raw).toBe(v3); // not clobbered
  });

  test('files leaving the status set are evicted; entering files are fetched', async () => {
    const rawA = fileDiffRaw('a.ts', 'A');
    const rawB = fileDiffRaw('b.ts', 'B');
    onRequest = (call) => {
      if (call.url === '/repos/r1/diff') return { body: { raw: rawA, lines: [] } };
      if (call.url === '/repos/r1/diff?staged=true') return { body: { raw: '', lines: [] } };
      if (call.url === '/repos/r1/diff?path=b.ts&staged=false') {
        return { body: { raw: rawB, lines: [] } };
      }
      return undefined;
    };
    const { store, source } = await openStore([fileEntry('a.ts')]);
    expect([...store.workingDiffs.byKey.keys()]).toEqual(['u:a.ts']);

    source.emit('state-change', wireState([fileEntry('b.ts')]));
    await advance(25);
    expect(store.workingDiffs.byKey.has('u:a.ts')).toBe(false);
    expect(store.workingDiffs.byKey.get('u:b.ts')!.raw).toBe(rawB);
  });

  test('open() resets the cache; the new repo activates on ITS first snapshot', async () => {
    const rawA = fileDiffRaw('a.ts', 'A');
    const rawA9 = fileDiffRaw('a.ts', 'A9');
    let version = rawA;
    onRequest = (call) => {
      if (call.url === '/repos/r1/diff') return { body: { raw: version, lines: [] } };
      if (call.url === '/repos/r1/diff?staged=true') return { body: { raw: '', lines: [] } };
      return undefined;
    };
    const { store } = await openStore([fileEntry('a.ts')]);
    expect(store.workingDiffs.byKey.get('u:a.ts')!.raw).toBe(rawA);
    const firstEntry = store.workingDiffs.byKey.get('u:a.ts')!;

    version = rawA9;
    await store.open('/repo');
    // The reset is immediate; the fresh pull waits for the new snapshot.
    expect(store.workingDiffs.byKey.size).toBe(0);
    expect(store.workingDiffs.seq).toBe(0);

    const source = FakeEventSource.latest();
    source.emit('snapshot', wireState([fileEntry('a.ts')], { mtimes: { 'a.ts': 9 } }));
    await flush();
    expect(store.workingDiffs.byKey.get('u:a.ts')!.raw).toBe(rawA9);
    expect(store.workingDiffs.byKey.get('u:a.ts')).not.toBe(firstEntry);
  });
});

// --- Read-only stance ---

describe('read-only stance', () => {
  test('the store exposes NO git-mutating actions', async () => {
    const { store } = await openStore([fileEntry('a.ts')]);
    const forbidden = [
      'stage',
      'unstage',
      'stageAll',
      'unstageAll',
      'discard',
      'stageHunk',
      'unstageHunk',
      'commit',
      'push',
      'fetchRemote',
      'pull',
      'stash',
      'stashPop',
      'switchBranch',
      'createBranch',
      'softReset',
      'cherryPick',
      'revertCommit',
      'abort',
      'rebaseContinue',
      'setCompareBaseBranch',
      'getHeadCommitMessage',
      'listBranches',
      'clearRemoteState',
    ];
    for (const name of forbidden) {
      expect((store as unknown as Record<string, unknown>)[name]).toBeUndefined();
    }
    // And a full read session issued nothing but GETs after the attach.
    const nonGet = fake.calls.filter((c) => c.method !== 'GET');
    expect(nonGet.map((c) => [c.method, c.url])).toEqual([['POST', '/repos']]);
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
});

// --- Worktrees ---

describe('listWorktrees', () => {
  test('returns the daemon worktree list; empty on connection loss', async () => {
    const { store } = await openStore();
    await expect(store.listWorktrees()).resolves.toEqual([
      { path: '/repo', branch: 'main', isMain: true },
    ]);

    onRequest = (call) => {
      if (call.url === '/repos/r1/worktrees') throw new TypeError('Failed to fetch');
      return undefined;
    };
    await expect(store.listWorktrees()).resolves.toEqual([]);
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

  test('out-of-order refreshCompare responses apply only the latest request', async () => {
    const { store } = await openStore();

    // Request A (uncommitted ON) is slow; request B (OFF) resolves fast.
    const slow = new Deferred<FakeResponse>();
    onRequest = (call) =>
      call.url === '/repos/r1/compare?uncommitted=true' ? slow.promise : undefined;

    const first = store.refreshCompare(true);
    const second = store.refreshCompare(false);
    await second;
    await flush();
    expect(store.compare.compareDiff!.baseBranch).toBe('origin/main');
    expect(store.compare.loading).toBe(false);

    // A lands LAST — stale, must not overwrite B's state.
    slow.resolve({ body: { ...(compareBody() as object), baseBranch: 'STALE' } });
    await first;
    await flush();
    expect(store.compare.compareDiff!.baseBranch).toBe('origin/main');
  });

  test('a stale refreshCompare failure cannot error out the newer result', async () => {
    const { store } = await openStore();

    const slow = new Deferred<FakeResponse>();
    onRequest = (call) =>
      call.url === '/repos/r1/compare?uncommitted=true' ? slow.promise : undefined;

    const first = store.refreshCompare(true);
    await store.refreshCompare(false);
    slow.resolve({ status: 500, body: { error: 'git exploded' } });
    await first;
    await flush();
    expect(store.compare.error).toBeNull();
    expect(store.compare.compareDiff!.baseBranch).toBe('origin/main');
  });

  test('a refresh re-anchors the file selection by path, clearing it when the file is gone', async () => {
    const { store } = await openStore();
    await store.refreshCompare();
    store.selectCompareFile(0); // a.ts at index 0
    expect(store.compare.selection).toMatchObject({ type: 'file', index: 0 });

    // The file set grows/reorders: a.ts moves to index 1.
    const reordered = compareBody() as { files: unknown[] };
    reordered.files = [
      {
        path: 'b.ts',
        status: 'added',
        additions: 1,
        deletions: 0,
        diff: { raw: 'b-diff', lines: [] },
      },
      ...reordered.files,
    ];
    onRequest = (call) =>
      call.url.startsWith('/repos/r1/compare') ? { body: reordered } : undefined;
    await store.refreshCompare();
    expect(store.compare.selection).toMatchObject({ type: 'file', index: 1 });
    expect(store.compare.selection.diff!.raw).toBe('compare-file-diff');

    // a.ts vanishes: the selection clears instead of pointing elsewhere.
    const without = compareBody() as { files: unknown[] };
    without.files = [
      {
        path: 'b.ts',
        status: 'added',
        additions: 1,
        deletions: 0,
        diff: { raw: 'b-diff', lines: [] },
      },
    ];
    onRequest = (call) =>
      call.url.startsWith('/repos/r1/compare') ? { body: without } : undefined;
    await store.refreshCompare();
    expect(store.compare.selection).toEqual({ type: null, index: 0, diff: null });
  });

  test('getLastIncludeUncommitted remembers the last requested flag', async () => {
    const { store } = await openStore();
    expect(store.getLastIncludeUncommitted()).toBe(false);
    await store.refreshCompare(true);
    expect(store.getLastIncludeUncommitted()).toBe(true);
  });

  test('setSelectedCompareBase reads with ?base= and issues NO PUT', async () => {
    const { store } = await openStore();

    await store.setSelectedCompareBase('origin/dev');
    expect(store.selectedCompareBase).toBe('origin/dev');
    expect(fake.callsTo('/compare')[0]).toMatchObject({
      method: 'GET',
      url: '/repos/r1/compare?base=origin%2Fdev&uncommitted=false',
    });
    // Read-only: nothing was persisted daemon-side.
    expect(fake.calls.some((c) => c.method === 'PUT')).toBe(false);
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

  test('the picked base rides every later refresh, including the state-change re-pull', async () => {
    const { store, source } = await openStore();
    await store.setSelectedCompareBase('origin/dev', true);

    source.emit('state-change', wireState());
    await flush();
    const urls = fake.callsTo('/compare').map((c) => c.url);
    expect(urls).toEqual([
      '/repos/r1/compare?base=origin%2Fdev&uncommitted=true',
      '/repos/r1/compare?base=origin%2Fdev&uncommitted=true',
    ]);
  });

  test('selectCompareCommit pulls the commit diff and guards the selection', async () => {
    const { store } = await openStore();
    await store.refreshCompare();
    await store.selectCompareCommit(0);
    expect(store.compare.selection.type).toBe('commit');
    expect(store.compare.selection.diff!.raw).toContain('commit-diff:');
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
      if (call.url === '/repos/r1/worktrees') throw new TypeError('Failed to fetch');
      return undefined;
    };
    await store.listWorktrees();
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
      if (call.url === '/repos/r1/worktrees') throw new TypeError('Failed to fetch');
      return undefined;
    };

    source.fail();
    await advance(1000); // recovery starts, held on the deferred

    // More failures while recovery is in flight: no second attempt.
    await store.listWorktrees();
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
