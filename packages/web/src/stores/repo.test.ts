/**
 * useRepoStore tests: the read-only RepoSession port. Covers the
 * applyWireState sink + cascade, the fetch-free active-file selection
 * and its re-anchoring, wire decoding, compare-422, the read-only
 * compare base pick, the single-flight reconnect loop, and the
 * per-file working-diff cache (auto-activation on the first snapshot,
 * hybrid whole-tree/per-file fetch, changed-set refetch, identity
 * preservation, seq stale-guards), the on-demand image metadata
 * (once per key, per-key invalidation on state-change, repo-switch
 * reset, failures collapsing into shared.error), the journal slice (lazy load,
 * SSE append with seq dedupe + epoch guard, reconnect resync floored
 * on the synced watermark, epoch/prunedBefore reset handling,
 * repo-switch reset), and the pagehide unload release (keepalive
 * DELETE). Driven entirely by a stubbed fetch
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
import type { JournalHunkEntry } from '@diffstalker/core/types/journal';
import { parseDiffWithLineNumbers, rawFromLines } from '@diffstalker/core/git/diffParse';
import type { WorkingDiffEntry } from './repo';

/**
 * A wire diff body. The wire carries LINES only — the raw text used to be
 * duplicated alongside them, so these fakes parse it the way the daemon
 * does.
 */
function diffBody(raw: string): { lines: ReturnType<typeof parseDiffWithLineNumbers> } {
  return { lines: parseDiffWithLineNumbers(raw) };
}

/** The diff text a cache entry represents. */
function rawOf(entry: WorkingDiffEntry): string {
  return rawFromLines(entry.diff.lines);
}

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

/** A wire journal hunk entry (JSON-native — survives the fake fetch). */
function jhunk(seq: number, overrides: Partial<JournalHunkEntry> = {}): JournalHunkEntry {
  return {
    type: 'hunk',
    seq,
    ts: seq * 1000,
    path: 'a.ts',
    status: 'modified' as FileStatus,
    kind: 'edited',
    span: { start: 1, count: 1 },
    stats: { insertions: 1, deletions: 0 },
    diff: null,
    supersedes: [],
    siblings: 1,
    seeded: false,
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
        diff: diffBody('compare-file-diff'),
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
    return { body: diffBody(`diff:${url}`) };
  }
  if (url.startsWith('/repos/r1/media')) {
    // One picture on the new side; enough to key and render from.
    return {
      body: {
        old: null,
        new: {
          path: 'img.png',
          side: 'worktree',
          bytes: 2048,
          oid: null,
          version: 'v1',
          image: { format: 'png', mime: 'image/png', width: 8, height: 8, bytes: 2048 },
          refusal: null,
        },
      },
    };
  }
  if (url.startsWith('/repos/r1/history')) {
    return { body: [{ hash: 'h1', message: 'm', author: 'a', date: '2026-07-01T00:00:00.000Z' }] };
  }
  if (url.startsWith('/repos/r1/commits/')) {
    return { body: diffBody(`commit-diff:${url}`) };
  }
  // Before the /compare prefix below, which would otherwise swallow it.
  if (url.startsWith('/repos/r1/compare/count')) {
    return { body: { baseBranch: 'origin/main', commits: 3 } };
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

  test('a refused open leaves the open repo intact — id, path, state and stream', async () => {
    const { store, source } = await openStore([fileEntry('a.ts')]);
    onRequest = (call) =>
      call.method === 'POST' && call.url === '/repos'
        ? { status: 400, body: { error: 'Not a git repository' } }
        : undefined;

    await store.open('/not-a-repo');

    // Nothing moved: the repo on screen is still the open one.
    expect(store.repoId).toBe('r1');
    expect(store.repoPath).toBe('/repo');
    expect(store.shared.status?.files).toHaveLength(1);
    expect(store.shared.error).toBe('Not a git repository');
    // ...and it is still streaming, so it keeps updating.
    expect(FakeEventSource.instances).toHaveLength(1);
    source.emit('state-change', wireState([fileEntry('a.ts'), fileEntry('b.ts')]));
    await flush();
    expect(store.shared.status?.files).toHaveLength(2);
  });

  test('an unreachable daemon mid-open commits to the requested path', async () => {
    const { store } = await openStore([fileEntry('a.ts')]);
    onRequest = (call) => {
      if (call.method === 'POST' && call.url === '/repos') throw new TypeError('Failed to fetch');
      return undefined;
    };

    await store.open('/other');

    // The requested repo is what recovery must retry — not the one left.
    expect(store.repoId).toBeNull();
    expect(store.repoPath).toBe('/other');
    expect(store.shared.error).toBe(CONNECTION_LOST_MESSAGE);
    // The repo being left is gone from the store, not half-shown.
    expect(store.shared.status).toBeNull();
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
      if (call.url === '/repos/r1/diff') return { body: diffBody(rawA) };
      if (call.url === '/repos/r1/diff?staged=true') return { body: diffBody(rawB) };
      if (call.url === '/repos/r1/diff?path=u.txt') return { body: diffBody(rawU) };
      return undefined;
    };

    // No explicit refreshAllDiffs: the snapshot inside openStore is the trigger.
    const { store } = await openStore([a, b, u]);

    const byKey = store.workingDiffs.byKey;
    expect([...byKey.keys()].sort()).toEqual(['s:b.ts', 'u:a.ts', 'u:u.txt']);
    expect(rawOf(byKey.get('u:a.ts')!)).toBe(rawA);
    expect(rawOf(byKey.get('s:b.ts')!)).toBe(rawB);
    expect(rawOf(byKey.get('u:u.txt')!)).toBe(rawU);
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
      if (call.url === '/repos/r1/diff?staged=true') return { body: diffBody('') };
      if (call.url === '/repos/r1/diff?path=a.ts&staged=false') {
        return { body: diffBody(rawFresh) };
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

    heldTree.resolve({ body: diffBody(rawStale) }); // the STALE tree lands
    await flush();
    await advance(25); // the post-pull re-diff's refetch debounce
    expect(rawOf(store.workingDiffs.byKey.get('u:a.ts')!)).toBe(rawFresh);
  });

  test('a failed activation retries QUIETLY on the next state-change instead of staying empty', async () => {
    let broken = true;
    const rawA = fileDiffRaw('a.ts', 'A');
    onRequest = (call) => {
      if (!call.url.startsWith('/repos/r1/diff')) return undefined;
      if (broken) return { status: 500, body: { error: 'boom' } };
      if (call.url === '/repos/r1/diff') return { body: diffBody(rawA) };
      return { body: diffBody('') };
    };
    const { store, source } = await openStore([fileEntry('a.ts')]);
    // Passive warm-up: the failure must not overwrite the wire error line.
    expect(store.shared.error).toBeNull();
    expect(store.workingDiffs.byKey.size).toBe(0);

    broken = false;
    source.emit('state-change', wireState([fileEntry('a.ts')]));
    await flush();
    expect(rawOf(store.workingDiffs.byKey.get('u:a.ts')!)).toBe(rawA);
  });

  test('an EXPLICIT refreshAllDiffs surfaces its failure in shared.error', async () => {
    const { store } = await openStore([fileEntry('a.ts')]);
    onRequest = (call) =>
      call.url.startsWith('/repos/r1/diff') ? { status: 500, body: { error: 'boom' } } : undefined;

    await store.refreshAllDiffs();
    expect(store.shared.error).toBe('Failed to load diffs: boom');
  });

  test('untracked per-file fetches run through a concurrency-6 queue', async () => {
    const files = Array.from({ length: 8 }, (_, i) =>
      fileEntry(`u${i}.txt`, { status: 'untracked' as FileStatus })
    );
    const held: Deferred<FakeResponse>[] = [];
    onRequest = (call) => {
      if (call.url === '/repos/r1/diff') return { body: diffBody('') };
      if (call.url === '/repos/r1/diff?staged=true') return { body: diffBody('') };
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

    held[0].resolve({ body: diffBody(fileDiffRaw('u0.txt', '0')) });
    await flush();
    expect(pathCalls()).toHaveLength(7); // a freed worker picked up the 7th

    let resolved = 1;
    while (resolved < 8) {
      await flush();
      while (resolved < held.length) {
        held[resolved].resolve({ body: diffBody('') });
        resolved += 1;
      }
    }
    await flush();
    expect(pathCalls()).toHaveLength(8);
    expect(rawOf(store.workingDiffs.byKey.get('u:u0.txt')!)).toBe(fileDiffRaw('u0.txt', '0'));
  });

  test('identity preservation: an unchanged raw keeps the SAME DiffResult object and model', async () => {
    const rawA = fileDiffRaw('a.ts', 'A');
    onRequest = (call) => {
      if (call.url === '/repos/r1/diff') return { body: diffBody(rawA) };
      if (call.url === '/repos/r1/diff?staged=true') return { body: diffBody('') };
      if (call.url === '/repos/r1/diff?path=a.ts&staged=false') {
        return { body: diffBody(rawA) };
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
      if (call.url === '/repos/r1/diff') return { body: diffBody(aVersion + rawB) };
      if (call.url === '/repos/r1/diff?staged=true') return { body: diffBody('') };
      if (call.url === '/repos/r1/diff?path=a.ts&staged=false') {
        return { body: diffBody(aVersion) };
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
    expect(rawOf(store.workingDiffs.byKey.get('u:a.ts')!)).toBe(rawA2);
    expect(store.workingDiffs.byKey.get('u:b.ts')!.diff).toBe(bBefore);
  });

  test('a changed set past 15 files falls back to ONE whole-tree re-pull', async () => {
    const files = Array.from({ length: 16 }, (_, i) => fileEntry(`f${i}.ts`));
    const whole = files.map((f) => fileDiffRaw(f.path, f.path)).join('');
    onRequest = (call) => {
      if (call.url === '/repos/r1/diff') return { body: diffBody(whole) };
      if (call.url === '/repos/r1/diff?staged=true') return { body: diffBody('') };
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
      if (call.url === '/repos/r1/diff') return { body: diffBody(v1) };
      if (call.url === '/repos/r1/diff?staged=true') return { body: diffBody('') };
      if (call.url === '/repos/r1/diff?path=a.ts&staged=false') {
        pathHits += 1;
        return pathHits === 1 ? slow.promise : { body: diffBody(v3) };
      }
      return undefined;
    };
    const { store, source } = await openStore([fileEntry('a.ts')]);

    source.emit('state-change', wireState([fileEntry('a.ts')], { mtimes: { 'a.ts': 2 } }));
    await advance(25); // refetch 1 fires — withheld
    source.emit('state-change', wireState([fileEntry('a.ts')], { mtimes: { 'a.ts': 3 } }));
    await advance(25); // refetch 2 fires — lands v3
    expect(rawOf(store.workingDiffs.byKey.get('u:a.ts')!)).toBe(v3);

    slow.resolve({ body: diffBody(v2) }); // refetch 1 lands LAST
    await flush();
    expect(rawOf(store.workingDiffs.byKey.get('u:a.ts')!)).toBe(v3); // not clobbered
  });

  test('files leaving the status set are evicted; entering files are fetched', async () => {
    const rawA = fileDiffRaw('a.ts', 'A');
    const rawB = fileDiffRaw('b.ts', 'B');
    onRequest = (call) => {
      if (call.url === '/repos/r1/diff') return { body: diffBody(rawA) };
      if (call.url === '/repos/r1/diff?staged=true') return { body: diffBody('') };
      if (call.url === '/repos/r1/diff?path=b.ts&staged=false') {
        return { body: diffBody(rawB) };
      }
      return undefined;
    };
    const { store, source } = await openStore([fileEntry('a.ts')]);
    expect([...store.workingDiffs.byKey.keys()]).toEqual(['u:a.ts']);

    source.emit('state-change', wireState([fileEntry('b.ts')]));
    await advance(25);
    expect(store.workingDiffs.byKey.has('u:a.ts')).toBe(false);
    expect(rawOf(store.workingDiffs.byKey.get('u:b.ts')!)).toBe(rawB);
  });

  test('open() resets the cache; the new repo activates on ITS first snapshot', async () => {
    const rawA = fileDiffRaw('a.ts', 'A');
    const rawA9 = fileDiffRaw('a.ts', 'A9');
    let version = rawA;
    onRequest = (call) => {
      if (call.url === '/repos/r1/diff') return { body: diffBody(version) };
      if (call.url === '/repos/r1/diff?staged=true') return { body: diffBody('') };
      return undefined;
    };
    const { store } = await openStore([fileEntry('a.ts')]);
    expect(rawOf(store.workingDiffs.byKey.get('u:a.ts')!)).toBe(rawA);
    const firstEntry = store.workingDiffs.byKey.get('u:a.ts')!;

    version = rawA9;
    await store.open('/repo');
    // The reset is immediate; the fresh pull waits for the new snapshot.
    expect(store.workingDiffs.byKey.size).toBe(0);
    expect(store.workingDiffs.seq).toBe(0);

    const source = FakeEventSource.latest();
    source.emit('snapshot', wireState([fileEntry('a.ts')], { mtimes: { 'a.ts': 9 } }));
    await flush();
    expect(rawOf(store.workingDiffs.byKey.get('u:a.ts')!)).toBe(rawA9);
    expect(store.workingDiffs.byKey.get('u:a.ts')).not.toBe(firstEntry);
  });
});

// --- Image metadata ---

describe('image metadata (mediaMeta)', () => {
  const png = fileEntry('img.png');

  function mediaCalls(): string[] {
    return fake.callsTo('/repos/r1/media').map((call) => call.url);
  }

  test('ensureMedia lands one pair per row key, and asks only once', async () => {
    const { store } = await openStore([png]);

    await store.ensureMedia(png, false);
    expect(mediaCalls()).toEqual(['/repos/r1/media?path=img.png&staged=0']);
    // Keyed exactly like workingDiffs: the side prefix is part of it.
    expect(store.mediaMeta.get('u:img.png')!.new!.path).toBe('img.png');

    // A second look at the same section costs nothing.
    await store.ensureMedia(png, false);
    expect(mediaCalls()).toHaveLength(1);
  });

  test('the staged side is its own key and its own request', async () => {
    const staged = fileEntry('img.png', { staged: true });
    const { store } = await openStore([png, staged]);

    await store.ensureMedia(png, false);
    await store.ensureMedia(staged, true);

    expect(mediaCalls()).toEqual([
      '/repos/r1/media?path=img.png&staged=0',
      '/repos/r1/media?path=img.png&staged=1',
    ]);
    expect([...store.mediaMeta.keys()]).toEqual(['u:img.png', 's:img.png']);
  });

  test('a state-change that touches the file re-asks — the worktree side is mutable', async () => {
    const { store, source } = await openStore([png]);
    await store.ensureMedia(png, false);
    const first = store.mediaMeta.get('u:img.png');

    source.emit('state-change', wireState([png], { mtimes: { 'img.png': 42 } }));
    await flush();
    // The card keeps its picture while the new answer is on the way:
    // blanking it would move every section below it twice for one edit.
    expect(store.mediaMeta.get('u:img.png')).toBe(first);

    await store.ensureMedia(png, false);
    expect(mediaCalls()).toHaveLength(2);
  });

  test('an untouched file is not re-asked on a state-change', async () => {
    const { store, source } = await openStore([png]);
    await store.ensureMedia(png, false);

    source.emit('state-change', wireState([png]));
    await flush();
    await store.ensureMedia(png, false);
    expect(mediaCalls()).toHaveLength(1);
  });

  test('a file leaving the status set loses its entry', async () => {
    const { store, source } = await openStore([png]);
    await store.ensureMedia(png, false);
    expect(store.mediaMeta.size).toBe(1);

    source.emit('state-change', wireState([]));
    await flush();
    expect(store.mediaMeta.size).toBe(0);

    // And it is asked about again if it comes back.
    source.emit('state-change', wireState([png]));
    await flush();
    await store.ensureMedia(png, false);
    expect(mediaCalls()).toHaveLength(2);
  });

  test('a repo switch clears the cache — no verdict is inherited by path', async () => {
    const { store } = await openStore([png]);
    await store.ensureMedia(png, false);
    expect(store.mediaMeta.size).toBe(1);

    onRequest = (call) => {
      if (call.method === 'POST' && call.url === '/repos') {
        return { body: { id: 'r2', path: (call.body as { path: string }).path } };
      }
      return call.url.startsWith('/repos/r2/') ? { body: wireState() } : undefined;
    };
    await store.open('/repo2');
    expect(store.mediaMeta.size).toBe(0);
  });

  test('a daemon failure lands in shared.error and never throws', async () => {
    const { store } = await openStore([png]);
    onRequest = (call) =>
      call.url.startsWith('/repos/r1/media')
        ? { status: 400, body: { error: 'Not a regular file' } }
        : undefined;

    await expect(store.ensureMedia(png, false)).resolves.toBeUndefined();
    expect(store.shared.error).toBe('Failed to load image metadata: Not a regular file');
    expect(store.mediaMeta.size).toBe(0);

    // The gate dropped with the failure, so looking again retries.
    onRequest = null;
    await store.ensureMedia(png, false);
    expect(store.mediaMeta.size).toBe(1);
  });

  test('a lost connection collapses into the one reconnect line', async () => {
    const { store } = await openStore([png]);
    onRequest = (call) => {
      if (call.url.startsWith('/repos/r1/media')) throw new TypeError('Failed to fetch');
      return undefined;
    };

    await store.ensureMedia(png, false);
    expect(store.shared.error).toBe(CONNECTION_LOST_MESSAGE);
    expect(store.mediaMeta.size).toBe(0);
  });

  test('nothing is asked for before a repo is open', async () => {
    const store = useRepoStore();
    await store.ensureMedia(png, false);
    expect(fake.callsTo('/media')).toHaveLength(0);
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
    slow.resolve({ body: diffBody('stale commit diff') });
    await selectPromise;
    expect(store.history.commitDiff).toBeNull();
  });
});

// --- Journal ---

describe('journal', () => {
  /** Seed a loaded journal slice: entries 1-2, epoch 'e7', no pruning. */
  function journalRoutes(call: FetchCall): FakeResponse | undefined {
    if (call.url === '/repos/r1/journal') {
      return { body: { epoch: 'e7', prunedBefore: 0, entries: [jhunk(1), jhunk(2)] } };
    }
    return undefined;
  }

  function journalSeqs(store: ReturnType<typeof useRepoStore>): number[] {
    return store.journalEntries.map((e) => e.seq);
  }

  test('loadJournal is lazy: one GET seeds the slice, a second call refetches nothing', async () => {
    onRequest = journalRoutes;
    const { store } = await openStore();
    expect(store.journalLoaded).toBe(false);

    await store.loadJournal();
    expect(store.journalLoaded).toBe(true);
    expect(store.journalEpoch).toBe('e7');
    expect(store.journalPrunedBefore).toBe(0);
    expect(journalSeqs(store)).toEqual([1, 2]);

    await store.loadJournal();
    expect(fake.callsTo('/journal')).toHaveLength(1);
  });

  test('journal-append SSE appends in seq order and dedupes by seq', async () => {
    onRequest = journalRoutes;
    const { store, source } = await openStore();
    await store.loadJournal();

    source.emit('journal-append', { epoch: 'e7', entries: [jhunk(3)] });
    expect(journalSeqs(store)).toEqual([1, 2, 3]);

    // A replayed batch is ignored; a mixed batch applies only the new tail.
    source.emit('journal-append', { epoch: 'e7', entries: [jhunk(3)] });
    expect(journalSeqs(store)).toEqual([1, 2, 3]);
    source.emit('journal-append', { epoch: 'e7', entries: [jhunk(3), jhunk(4)] });
    expect(journalSeqs(store)).toEqual([1, 2, 3, 4]);
  });

  test('an append racing the initial GET is merged, not lost', async () => {
    const held = new Deferred<FakeResponse>();
    onRequest = (call) => (call.url === '/repos/r1/journal' ? held.promise : undefined);
    const { store, source } = await openStore();

    const load = store.loadJournal();
    await flush(); // the GET is in flight
    source.emit('journal-append', { epoch: 'e7', entries: [jhunk(3)] });

    // The snapshot predates the append: the load must union by seq.
    held.resolve({ body: { epoch: 'e7', prunedBefore: 0, entries: [jhunk(1), jhunk(2)] } });
    await load;
    expect(store.journalLoaded).toBe(true);
    expect(journalSeqs(store)).toEqual([1, 2, 3]);
  });

  test('a daemon error rejects to the caller; a later call may retry', async () => {
    onRequest = (call) =>
      call.url === '/repos/r1/journal' ? { status: 500, body: { error: 'boom' } } : undefined;
    const { store } = await openStore();

    await expect(store.loadJournal()).rejects.toThrow('boom');
    expect(store.journalLoaded).toBe(false);

    // The in-flight guard was released: the next visit retries.
    onRequest = journalRoutes;
    await store.loadJournal();
    expect(store.journalLoaded).toBe(true);
    expect(journalSeqs(store)).toEqual([1, 2]);
  });

  test('reconnect refetches ?since=<synced watermark> and applies the tail', async () => {
    onRequest = (call) => {
      if (call.url === '/repos/r1/journal?since=2') {
        return { body: { epoch: 'e7', prunedBefore: 0, entries: [jhunk(3)] } };
      }
      return journalRoutes(call);
    };
    const { store, source } = await openStore();
    await store.loadJournal();

    source.fail();
    await advance(1000);
    expect(fake.callsTo('/journal').map((c) => c.url)).toEqual([
      '/repos/r1/journal',
      '/repos/r1/journal?since=2',
    ]);
    expect(journalSeqs(store)).toEqual([1, 2, 3]);
    expect(store.journalRestarted).toBe(false);
  });

  test('an append racing the post-reconnect resync is neither lost nor doubled', async () => {
    const heldResync = new Deferred<FakeResponse>();
    onRequest = (call) => {
      if (call.url === '/repos/r1/journal?since=2') return heldResync.promise;
      return journalRoutes(call);
    };
    const { store, source } = await openStore();
    await store.loadJournal();

    // seq 3 was appended while the stream was down (the client never saw
    // its event); seq 4 lands on the NEW stream right after resubscribe,
    // BEFORE the resync fetch answers — advancing the tail past the gap.
    source.fail();
    await advance(1000); // recovery: re-POST, resubscribe, resync in flight
    FakeEventSource.latest().emit('journal-append', { epoch: 'e7', entries: [jhunk(4)] });
    expect(journalSeqs(store)).toEqual([1, 2, 4]); // the hole, pre-resync

    // The resync floors on the watermark (2, the last successful fetch's
    // tail), never the live tail (4): the missed seq 3 comes back and
    // the racing seq 4 dedupes by seq — exactly once each.
    heldResync.resolve({
      body: { epoch: 'e7', prunedBefore: 0, entries: [jhunk(3), jhunk(4)] },
    });
    await flush();
    expect(fake.callsTo('/journal').map((c) => c.url)).toEqual([
      '/repos/r1/journal',
      '/repos/r1/journal?since=2',
    ]);
    expect(journalSeqs(store)).toEqual([1, 2, 3, 4]);
    expect(store.journalRestarted).toBe(false);
  });

  test('an epoch change on reconnect discards the cache and refetches from scratch', async () => {
    let journalGets = 0;
    onRequest = (call) => {
      if (call.url === '/repos/r1/journal?since=2') {
        // A restarted daemon minted a new store: fresh epoch, fresh seq
        // space — the since-slice is meaningless.
        return { body: { epoch: 'e8', prunedBefore: 0, entries: [] } };
      }
      if (call.url === '/repos/r1/journal') {
        journalGets += 1;
        return journalGets === 1
          ? { body: { epoch: 'e7', prunedBefore: 0, entries: [jhunk(1), jhunk(2)] } }
          : { body: { epoch: 'e8', prunedBefore: 0, entries: [jhunk(1, { path: 'fresh.ts' })] } };
      }
      return undefined;
    };
    const { store, source } = await openStore();
    await store.loadJournal();

    source.fail();
    await advance(1000);
    expect(store.journalEpoch).toBe('e8');
    expect(journalSeqs(store)).toEqual([1]);
    expect(store.journalEntries[0]).toMatchObject({ path: 'fresh.ts' });
    expect(store.journalRestarted).toBe(true); // the view shows a divider
  });

  test('a pruned gap on reconnect (prunedBefore past our tail) also refetches from scratch', async () => {
    let journalGets = 0;
    onRequest = (call) => {
      if (call.url === '/repos/r1/journal?since=2') {
        return { body: { epoch: 'e7', prunedBefore: 6, entries: [jhunk(7)] } };
      }
      if (call.url === '/repos/r1/journal') {
        journalGets += 1;
        return journalGets === 1
          ? { body: { epoch: 'e7', prunedBefore: 0, entries: [jhunk(1), jhunk(2)] } }
          : { body: { epoch: 'e7', prunedBefore: 6, entries: [jhunk(6), jhunk(7)] } };
      }
      return undefined;
    };
    const { store, source } = await openStore();
    await store.loadJournal();

    source.fail();
    await advance(1000);
    // No silent hole between 2 and 6: the log was replaced wholesale.
    expect(journalSeqs(store)).toEqual([6, 7]);
    expect(store.journalPrunedBefore).toBe(6);
    expect(store.journalRestarted).toBe(true);
  });

  test('never loaded: reconnect fetches nothing and drops the pre-load accumulation', async () => {
    const { store, source } = await openStore();
    // Appends land even before the first load (they may race a load)...
    source.emit('journal-append', { epoch: 'e7', entries: [jhunk(5)] });
    expect(journalSeqs(store)).toEqual([5]);

    // ...but a reconnect discards them: they may predate a daemon
    // restart, and the lazy load refetches everything anyway.
    source.fail();
    await advance(1000);
    expect(fake.callsTo('/journal')).toHaveLength(0);
    expect(journalSeqs(store)).toEqual([]);
    expect(store.journalLoaded).toBe(false);
  });

  test('open() resets the slice like the other per-repo state', async () => {
    onRequest = journalRoutes;
    const { store } = await openStore();
    await store.loadJournal();
    expect(store.journalLoaded).toBe(true);

    onRequest = null;
    await store.open('/repo');
    expect(store.journalLoaded).toBe(false);
    expect(store.journalEpoch).toBeNull();
    expect(journalSeqs(store)).toEqual([]);
    expect(store.journalRestarted).toBe(false);
  });

  test('an interrupted resync keeps the watermark: the retry re-covers the gap', async () => {
    // Disconnect with seqs 3..4 missed; recovery #1's resync is
    // interrupted (connection drops again) AFTER live appends pushed
    // the tail to 6. A tail-floored retry would resync since=6 and
    // lose 3..4 forever; the watermark keeps the floor at 2.
    const heldResync = new Deferred<FakeResponse>();
    let sinceCalls = 0;
    onRequest = (call) => {
      if (call.url === '/repos/r1/journal?since=2') {
        sinceCalls += 1;
        if (sinceCalls === 1) return heldResync.promise;
        return { body: { epoch: 'e7', prunedBefore: 0, entries: [jhunk(3), jhunk(4), jhunk(5), jhunk(6)] } };
      }
      return journalRoutes(call);
    };
    const { store, source } = await openStore();
    await store.loadJournal(); // watermark: 2

    source.fail();
    await advance(1000); // recovery #1: resubscribed, resync ?since=2 in flight
    // Live appends on the fresh stream advance the tail past the gap.
    FakeEventSource.latest().emit('journal-append', { epoch: 'e7', entries: [jhunk(5)] });
    FakeEventSource.latest().emit('journal-append', { epoch: 'e7', entries: [jhunk(6)] });
    expect(journalSeqs(store)).toEqual([1, 2, 5, 6]); // the hole, mid-recovery

    // The resync fetch dies (second disconnect): the watermark must
    // NOT move — only successful fetches advance it.
    heldResync.reject(new TypeError('Failed to fetch'));
    await flush();
    expect(store.shared.error).toBe(CONNECTION_LOST_MESSAGE);

    // Recovery #2 resyncs from the SAME floor and closes the gap.
    await advance(1000);
    expect(fake.callsTo('/journal').map((c) => c.url)).toEqual([
      '/repos/r1/journal',
      '/repos/r1/journal?since=2',
      '/repos/r1/journal?since=2',
    ]);
    expect(journalSeqs(store)).toEqual([1, 2, 3, 4, 5, 6]); // contiguous, no hole
    expect(store.journalRestarted).toBe(false);
  });

  test('a mismatched-epoch append is never spliced in: full refetch, parked batch merged', async () => {
    let journalGets = 0;
    onRequest = (call) => {
      if (call.url === '/repos/r1/journal') {
        journalGets += 1;
        return journalGets === 1
          ? { body: { epoch: 'e7', prunedBefore: 0, entries: [jhunk(1), jhunk(2)] } }
          : { body: { epoch: 'e8', prunedBefore: 0, entries: [jhunk(1, { path: 'fresh.ts' })] } };
      }
      return undefined;
    };
    const { store, source } = await openStore();
    await store.loadJournal();
    expect(store.journalEpoch).toBe('e7');

    // The daemon store reset under a live stream: the batch belongs to
    // e8's seq space. Synchronously NOTHING is appended (no e7/e8
    // interleave); the batch is parked while the full refetch runs.
    source.emit('journal-append', { epoch: 'e8', entries: [jhunk(2, { path: 'later.ts' })] });
    expect(store.journalEntries.map((e) => (e as JournalHunkEntry).path)).toEqual(['a.ts', 'a.ts']);

    await flush();
    // Refetched wholesale from the new store, parked batch merged by seq.
    expect(store.journalEpoch).toBe('e8');
    expect(journalSeqs(store)).toEqual([1, 2]);
    expect(store.journalEntries.map((e) => (e as JournalHunkEntry).path)).toEqual([
      'fresh.ts',
      'later.ts',
    ]);
    expect(store.journalRestarted).toBe(true);
  });

  test('a mismatched-epoch batch arriving during an in-flight resync is not stranded', async () => {
    const heldResync = new Deferred<FakeResponse>();
    let journalGets = 0;
    onRequest = (call) => {
      if (call.url === '/repos/r1/journal?since=2') return heldResync.promise;
      if (call.url === '/repos/r1/journal') {
        journalGets += 1;
        return journalGets === 1
          ? { body: { epoch: 'e7', prunedBefore: 0, entries: [jhunk(1), jhunk(2)] } }
          : { body: { epoch: 'e8', prunedBefore: 0, entries: [jhunk(1, { path: 'fresh.ts' })] } };
      }
      return undefined;
    };
    const { store, source } = await openStore();
    await store.loadJournal();

    source.fail();
    await advance(1000); // recovery: resync ?since=2 in flight
    // The daemon store resets under the fresh stream: a batch from the
    // NEW epoch arrives while the resync holds the pull flag, so its own
    // from-scratch refetch early-returns and the batch is parked.
    FakeEventSource.latest().emit('journal-append', {
      epoch: 'e8',
      entries: [jhunk(2, { path: 'later.ts' })],
    });
    expect(store.journalEpoch).toBe('e7'); // nothing spliced across epochs

    // The resync answers from the OLD store (built before the reset):
    // same epoch, no wholesale path — without the post-release kick the
    // parked e8 batch would be stranded forever.
    heldResync.resolve({ body: { epoch: 'e7', prunedBefore: 0, entries: [] } });
    await flush();
    expect(store.journalEpoch).toBe('e8');
    expect(journalSeqs(store)).toEqual([1, 2]);
    expect(store.journalEntries.map((e) => (e as JournalHunkEntry).path)).toEqual([
      'fresh.ts',
      'later.ts',
    ]);
    expect(store.journalRestarted).toBe(true);
  });

  test('pre-load accumulation never interleaves epochs', async () => {
    const { store, source } = await openStore();
    // Batches from store eA accumulate...
    source.emit('journal-append', { epoch: 'eA', entries: [jhunk(5)] });
    expect(journalSeqs(store)).toEqual([5]);
    // ...until a batch from a reset store eB replaces them outright.
    source.emit('journal-append', { epoch: 'eB', entries: [jhunk(7)] });
    expect(journalSeqs(store)).toEqual([7]);

    // The lazy load answers from yet another store: the eB accumulation
    // is discarded too — the snapshot alone is the truth.
    onRequest = journalRoutes; // epoch e7, entries 1..2
    await store.loadJournal();
    expect(store.journalEpoch).toBe('e7');
    expect(journalSeqs(store)).toEqual([1, 2]);
  });
});

// --- Unload release ---

describe('releaseOnUnload', () => {
  test('fires one keepalive DELETE for the held ref; idempotent after that', async () => {
    const { store } = await openStore();
    const deletesBefore = fake.calls.filter((c) => c.method === 'DELETE').length;

    store.releaseOnUnload();
    const deletes = fake.calls.filter((c) => c.method === 'DELETE');
    expect(deletes.length).toBe(deletesBefore + 1);
    expect(deletes.at(-1)!.url).toBe('/repos/r1');

    // The held ref is cleared: a second pagehide (bfcache round trip
    // without a re-acquire) must not double-release.
    store.releaseOnUnload();
    expect(fake.calls.filter((c) => c.method === 'DELETE').length).toBe(deletesBefore + 1);
  });

  test('no repo held: a no-op', async () => {
    const store = useRepoStore();
    store.releaseOnUnload();
    expect(fake.calls.filter((c) => c.method === 'DELETE')).toEqual([]);
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

  test('the commit count is pulled on the first snapshot, before compare is ever opened', async () => {
    // The whole point of the standalone count: the rail can badge the tab
    // without anyone visiting the view.
    const { store } = await openStore();
    expect(fake.callsTo('/repos/r1/compare/count')).toHaveLength(1);
    expect(store.compare.commitCount).toBe(3);
    // ...and without dragging the heavy payload along.
    expect(fake.callsTo('/repos/r1/compare?')).toHaveLength(0);
  });

  test('the count re-pulls on state-change while compare stays closed', async () => {
    const { store, source } = await openStore();
    source.emit('state-change', wireState());
    await flush();
    expect(fake.callsTo('/repos/r1/compare/count')).toHaveLength(2);
    expect(store.compare.commitCount).toBe(3);
  });

  test('once compare is open the full refresh carries the count, with no extra pull', async () => {
    const { store, source } = await openStore();
    const countCallsBefore = fake.callsTo('/repos/r1/compare/count').length;

    await store.refreshCompare();
    // compareBody() lists one commit; the badge must follow the list it
    // labels, not the standalone endpoint's 3.
    expect(store.compare.commitCount).toBe(1);

    source.emit('state-change', wireState());
    await flush();
    expect(store.compare.commitCount).toBe(1);
    expect(fake.callsTo('/repos/r1/compare/count')).toHaveLength(countCallsBefore);
  });

  test('a 422 on the count clears it rather than badging a misleading 0', async () => {
    const { store } = await openStore();
    expect(store.compare.commitCount).toBe(3);

    onRequest = (call) =>
      call.url.startsWith('/repos/r1/compare/count')
        ? { status: 422, body: { error: 'No usable base branch' } }
        : undefined;
    await store.refreshCompareCount();
    expect(store.compare.commitCount).toBeNull();
  });

  test('a transient count failure keeps the last known number', async () => {
    const { store } = await openStore();
    expect(store.compare.commitCount).toBe(3);

    onRequest = (call) =>
      call.url.startsWith('/repos/r1/compare/count')
        ? { status: 500, body: { error: 'git exploded' } }
        : undefined;
    await store.refreshCompareCount();
    // A badge blinking out on a blip is worse than one that lags.
    expect(store.compare.commitCount).toBe(3);
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
    // '/compare?' and not '/compare': the standalone count endpoint shares
    // the prefix, and these assertions are about the diff pulls only.
    expect(fake.callsTo('/compare?')[0].url).toBe('/repos/r1/compare?uncommitted=true');

    source.emit('state-change', wireState());
    await flush();
    expect(fake.callsTo('/compare?')).toHaveLength(2);
    expect(fake.callsTo('/compare?')[1].url).toBe('/repos/r1/compare?uncommitted=true');
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
        diff: diffBody('b-diff'),
      },
      ...reordered.files,
    ];
    onRequest = (call) =>
      call.url.startsWith('/repos/r1/compare') ? { body: reordered } : undefined;
    await store.refreshCompare();
    expect(store.compare.selection).toMatchObject({ type: 'file', index: 1 });
    expect(rawFromLines(store.compare.selection.diff!.lines)).toContain('compare-file-diff');

    // a.ts vanishes: the selection clears instead of pointing elsewhere.
    const without = compareBody() as { files: unknown[] };
    without.files = [
      {
        path: 'b.ts',
        status: 'added',
        additions: 1,
        deletions: 0,
        diff: diffBody('b-diff'),
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
    expect(fake.callsTo('/compare?')[0]).toMatchObject({
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
      diff: diffBody('compare-file-diff'),
    });

    store.selectCompareFile(99);
    expect(store.compare.selection).toEqual({ type: null, index: 0, diff: null });
  });

  test('the picked base rides every later refresh, including the state-change re-pull', async () => {
    const { store, source } = await openStore();
    await store.setSelectedCompareBase('origin/dev', true);

    source.emit('state-change', wireState());
    await flush();
    const urls = fake.callsTo('/compare?').map((c) => c.url);
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
    expect(rawFromLines(store.compare.selection.diff!.lines)).toContain('commit-diff:');
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

// --- Working-tree mutations (file-level stage / unstage) ---

describe('stageFile / unstageFile', () => {
  test('stageFile POSTs /stage with the path; the SSE state-change updates the view', async () => {
    onRequest = (call) => {
      if (call.method === 'POST' && call.url === '/repos/r1/stage') {
        return { body: { state: wireState([]) } };
      }
      return undefined;
    };
    const { store, source } = await openStore([
      { path: 'a.ts', status: 'modified', staged: false },
    ]);

    await store.stageFile('a.ts');
    await flush();

    const posts = fake.callsTo('/repos/r1/stage');
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toEqual({ path: 'a.ts' });
    // The view updates from the daemon's SSE state-change (its single state
    // source), NOT the POST body — so a slow response can't regress it.
    expect(store.shared.status?.files[0].staged).toBe(false);
    source.emit('state-change', wireState([{ path: 'a.ts', status: 'modified', staged: true }]));
    await flush();
    expect(store.shared.status?.files[0].staged).toBe(true);
  });

  test('unstageFile POSTs /unstage with the path', async () => {
    onRequest = (call) => {
      if (call.method === 'POST' && call.url === '/repos/r1/unstage') {
        return { body: { state: wireState([]) } };
      }
      return undefined;
    };
    const { store } = await openStore([{ path: 'a.ts', status: 'modified', staged: true }]);

    await store.unstageFile('a.ts');
    await flush();

    const posts = fake.callsTo('/repos/r1/unstage');
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toEqual({ path: 'a.ts' });
  });

  test('a git error from the daemon surfaces in shared.error and never throws', async () => {
    onRequest = (call) => {
      if (call.method === 'POST' && call.url === '/repos/r1/stage') {
        return { status: 500, body: { error: 'fatal: pathspec did not match any files' } };
      }
      return undefined;
    };
    const { store } = await openStore([{ path: 'a.ts', status: 'modified', staged: false }]);

    await expect(store.stageFile('a.ts')).resolves.toBeUndefined();
    await flush();
    expect(store.shared.error).toContain('pathspec');
    // The line names the attempt: it may outlive the state-change that
    // follows it, and a bare git message would then read as a claim
    // about the repo rather than about one click.
    expect(store.shared.error).toBe(
      'Could not stage a.ts: fatal: pathspec did not match any files'
    );
  });

  test('with no repo open, stageFile is a no-op (no request)', async () => {
    const store = useRepoStore();
    await store.stageFile('a.ts');
    await flush();
    expect(fake.callsTo('/repos/r1/stage')).toHaveLength(0);
  });
});

// --- A refused mutation is STICKY ---

/** Refuse every stage/unstage POST with `reason`. */
function refuseMutations(reason: string): void {
  onRequest = (call) => {
    if (call.method === 'POST' && /\/(stage|unstage)$/.test(call.url)) {
      return { status: 500, body: { error: reason } };
    }
    return undefined;
  };
}

describe('a refused stage/unstage survives the next state-change', () => {
  const REASON = 'fatal: Unable to create index.lock: File exists';
  const REFUSAL = `Could not stage a.ts: ${REASON}`;
  const UNSTAGED = { path: 'a.ts', status: 'modified' as FileStatus, staged: false };

  async function refusedStage() {
    refuseMutations(REASON);
    const opened = await openStore([UNSTAGED]);
    await opened.store.stageFile('a.ts');
    await flush();
    expect(opened.store.shared.error).toBe(REFUSAL);
    return opened;
  }

  test('an unrelated state-change no longer erases it', async () => {
    const { store, source } = await refusedStage();

    // The competing git process finishing is itself a state-change — and
    // it is exactly the event the message exists to explain.
    source.emit('state-change', wireState([UNSTAGED, fileEntry('b.ts')]));
    await flush();
    expect(store.shared.error).toBe(REFUSAL);

    // And it keeps surviving; it is not a one-shot reprieve.
    source.emit('state-change', wireState([UNSTAGED, fileEntry('b.ts'), fileEntry('c.ts')]));
    await flush();
    expect(store.shared.error).toBe(REFUSAL);
  });

  test('it retires once the file reaches the side that was asked for', async () => {
    const { store, source } = await refusedStage();

    // Staged from the terminal instead: the unstaged row is gone, so the
    // refusal has nothing left to describe.
    source.emit('state-change', wireState([{ ...UNSTAGED, staged: true }]));
    await flush();
    expect(store.shared.error).toBeNull();
  });

  test('a file that leaves the working tree retires it too', async () => {
    const { store, source } = await refusedStage();
    source.emit('state-change', wireState([]));
    await flush();
    expect(store.shared.error).toBeNull();
  });

  test('an unstage refusal watches the STAGED side', async () => {
    const staged = { path: 'a.ts', status: 'modified' as FileStatus, staged: true };
    refuseMutations('fatal: nope');
    const { store, source } = await openStore([staged]);
    await store.unstageFile('a.ts');
    await flush();
    expect(store.shared.error).toBe('Could not unstage a.ts: fatal: nope');

    // The staged row is still there — still refused, still true.
    source.emit('state-change', wireState([staged, fileEntry('b.ts')]));
    await flush();
    expect(store.shared.error).toBe('Could not unstage a.ts: fatal: nope');

    // Unstaged elsewhere: done.
    source.emit('state-change', wireState([{ ...staged, staged: false }]));
    await flush();
    expect(store.shared.error).toBeNull();
  });

  test("the daemon's own error supersedes it, and takes it with it", async () => {
    const { store, source } = await refusedStage();

    source.emit('state-change', wireState([UNSTAGED], { error: 'watcher hiccup' }));
    await flush();
    expect(store.shared.error).toBe('watcher hiccup');

    // Superseded for good: a later clean state does not bring it back.
    source.emit('state-change', wireState([UNSTAGED]));
    await flush();
    expect(store.shared.error).toBeNull();
  });

  test('a fresh attempt clears the old line before it can go stale', async () => {
    const { store } = await refusedStage();

    onRequest = (call) =>
      call.method === 'POST' && call.url === '/repos/r1/stage'
        ? { body: { state: wireState([]) } }
        : undefined;
    await store.stageFile('a.ts');
    await flush();
    expect(store.shared.error).toBeNull();
  });

  test('a second refusal replaces the first', async () => {
    const { store } = await refusedStage();
    refuseMutations('fatal: something else');
    await store.stageFile('a.ts');
    await flush();
    expect(store.shared.error).toBe('Could not stage a.ts: fatal: something else');
  });

  test('a lost connection supersedes it; recovery does not resurrect it', async () => {
    const { store, source } = await refusedStage();

    source.fail();
    expect(store.shared.error).toBe(CONNECTION_LOST_MESSAGE);
    onRequest = null;
    await advance(1000);
    expect(store.shared.error).toBeNull();
  });

  test('a repo switch drops it', async () => {
    const { store } = await refusedStage();

    onRequest = (call) => {
      if (call.method === 'POST' && call.url === '/repos') {
        return { body: { id: 'r2', path: (call.body as { path: string }).path } };
      }
      if (call.url.startsWith('/repos/r2/diff')) return { body: diffBody('') };
      if (call.url.startsWith('/repos/r2/')) return { body: wireState() };
      return undefined;
    };
    await store.open('/other');
    FakeEventSource.latest().emit('snapshot', wireState());
    await flush();
    expect(store.shared.error).toBeNull();
  });
});
