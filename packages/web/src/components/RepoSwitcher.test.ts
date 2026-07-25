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
      [{ path: '/home/u/proj/solo', branch: 'main', head: 'a', isBare: false }],
      '/home/u/proj/solo'
    );
    expect(mount(RepoSwitcher).find('.repo-label').text()).toBe('solo');
  });

  test('the PROJECT name when the repo is one of several worktrees', () => {
    primeWorktrees(
      [
        { path: `${CALC}/main`, branch: 'main', head: 'a', isBare: false },
        { path: `${CALC}/fix-a`, branch: 'fix-a', head: 'b', isBare: false },
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
