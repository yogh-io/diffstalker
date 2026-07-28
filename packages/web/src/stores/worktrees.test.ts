/**
 * useWorktreeStore tests — the switcher hardening.
 *
 * The bug this store exists to make impossible: the header showed one
 * repo's project name next to another repo's worktree name, because the
 * active worktree list was a bare array that only changed when a fetch
 * happened to land. Everything here is keyed by PATH and derived, so the
 * tests below assert that property directly: after ANY kind of switch,
 * and in every failure mode, no surface can read a path's data against a
 * different path.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import { useDaemonStore } from './daemon';
import { useWorktreeStore } from './worktrees';
import { makeFakeFetch, worktree, Deferred } from '../testing/fakes';
import type { FakeFetch } from '../testing/fakes';
import type { WorktreeInfo } from '@diffstalker/client';

const CALC = '/w/calculator';
const VUE = '/w/vue-geo-components';
const SOLO = '/w/diffstalker';

function wt(path: string, branch: string, lastActivity: number | null = null): WorktreeInfo {
  return worktree(path, branch, { lastActivity });
}

/** Bare layout: `…/calculator/.bare` is main, worktrees sit beside it. */
const CALC_FAMILY = [
  worktree(`${CALC}/.bare`, null, { main: true, bare: true }),
  wt(`${CALC}/main`, 'main', 1000),
  wt(`${CALC}/fix-a`, 'fix-a', 5000),
];
/** Nested layout: worktrees live under the repo itself. */
const VUE_FAMILY = [
  worktree(VUE, 'trunk', { main: true, lastActivity: 2000 }),
  wt(`${VUE}/worktrees/spike`, 'spike', 9000),
];
/** No worktrees at all: a plain repo is its own main. */
const SOLO_FAMILY = [worktree(SOLO, 'main', { main: true, lastActivity: 3000 })];

let fake: FakeFetch;
/** What GET /worktrees?path= answers, per queried path. */
let byPath: Map<string, WorktreeInfo[]>;
/** Paths whose lookup should reject (daemon unreachable). */
let failing: Set<string>;

function queriedPath(url: string): string {
  return new URLSearchParams(url.split('?')[1] ?? '').get('path') ?? '';
}

/** Point the daemon store at an open repo and make it active. */
function activate(id: string, path: string): void {
  const daemon = useDaemonStore();
  const known = daemon.repos.some((repo) => repo.id === id);
  if (!known) daemon.repos = [...daemon.repos, { id, path, branch: null }];
  daemon.activeRepoId = id;
}

beforeEach(() => {
  setActivePinia(createPinia());
  byPath = new Map([
    [`${CALC}/main`, CALC_FAMILY],
    [`${CALC}/fix-a`, CALC_FAMILY],
    [VUE, VUE_FAMILY],
    [`${VUE}/worktrees/spike`, VUE_FAMILY],
    [SOLO, SOLO_FAMILY],
  ]);
  failing = new Set();
  fake = makeFakeFetch((call) => {
    if (call.method === 'GET' && call.url.startsWith('/worktrees')) {
      const path = queriedPath(call.url);
      if (failing.has(path)) return { status: 500, body: { error: 'daemon down' } };
      return { body: byPath.get(path) ?? [] };
    }
    return { status: 404, body: {} };
  });
  vi.stubGlobal('fetch', fake.fn);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resolution', () => {
  test('resolves the active repo without being asked, and names its project', async () => {
    activate('r1', `${CALC}/fix-a`);
    const store = useWorktreeStore();
    await flushPromises();

    expect(store.activeProject).toMatchObject({ root: CALC, name: 'calculator' });
    expect(store.activeProject?.worktrees).toHaveLength(2);
  });

  test('a single-worktree repo resolves to itself', async () => {
    activate('r1', SOLO);
    const store = useWorktreeStore();
    await flushPromises();

    expect(store.activeProject).toMatchObject({ root: SOLO, name: 'diffstalker' });
    expect(store.activeProject?.worktrees).toHaveLength(1);
  });

  test('drops the bare entry and sorts most-recently-edited first', async () => {
    byPath.set(SOLO, [
      worktree(`${CALC}/.bare`, null, { main: true, bare: true }),
      wt(`${CALC}/old`, 'old', 10),
      wt(`${CALC}/fresh`, 'fresh', 9000),
    ]);
    activate('r1', SOLO);
    const store = useWorktreeStore();
    await flushPromises();

    expect(store.activeProject?.worktrees.map((w) => w.branch)).toEqual(['fresh', 'old']);
  });

  test('a path the daemon does not know is absent, not an empty project', async () => {
    byPath.clear();
    activate('r1', '/gone');
    const store = useWorktreeStore();
    await flushPromises();

    expect(store.entryFor('/gone')).toEqual({ status: 'absent' });
    expect(store.projectFor('/gone')).toBe(null);
  });
});

/**
 * Project identity comes from git's MAIN worktree, never from path shape.
 * These are the layouts a user can actually have; the store must name and
 * group all of them the same way, and none of them may leak a property of
 * the machine (like whatever directory repos happen to live in).
 */
describe('layout indifference', () => {
  async function projectOf(path: string, family: WorktreeInfo[]) {
    byPath.set(path, family);
    const store = useWorktreeStore();
    await store.ensure([path]);
    return store.projectFor(path);
  }

  test('a plain repo with no worktrees', async () => {
    const project = await projectOf('/anywhere/proj', [worktree('/anywhere/proj', 'main', { main: true })]);
    expect(project).toMatchObject({ root: '/anywhere/proj', name: 'proj' });
  });

  test('worktrees NESTED under the repo', async () => {
    const family = [
      worktree('/anywhere/proj', 'main', { main: true }),
      worktree('/anywhere/proj/worktrees/fix', 'fix'),
    ];
    for (const w of family) {
      expect(await projectOf(w.path, family)).toMatchObject({ root: '/anywhere/proj', name: 'proj' });
    }
  });

  test('worktrees parked as SIBLINGS of the repo', async () => {
    // The layout the old common-parent rule broke on: these two share only
    // their parent directory, so the project took ITS name.
    const family = [
      worktree('/anywhere/proj', 'main', { main: true }),
      worktree('/anywhere/proj-fix', 'fix'),
    ];
    for (const w of family) {
      expect(await projectOf(w.path, family)).toMatchObject({ root: '/anywhere/proj', name: 'proj' });
    }
  });

  test('a BARE repo with worktrees beside it (.bare layout)', async () => {
    const family = [
      worktree('/anywhere/proj/.bare', null, { main: true, bare: true }),
      worktree('/anywhere/proj/main', 'main'),
      worktree('/anywhere/proj/fix', 'fix'),
    ];
    const project = await projectOf('/anywhere/proj/fix', family);
    expect(project).toMatchObject({ root: '/anywhere/proj', name: 'proj' });
    // The bare entry is not something you can switch to.
    expect(project?.worktrees.map((w) => w.branch)).toEqual(['main', 'fix']);
  });

  test('a BARE repo named proj.git', async () => {
    const family = [
      worktree('/srv/proj.git', null, { main: true, bare: true }),
      worktree('/checkouts/whatever', 'main'),
    ];
    expect(await projectOf('/checkouts/whatever', family)).toMatchObject({
      root: '/srv/proj.git',
      name: 'proj',
    });
  });

  test('worktrees SCATTERED across unrelated directories still group as one', async () => {
    const family = [
      worktree('/one/place/proj', 'main', { main: true }),
      worktree('/somewhere/else/entirely', 'fix'),
    ];
    const roots = [];
    for (const w of family) {
      roots.push((await projectOf(w.path, family))?.root);
    }
    // Same identity from either end — no common parent exists at all.
    expect(roots).toEqual(['/one/place/proj', '/one/place/proj']);
  });

  test('no main reported (an older daemon) falls back to the queried path', async () => {
    const project = await projectOf('/anywhere/proj', [worktree('/anywhere/proj', 'main')]);
    expect(project).toMatchObject({ root: '/anywhere/proj', name: 'proj' });
  });
});

describe('switching repos — no stale data, ever', () => {
  test('switching projects never leaves the previous project resolved as active', async () => {
    // The reported bug, exactly: vue-geo-components active, switch to
    // diffstalker, and the header kept reading the vue worktree family.
    activate('vue', VUE);
    const store = useWorktreeStore();
    await flushPromises();
    expect(store.activeProject?.name).toBe('vue-geo-components');

    activate('solo', SOLO);
    // BEFORE the new lookup resolves: the old project must already be gone.
    expect(store.activeProject).toBe(null);

    await flushPromises();
    expect(store.activeProject?.name).toBe('diffstalker');
  });

  test('a switch whose lookup FAILS shows nothing, not the previous project', async () => {
    activate('vue', VUE);
    const store = useWorktreeStore();
    await flushPromises();
    expect(store.activeProject?.name).toBe('vue-geo-components');

    failing.add(SOLO);
    activate('solo', SOLO);
    await flushPromises();

    expect(store.entryFor(SOLO)).toEqual({ status: 'failed' });
    expect(store.activeProject).toBe(null);
  });

  test('a switch to a path that is no longer a worktree shows nothing', async () => {
    activate('vue', VUE);
    const store = useWorktreeStore();
    await flushPromises();

    byPath.delete(SOLO);
    activate('solo', SOLO);
    await flushPromises();

    expect(store.activeProject).toBe(null);
  });

  test('an out-of-order response cannot land on the wrong repo', async () => {
    // The classic race: A's lookup is slow, B's is fast, A resolves LAST.
    // Keying by path (not "the active list") makes it a non-event.
    const slow = new Deferred<void>();
    vi.stubGlobal(
      'fetch',
      makeFakeFetch(async (call) => {
        const path = queriedPath(call.url);
        if (path === VUE) await slow.promise;
        return { body: byPath.get(path) ?? [] };
      }).fn
    );

    activate('vue', VUE);
    const store = useWorktreeStore();
    activate('solo', SOLO);
    await flushPromises();
    expect(store.activeProject?.name).toBe('diffstalker');

    slow.resolve(); // the abandoned lookup finally lands
    await flushPromises();

    // It is cached under ITS OWN path and does not touch the active view.
    expect(store.activeProject?.name).toBe('diffstalker');
    expect(store.projectFor(VUE)?.name).toBe('vue-geo-components');
  });

  test('switching between worktrees of ONE project keeps the project name', async () => {
    activate('a', `${CALC}/fix-a`);
    const store = useWorktreeStore();
    await flushPromises();
    expect(store.activeProject?.name).toBe('calculator');

    activate('b', `${CALC}/main`);
    await flushPromises();
    expect(store.activeProject?.name).toBe('calculator');
  });

  test('deactivating (repo closed) clears the active project', async () => {
    activate('vue', VUE);
    const store = useWorktreeStore();
    await flushPromises();

    const daemon = useDaemonStore();
    daemon.activeRepoId = null;

    expect(store.activePath).toBe(null);
    expect(store.activeProject).toBe(null);
  });
});

describe('request economy', () => {
  test('concurrent asks for one path share a single request', async () => {
    const store = useWorktreeStore();
    void store.ensure([`${CALC}/main`, `${CALC}/main`]);
    void store.ensure([`${CALC}/main`]);
    await flushPromises();

    expect(fake.callsTo('/worktrees')).toHaveLength(1);
  });

  test('ensure does not re-ask for something already resolved', async () => {
    const store = useWorktreeStore();
    await store.ensure([`${CALC}/main`]);
    await store.ensure([`${CALC}/main`]);
    await flushPromises();

    expect(fake.callsTo('/worktrees')).toHaveLength(1);
  });

  test('ensure DOES retry a path that failed — a dead daemon is not a verdict', async () => {
    const store = useWorktreeStore();
    failing.add(`${CALC}/main`);
    await store.ensure([`${CALC}/main`]);
    expect(store.entryFor(`${CALC}/main`)).toEqual({ status: 'failed' });

    failing.delete(`${CALC}/main`);
    await store.ensure([`${CALC}/main`]);
    await flushPromises();

    expect(store.projectFor(`${CALC}/main`)?.name).toBe('calculator');
    expect(fake.callsTo('/worktrees')).toHaveLength(2);
  });

  test('refresh re-reads a resolved path but never blanks it mid-flight', async () => {
    const store = useWorktreeStore();
    await store.ensure([`${CALC}/main`]);

    const gate = new Deferred<void>();
    vi.stubGlobal(
      'fetch',
      makeFakeFetch(async () => {
        await gate.promise;
        return { body: [...CALC_FAMILY, wt(`${CALC}/new`, 'new', 9999)] };
      }).fn
    );

    void store.refresh([`${CALC}/main`]);
    // Still showing the old answer while the new one is in flight: going
    // back to 'pending' would blank the dropdown on every open.
    expect(store.projectFor(`${CALC}/main`)?.worktrees).toHaveLength(2);

    gate.resolve();
    await flushPromises();
    expect(store.projectFor(`${CALC}/main`)?.worktrees).toHaveLength(3);
  });

  test('opening a repo re-reads what we know WITHOUT dropping it', async () => {
    // The regression this guards: clearing the cache here emptied the
    // picker's Recent list on every repo switch (recents do not render
    // until resolved), and re-resolved everything each time.
    const store = useWorktreeStore();
    await store.ensure([`${CALC}/main`]);
    expect(store.projectFor(`${CALC}/main`)?.worktrees).toHaveLength(2);

    // A new worktree is created and opened: the cached family is stale.
    const daemon = useDaemonStore();
    daemon.repos = [{ id: 'x', path: `${CALC}/brand-new`, branch: null }];
    await flushPromises();

    // Still rendering the last good answer — nothing vanished.
    expect(store.projectFor(`${CALC}/main`)?.worktrees).toHaveLength(2);

    // ...and the next ensure picks up the change, in the background.
    byPath.set(`${CALC}/main`, [...CALC_FAMILY, wt(`${CALC}/brand-new`, 'brand-new', 9999)]);
    await store.ensure([`${CALC}/main`]);
    expect(store.projectFor(`${CALC}/main`)?.worktrees).toHaveLength(3);
  });

  test('a stale entry is re-read once, not on every ensure', async () => {
    const store = useWorktreeStore();
    await store.ensure([`${CALC}/main`]);
    const daemon = useDaemonStore();
    daemon.repos = [{ id: 'x', path: `${CALC}/brand-new`, branch: null }];
    await flushPromises();

    await store.ensure([`${CALC}/main`]);
    await store.ensure([`${CALC}/main`]);
    await flushPromises();

    expect(fake.callsTo('/worktrees')).toHaveLength(2); // initial + one re-read
  });

  test('a repo switch never empties an already-resolved recent path', async () => {
    const store = useWorktreeStore();
    const daemon = useDaemonStore();
    daemon.repos = [{ id: 'a', path: `${CALC}/main`, branch: null }];
    await store.ensure([VUE]); // a "recent" path, not open
    expect(store.projectFor(VUE)?.name).toBe('vue-geo-components');

    // Switch repos: open one, release the other (what every switch does).
    daemon.repos = [{ id: 'b', path: SOLO, branch: null }];
    await flushPromises();

    expect(store.projectFor(VUE)?.name).toBe('vue-geo-components');
  });
});
