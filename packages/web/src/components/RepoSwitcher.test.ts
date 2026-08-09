/**
 * RepoSwitcher tests: the trigger label names the active repo's DIRECTORY
 * for a plain repo, but the PROJECT name when the repo is one of several
 * worktrees; and the "Open on daemon" list groups open worktrees by
 * project (one row per project — e.g. "calculator" — not per worktree).
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import RepoSwitcher from './RepoSwitcher.vue';
import { useDaemonStore } from '../stores/daemon';
import { useUiStore } from '../stores/ui';
import { useWorktreeStore } from '../stores/worktrees';
import { makeFakeFetch, worktree, Deferred } from '../testing/fakes';
import type { WorktreeInfo } from '@diffstalker/client';

const CALC = '/w/calculator';

/** The path a GET /worktrees call asked about. */
function queriedPath(url: string): string {
  return new URLSearchParams(url.split('?')[1] ?? '').get('path') ?? '';
}

/** Serve GET /worktrees?path= from a path -> worktrees map. */
function worktreeFetch(byPath: Map<string, WorktreeInfo[]>) {
  return makeFakeFetch((call) => {
    if (call.method === 'GET' && call.url.startsWith('/worktrees')) {
      return { body: byPath.get(queriedPath(call.url)) ?? [] };
    }
    return { status: 404, body: {} };
  }).fn;
}

async function primeWorktrees(worktrees: WorktreeInfo[], activePath: string): Promise<void> {
  const daemon = useDaemonStore();
  daemon.repos = [{ id: 'r1', path: activePath, branch: null }];
  daemon.activeRepoId = 'r1';
  vi.stubGlobal('fetch', worktreeFetch(new Map([[activePath, worktrees]])));
  useWorktreeStore(); // its active-path watcher resolves on creation
  await flushPromises();
}

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  vi.stubGlobal('fetch', makeFakeFetch(() => ({ status: 404, body: {} })).fn);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('trigger label', () => {
  test('"no repo" when nothing is active', async () => {
    expect(mount(RepoSwitcher).find('.repo-label').text()).toBe('no repo');
  });

  test('the repo directory name for a single-worktree repo', async () => {
    await primeWorktrees(
      [worktree('/proj/solo', 'main', { main: true })],
      '/proj/solo'
    );
    expect(mount(RepoSwitcher).find('.repo-label').text()).toBe('solo');
  });

  test('the PROJECT name when the repo is one of several worktrees', async () => {
    await primeWorktrees(
      [
        worktree(`${CALC}/.bare`, null, { main: true, bare: true }),
        worktree(`${CALC}/main`, 'main'),
        worktree(`${CALC}/fix-a`, 'fix-a'),
      ],
      `${CALC}/fix-a`
    );
    expect(mount(RepoSwitcher).find('.repo-label').text()).toBe('calculator');
  });
});

describe('open-on-daemon list groups by project', () => {
  test('two calculator worktrees + one plain repo -> "calculator" and "diffstalker"', async () => {
    // The daemon has three open repos: two calculator worktrees and diffstalker.
    const daemon = useDaemonStore();
    daemon.repos = [
      { id: 'calc-a', path: `${CALC}/fix-a`, branch: 'fix-a' },
      { id: 'calc-b', path: `${CALC}/main`, branch: 'main' },
      { id: 'diff', path: '/w/diffstalker', branch: 'main' },
    ];

    // FOUR worktrees exist; only two of them are open on the daemon, so
    // the badge must report 4, not the open count.
    const calcFour = [
      worktree(`${CALC}/.bare`, null, { main: true, bare: true }),
      worktree(`${CALC}/main`, 'main'),
      worktree(`${CALC}/fix-a`, 'fix-a'),
      worktree(`${CALC}/fix-b`, 'fix-b'),
      worktree(`${CALC}/spike`, 'spike'),
    ];
    vi.stubGlobal(
      'fetch',
      worktreeFetch(
        new Map([
          [`${CALC}/fix-a`, calcFour],
          [`${CALC}/main`, calcFour],
          [
            '/w/diffstalker',
            [
              worktree('/w/diffstalker', 'main', { main: true }),
            ] as WorktreeInfo[],
          ],
        ])
      )
    );

    const wrapper = mount(RepoSwitcher);
    await wrapper.find('.switch-btn').trigger('click'); // open the panel
    await flushPromises(); // resolve each repo's project root

    const names = wrapper.findAll('[data-testid="open-repos"] .repo-row .name').map((n) => n.text());
    expect(names).toEqual(['calculator', 'diffstalker']);

    // The badge counts ALL of the project's worktrees (4), not the 2 that
    // happen to be open — the same wording the Recent list uses, so one
    // project reads identically in either list. A single-worktree repo
    // (diffstalker) gets no badge at all.
    const rows = wrapper.findAll('[data-testid="open-repos"] .repo-row');
    expect(rows[0].find('.branch').text()).toBe('4 worktrees');
    expect(rows[1].find('.branch').exists()).toBe(false);
  });
});

describe('recent list groups by project', () => {
  // Bare layout: the bare git dir is the family's main entry.
  const calcFamily = [
    worktree(`${CALC}/.bare`, null, { main: true, bare: true }),
    worktree(`${CALC}/main`, 'main', { lastActivity: 1000 }),
    worktree(`${CALC}/fix-a`, 'fix-a', { lastActivity: 5000 }),
  ];

  test('holds back paths still being resolved instead of drawing one stray row each', async () => {
    // Two worktrees of ONE project. Until they resolve, neither knows it
    // belongs to "calculator", so rendering them optimistically draws two
    // stray rows named after the worktrees that then collapse into one —
    // the "why is my worktree listed as a repo" bug. They must not render.
    const ui = useUiStore();
    ui.recentRepos = [`${CALC}/fix-a`, `${CALC}/main`];

    const gate = new Deferred<void>();
    vi.stubGlobal(
      'fetch',
      makeFakeFetch(async (call) => {
        if (call.method === 'GET' && call.url.startsWith('/worktrees?path=')) {
          await gate.promise; // hold every lookup in flight
          return { body: calcFamily };
        }
        return { status: 404, body: {} };
      }).fn
    );

    const wrapper = mount(RepoSwitcher);
    await wrapper.find('.switch-btn').trigger('click');
    await flushPromises();

    // In flight: nothing drawn, rather than two soon-to-vanish rows.
    expect(wrapper.findAll('[data-testid="recent-repos"] .repo-row')).toHaveLength(0);

    gate.resolve();
    await flushPromises();

    const names = wrapper.findAll('[data-testid="recent-repos"] .repo-row .name').map((n) => n.text());
    expect(names).toEqual(['calculator']);
  });

  test('collapses worktree siblings into one row, opening the freshest on click', async () => {
    const ui = useUiStore();
    ui.recentRepos = [`${CALC}/fix-a`, `${CALC}/main`, '/w/diffstalker'];

    const fake = makeFakeFetch((call) => {
      if (call.method === 'GET' && call.url.startsWith('/worktrees?path=')) {
        const path = new URL(`http://x${call.url}`).searchParams.get('path');
        if (path === '/w/diffstalker') {
          return {
            body: [
              worktree('/w/diffstalker', 'main', { main: true, lastActivity: 500 }),
            ],
          };
        }
        return { body: calcFamily };
      }
      if (call.method === 'POST' && call.url === '/repos') {
        return { body: { id: 'new', path: (call.body as { path: string }).path } };
      }
      return { status: 404, body: {} };
    });
    vi.stubGlobal('fetch', fake.fn);

    const wrapper = mount(RepoSwitcher);
    await wrapper.find('.switch-btn').trigger('click');
    await flushPromises();

    const names = wrapper.findAll('[data-testid="recent-repos"] .repo-row .name').map((n) => n.text());
    expect(names).toEqual(['calculator', 'diffstalker']);

    const calcRow = wrapper.findAll('[data-testid="recent-repos"] .repo-row')[0];
    expect(calcRow.find('.branch').text()).toBe('2 worktrees');

    await calcRow.trigger('click');
    await flushPromises();

    // fix-a has the higher lastActivity, so it — not the clicked path's
    // literal entry — is what actually gets opened.
    const posted = fake.calls.filter((c) => c.method === 'POST' && c.url === '/repos');
    expect(posted.at(-1)?.body).toEqual({ path: `${CALC}/fix-a` });
  });

  test('a recent worktree already covered by an open project does not duplicate under Recent', async () => {
    const daemon = useDaemonStore();
    daemon.repos = [{ id: 'calc-a', path: `${CALC}/fix-a`, branch: 'fix-a' }];
    daemon.activeRepoId = 'calc-a';

    const ui = useUiStore();
    ui.recentRepos = [`${CALC}/main`];

    const fake = makeFakeFetch((call) => {
      if (call.method === 'GET' && call.url === '/repos/calc-a/worktrees') {
        return { body: calcFamily };
      }
      if (call.method === 'GET' && call.url.startsWith('/worktrees?path=')) {
        return { body: calcFamily };
      }
      return { status: 404, body: {} };
    });
    vi.stubGlobal('fetch', fake.fn);

    const wrapper = mount(RepoSwitcher);
    await wrapper.find('.switch-btn').trigger('click');
    await flushPromises();
    await flushPromises();

    expect(wrapper.find('[data-testid="recent-repos"]').exists()).toBe(false);
  });

  test('a transient worktreesForPath failure is not cached as dead — retried on next open', async () => {
    const ui = useUiStore();
    ui.recentRepos = [`${CALC}/fix-a`];

    let calls = 0;
    const fake = makeFakeFetch((call) => {
      if (call.method === 'GET' && call.url.startsWith('/worktrees?path=')) {
        calls++;
        if (calls === 1) throw new TypeError('Failed to fetch');
        return {
          body: [
            { path: `${CALC}/fix-a`, branch: 'fix-a', head: 'a', isBare: false, lastActivity: null, aheadOfBase: null },
          ],
        };
      }
      return { status: 404, body: {} };
    });
    vi.stubGlobal('fetch', fake.fn);

    const wrapper = mount(RepoSwitcher);
    const trigger = wrapper.find('.switch-btn');

    await trigger.trigger('click'); // open: the fetch throws
    await flushPromises();
    // Not dropped — still shown optimistically under its own path, not hidden as dead.
    expect(wrapper.findAll('[data-testid="recent-repos"] .repo-row')).toHaveLength(1);

    await trigger.trigger('click'); // close
    await trigger.trigger('click'); // reopen: retries the unresolved path
    await flushPromises();

    expect(calls).toBe(2);
    expect(wrapper.find('[data-testid="recent-repos"] .repo-row .name').text()).toBe('fix-a');
  });

  test('a recent path that no longer resolves to any worktree is dropped, not shown as its own stray row', async () => {
    const ui = useUiStore();
    ui.recentRepos = [
      `${CALC}/bump-search-client-1.11`, // removed worktree, dir no longer exists
      '/w/diffstalker',
    ];

    const fake = makeFakeFetch((call) => {
      if (call.method === 'GET' && call.url.startsWith('/worktrees?path=')) {
        const path = new URL(`http://x${call.url}`).searchParams.get('path');
        if (path === '/w/diffstalker') {
          return {
            body: [worktree('/w/diffstalker', 'main', { main: true, lastActivity: 500 })],
          };
        }
        return { body: [] }; // dead path: no longer a git working tree
      }
      return { status: 404, body: {} };
    });
    vi.stubGlobal('fetch', fake.fn);

    const wrapper = mount(RepoSwitcher);
    await wrapper.find('.switch-btn').trigger('click');
    await flushPromises();

    const names = wrapper.findAll('[data-testid="recent-repos"] .repo-row .name').map((n) => n.text());
    expect(names).toEqual(['diffstalker']);
  });
});

describe('discovered repos', () => {
  /** A daemon whose watch directory holds these repos, and no worktrees. */
  function discoveryFetch(
    repos: { name: string; path: string; branch: string | null; lastActivity?: number | null }[]
  ) {
    return makeFakeFetch((call) => {
      if (call.url.startsWith('/discovered')) {
        const rows = repos.map((repo) => ({ lastActivity: null, ...repo }));
        return { body: { roots: [{ path: '/w', repos: rows, error: null, capped: false }] } };
      }
      if (call.url.startsWith('/worktrees')) return { body: [] };
      return { status: 404, body: {} };
    });
  }

  test('lists repos found under a watch directory, with their branch', async () => {
    const fake = discoveryFetch([
      { name: 'archive', path: '/w/archive', branch: 'main' },
      { name: 'register', path: '/w/register', branch: 'feat/x' },
    ]);
    vi.stubGlobal('fetch', fake.fn);

    const wrapper = mount(RepoSwitcher);
    await wrapper.find('.switch-btn').trigger('click');
    await flushPromises();

    const rows = wrapper.findAll('[data-testid="discovered-repos"] .repo-row');
    expect(rows.map((row) => row.find('.name').text())).toEqual(['archive', 'register']);
    expect(rows[1].find('.branch').text()).toBe('feat/x');
  });

  test('a repo already open on the daemon is not repeated in Discovered', async () => {
    vi.stubGlobal(
      'fetch',
      discoveryFetch([
        { name: 'archive', path: '/w/archive', branch: 'main' },
        { name: 'register', path: '/w/register', branch: 'main' },
      ]).fn
    );
    const daemon = useDaemonStore();
    daemon.repos = [{ id: 'r1', path: '/w/archive', branch: 'main' }];

    const wrapper = mount(RepoSwitcher);
    await wrapper.find('.switch-btn').trigger('click');
    await flushPromises();

    const names = wrapper
      .findAll('[data-testid="discovered-repos"] .repo-row .name')
      .map((n) => n.text());
    expect(names).toEqual(['register']);
  });

  test('opening the panel rescans, so a branch label is not stale', async () => {
    const fake = discoveryFetch([{ name: 'archive', path: '/w/archive', branch: 'main' }]);
    vi.stubGlobal('fetch', fake.fn);

    const wrapper = mount(RepoSwitcher);
    await wrapper.find('.switch-btn').trigger('click');
    await flushPromises();

    expect(fake.callsTo('/discovered/rescan')).toHaveLength(1);
  });

  test('a long list gets a filter that narrows by name', async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      name: `proj-${i}`,
      path: `/w/proj-${i}`,
      branch: 'main',
    }));
    vi.stubGlobal('fetch', discoveryFetch(many).fn);

    const wrapper = mount(RepoSwitcher);
    await wrapper.find('.switch-btn').trigger('click');
    await flushPromises();

    const filter = wrapper.find('.discovered-filter');
    expect(filter.exists()).toBe(true);

    await filter.setValue('proj-1');
    const names = wrapper
      .findAll('[data-testid="discovered-repos"] .repo-row .name')
      .map((n) => n.text());
    expect(names).toEqual(['proj-1', 'proj-10', 'proj-11']);
  });

  test('a short list has no filter field', async () => {
    vi.stubGlobal(
      'fetch',
      discoveryFetch([{ name: 'archive', path: '/w/archive', branch: 'main' }]).fn
    );

    const wrapper = mount(RepoSwitcher);
    await wrapper.find('.switch-btn').trigger('click');
    await flushPromises();

    expect(wrapper.find('.discovered-filter').exists()).toBe(false);
  });

  test('clicking a discovered repo opens it by path', async () => {
    const fake = makeFakeFetch((call) => {
      if (call.url.startsWith('/discovered')) {
        return {
          body: {
            roots: [
              {
                path: '/w',
                repos: [
                  { name: 'archive', path: '/w/archive', branch: 'main', lastActivity: null },
                ],
                error: null,
                capped: false,
              },
            ],
          },
        };
      }
      if (call.url === '/repos' && call.method === 'POST') {
        return { status: 201, body: { id: 'r9', path: '/w/archive' } };
      }
      if (call.url.startsWith('/worktrees')) return { body: [] };
      return { status: 404, body: {} };
    });
    vi.stubGlobal('fetch', fake.fn);

    const wrapper = mount(RepoSwitcher);
    await wrapper.find('.switch-btn').trigger('click');
    await flushPromises();
    await wrapper.find('[data-testid="discovered-repos"] .repo-row').trigger('click');
    await flushPromises();

    expect(fake.callsTo('/repos').some((call) => call.body && (call.body as { path: string }).path === '/w/archive')).toBe(true);
  });
});
