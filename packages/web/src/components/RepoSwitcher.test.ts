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
import { makeFakeFetch } from '../testing/fakes';
import type { WorktreeInfo } from '@diffstalker/client';

const CALC = '/home/u/gitRepos/calculator';

function primeWorktrees(worktrees: WorktreeInfo[], activePath: string): void {
  const daemon = useDaemonStore();
  daemon.repos = [{ id: 'r1', path: activePath, branch: null }];
  daemon.activeRepoId = 'r1';
  daemon.worktrees = worktrees;
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
  test('"no repo" when nothing is active', () => {
    expect(mount(RepoSwitcher).find('.repo-label').text()).toBe('no repo');
  });

  test('the repo directory name for a single-worktree repo', () => {
    primeWorktrees(
      [{ path: '/home/u/proj/solo', branch: 'main', head: 'a', isBare: false, lastActivity: null, aheadOfBase: null }],
      '/home/u/proj/solo'
    );
    expect(mount(RepoSwitcher).find('.repo-label').text()).toBe('solo');
  });

  test('the PROJECT name when the repo is one of several worktrees', () => {
    primeWorktrees(
      [
        { path: `${CALC}/main`, branch: 'main', head: 'a', isBare: false, lastActivity: null, aheadOfBase: null },
        { path: `${CALC}/fix-a`, branch: 'fix-a', head: 'b', isBare: false, lastActivity: null, aheadOfBase: null },
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
      { id: 'diff', path: '/home/u/gitRepos/diffstalker', branch: 'main' },
    ];

    vi.stubGlobal(
      'fetch',
      makeFakeFetch((call) => {
        const calcUrls = ['/repos/calc-a/worktrees', '/repos/calc-b/worktrees'];
        if (call.method === 'GET' && calcUrls.includes(call.url)) {
          return {
            body: [
              { path: `${CALC}/.bare`, branch: null, head: null, isBare: true },
              { path: `${CALC}/main`, branch: 'main', head: 'a', isBare: false },
              { path: `${CALC}/fix-a`, branch: 'fix-a', head: 'b', isBare: false },
            ],
          };
        }
        if (call.method === 'GET' && call.url === '/repos/diff/worktrees') {
          return {
            body: [{ path: '/home/u/gitRepos/diffstalker', branch: 'main', head: 'c', isBare: false }],
          };
        }
        return { status: 404, body: {} };
      }).fn
    );

    const wrapper = mount(RepoSwitcher);
    await wrapper.find('.switch-btn').trigger('click'); // open the panel
    await flushPromises(); // resolve each repo's project root

    const names = wrapper.findAll('[data-testid="open-repos"] .repo-row .name').map((n) => n.text());
    expect(names).toEqual(['calculator', 'diffstalker']);

    // The calculator row shows its open-worktree count; diffstalker does not.
    const calcRow = wrapper.findAll('[data-testid="open-repos"] .repo-row')[0];
    expect(calcRow.find('.branch').text()).toBe('2 open');
  });
});

describe('recent list groups by project', () => {
  const calcFamily = [
    { path: `${CALC}/main`, branch: 'main', head: 'a', isBare: false, lastActivity: 1000, aheadOfBase: null },
    { path: `${CALC}/fix-a`, branch: 'fix-a', head: 'b', isBare: false, lastActivity: 5000, aheadOfBase: null },
  ];

  test('collapses worktree siblings into one row, opening the freshest on click', async () => {
    const ui = useUiStore();
    ui.recentRepos = [`${CALC}/fix-a`, `${CALC}/main`, '/home/u/gitRepos/diffstalker'];

    const fake = makeFakeFetch((call) => {
      if (call.method === 'GET' && call.url.startsWith('/worktrees?path=')) {
        const path = new URL(`http://x${call.url}`).searchParams.get('path');
        if (path === '/home/u/gitRepos/diffstalker') {
          return {
            body: [
              {
                path: '/home/u/gitRepos/diffstalker',
                branch: 'main',
                head: 'c',
                isBare: false,
                lastActivity: 500,
              },
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
      '/home/u/gitRepos/diffstalker',
    ];

    const fake = makeFakeFetch((call) => {
      if (call.method === 'GET' && call.url.startsWith('/worktrees?path=')) {
        const path = new URL(`http://x${call.url}`).searchParams.get('path');
        if (path === '/home/u/gitRepos/diffstalker') {
          return {
            body: [
              {
                path: '/home/u/gitRepos/diffstalker',
                branch: 'main',
                head: 'c',
                isBare: false,
                lastActivity: 500,
                aheadOfBase: null,
              },
            ],
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
