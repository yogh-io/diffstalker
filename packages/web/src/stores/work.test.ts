/**
 * useWorkStore tests: the scan (bounded concurrency, results as they
 * land, no double scan of one repo, a newer scan wins), when GitHub is
 * asked, and when stale marks are pruned. A fake fetch stands in for the
 * daemon.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { useWorkStore } from './work';
import { Deferred, makeFakeFetch } from '../testing/fakes';
import type { FakeFetch, FakeResponse, FetchCall } from '../testing/fakes';
import type { PrSnapshot, WorkMarks, WorkRepoFacts } from '@diffstalker/core/types/work';

function facts(path: string, over: Partial<WorkRepoFacts> = {}): WorkRepoFacts {
  return {
    path,
    root: path,
    name: path.split('/').at(-1) ?? path,
    worktrees: [
      {
        path,
        branch: 'feature',
        head: 'h',
        isMain: true,
        isBare: false,
        lastActivity: 1,
        changedAt: null,
        aheadOfBase: 0,
        base: 'origin/main',
        uncommitted: 1,
      },
    ],
    branches: [{ name: 'feature', tip: 't', remoteCopy: false, unpushed: null }],
    branchesCapped: false,
    identities: [],
    drafts: [],
    ...over,
  };
}

function snapshot(over: Partial<PrSnapshot> = {}): PrSnapshot {
  return {
    status: 'ok',
    message: null,
    checkedAt: 1000,
    viewer: 'JornC',
    prs: [],
    capped: false,
    ...over,
  };
}

const EMPTY_MARKS: WorkMarks = { tracked: {}, dismissed: {} };

let fake: FakeFetch;
let discovered: string[];
let open: string[];
/** What the daemon says about the one watch directory, beside its repos. */
let rootState: { error: string | null; capped: boolean };
let prsAnswer: PrSnapshot;
let onRepo: (path: string, call: FetchCall) => FakeResponse | Promise<FakeResponse>;

function pathOf(call: FetchCall): string {
  return (call.body as { path: string }).path;
}

beforeEach(() => {
  setActivePinia(createPinia());
  discovered = [];
  open = [];
  rootState = { error: null, capped: false };
  prsAnswer = snapshot();
  onRepo = (path) => ({ body: facts(path) });
  fake = makeFakeFetch((call) => {
    if (call.url === '/discovered') {
      return {
        body: {
          roots: [
            {
              path: '/w',
              repos: discovered.map((path) => ({
                path,
                name: path,
                branch: null,
                lastActivity: null,
              })),
              ...rootState,
            },
          ],
        },
      };
    }
    if (call.url === '/repos')
      return { body: open.map((path, i) => ({ id: `r${i}`, path, branch: null })) };
    if (call.url === '/work/repo' && call.method === 'POST') return onRepo(pathOf(call), call);
    if (call.url === '/work/prs') return { body: prsAnswer };
    if (call.url === '/work/prs/refresh') return { body: snapshot() };
    if (call.url === '/work/marks' && call.method === 'GET') return { body: EMPTY_MARKS };
    if (call.url === '/work/marks' && call.method === 'PUT') return { body: EMPTY_MARKS };
    return { status: 404, body: { error: 'no route' } };
  });
  vi.stubGlobal('fetch', fake.fn);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('scan', () => {
  test('at most four repos are asked at once, and each answer shows as it lands', async () => {
    discovered = Array.from({ length: 10 }, (_, i) => `/w/r${i}`);
    const held = new Map<string, Deferred<FakeResponse>>();
    let inFlight = 0;
    let peak = 0;
    onRepo = (path) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      const answer = new Deferred<FakeResponse>();
      held.set(path, answer);
      return answer.promise.finally(() => {
        inFlight -= 1;
      });
    };
    const store = useWorkStore();
    const done = store.runScan();
    await flushPromises();
    expect(inFlight).toBe(4);

    held.get('/w/r0')!.resolve({ body: facts('/w/r0') });
    await flushPromises();
    expect(store.repos.map((repo) => repo.root)).toEqual(['/w/r0']);
    expect(store.scan).toEqual({ total: 10, done: 1, running: true });

    for (let i = 1; i < 10; i++) {
      await flushPromises();
      held.get(`/w/r${i}`)!.resolve({ body: facts(`/w/r${i}`) });
    }
    await done;
    expect(peak).toBe(4);
    expect(store.repos).toHaveLength(10);
    expect(store.scan).toEqual({ total: 10, done: 10, running: false });
    expect(store.scanFinished).toBe(true);
  });

  test('an open repo that is a worktree of a discovered one is not scanned again', async () => {
    discovered = ['/w/calc'];
    open = ['/w/calc-x', '/w/other'];
    onRepo = (path) =>
      path === '/w/calc'
        ? {
            body: facts('/w/calc', {
              worktrees: [
                { ...facts('/w/calc').worktrees[0] },
                { ...facts('/w/calc').worktrees[0], path: '/w/calc-x', isMain: false },
              ],
            }),
          }
        : { body: facts(path) };
    const store = useWorkStore();
    await store.runScan();
    const scans = fake.callsTo('/work/repo');
    expect(scans.map((call) => call.method)).toEqual(['POST', 'POST']);
    expect(scans.map(pathOf)).toEqual(['/w/calc', '/w/other']);
    expect(store.repos.map((repo) => repo.root)).toEqual(['/w/calc', '/w/other']);
  });

  test('two paths of one repo give one entry', async () => {
    discovered = ['/w/calc', '/w/calc-x'];
    onRepo = (path) => ({ body: { ...facts('/w/calc'), path } });
    const store = useWorkStore();
    await store.runScan();
    expect(store.repos).toHaveLength(1);
  });

  test('a newer scan drops what an older one would still apply', async () => {
    discovered = ['/w/slow'];
    const slow = new Deferred<FakeResponse>();
    onRepo = (path) => (path === '/w/slow' ? slow.promise : { body: facts(path) });
    const store = useWorkStore();
    const first = store.runScan();
    await flushPromises();

    discovered = ['/w/fast'];
    await store.runScan();
    slow.resolve({ body: facts('/w/slow') });
    await first;
    expect(store.repos.map((repo) => repo.root)).toEqual(['/w/fast']);
    expect(store.scan.running).toBe(false);
  });

  test('a repo the daemon refuses is listed and logged, and the scan is not complete', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    discovered = ['/w/a', '/w/gone'];
    onRepo = (path) =>
      path === '/w/gone'
        ? { status: 404, body: { error: 'Not a git repository' } }
        : { body: facts(path) };
    const store = useWorkStore();
    await store.load();
    expect(store.repoErrors).toEqual([{ path: '/w/gone', message: 'Not a git repository' }]);
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(store.scanFinished).toBe(true);
    expect(store.complete).toBe(false);
  });
});

describe('GitHub', () => {
  test('on open the cached snapshot is read, and refreshed only when never asked', async () => {
    const store = useWorkStore();
    await store.load();
    expect(fake.callsTo('/work/prs/refresh')).toHaveLength(0);
    expect(store.prs?.status).toBe('ok');

    prsAnswer = snapshot({ status: 'never', checkedAt: null, viewer: null });
    await store.load();
    const refreshes = fake.callsTo('/work/prs/refresh');
    expect(refreshes).toHaveLength(1);
    expect(refreshes[0].method).toBe('POST');
    expect(store.prs?.status).toBe('ok');
  });

  test('the refresh button asks GitHub and rescans', async () => {
    discovered = ['/w/a'];
    const store = useWorkStore();
    await store.refresh();
    expect(fake.callsTo('/work/prs/refresh')).toHaveLength(1);
    expect(fake.callsTo('/work/repo')).toHaveLength(1);
  });
});

describe('marks', () => {
  const staleKey = '/w/removed\nx';
  const withStale: WorkMarks = { tracked: { [staleKey]: { at: 1 } }, dismissed: {} };

  function putBodies(): unknown[] {
    return fake.calls
      .filter((c) => c.url === '/work/marks' && c.method === 'PUT')
      .map((c) => c.body);
  }

  test('a mark carries prune only after a complete scan', async () => {
    discovered = ['/w/a'];
    const store = useWorkStore();
    store.marks = withStale;
    await store.mark('/w/a\nfeature', 'track');
    expect(putBodies()).toEqual([{ key: '/w/a\nfeature', action: 'track' }]);

    await store.load();
    store.marks = withStale;
    expect(store.complete).toBe(true);
    await store.mark('/w/a\nfeature', 'dismiss', 't|1|0');
    expect(putBodies().at(-1)).toEqual({
      key: '/w/a\nfeature',
      action: 'dismiss',
      fingerprint: 't|1|0',
      prune: [staleKey],
    });
  });

  test('no prune while the PR list was never a GitHub answer', async () => {
    discovered = ['/w/a'];
    prsAnswer = snapshot({ status: 'gh-missing', checkedAt: null });
    const store = useWorkStore();
    await store.load();
    store.marks = withStale;
    expect(store.complete).toBe(false);
    await store.mark('/w/a\nfeature', 'track');
    expect(putBodies().at(-1)).toEqual({ key: '/w/a\nfeature', action: 'track' });
  });

  test('a watch directory that could not be read is shown, and nothing is pruned', async () => {
    rootState = { error: 'ENOENT: no such file or directory', capped: false };
    open = ['/w/a'];
    const store = useWorkStore();
    await store.load();
    store.marks = withStale;
    expect(store.rootErrors).toEqual([
      { path: '/w', message: 'ENOENT: no such file or directory' },
    ]);
    expect(store.repoErrors).toEqual([]);
    expect(store.complete).toBe(false);
    await store.mark('/w/a\nfeature', 'dismiss', 't|1|0');
    expect(putBodies().at(-1)).toEqual({
      key: '/w/a\nfeature',
      action: 'dismiss',
      fingerprint: 't|1|0',
    });
  });

  test('a capped watch directory is shown, and nothing is pruned', async () => {
    discovered = ['/w/a'];
    rootState = { error: null, capped: true };
    const store = useWorkStore();
    await store.load();
    store.marks = withStale;
    expect(store.rootErrors).toEqual([{ path: '/w', message: 'more repos than listed' }]);
    expect(store.complete).toBe(false);
    await store.mark('/w/a\nfeature', 'track');
    expect(putBodies().at(-1)).toEqual({ key: '/w/a\nfeature', action: 'track' });
  });

  test('a watch directory that lists nothing yet (a daemon just started) prunes nothing', async () => {
    open = ['/w/a'];
    const store = useWorkStore();
    await store.load();
    store.marks = withStale;
    expect(store.rootErrors).toEqual([]);
    expect(store.complete).toBe(false);
    await store.mark('/w/a\nfeature', 'track');
    expect(putBodies().at(-1)).toEqual({ key: '/w/a\nfeature', action: 'track' });
  });

  test('the answer replaces the marks; a failure is one logged line', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = useWorkStore();
    await store.mark('k', 'track');
    expect(store.marks).toEqual(EMPTY_MARKS);

    vi.stubGlobal('fetch', makeFakeFetch(() => ({ status: 500, body: { error: 'disk full' } })).fn);
    await store.mark('k', 'track');
    expect(store.error).toBe('Could not save: disk full');
    expect(consoleError).toHaveBeenCalledTimes(1);
  });
});
