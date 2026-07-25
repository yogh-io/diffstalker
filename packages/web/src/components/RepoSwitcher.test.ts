/**
 * RepoSwitcher tests: the trigger label names the active repo's DIRECTORY
 * for a plain repo, but the PROJECT name when the repo is one of several
 * worktrees (the worktree switcher beside it names the worktree, so the
 * name is not shown twice).
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount } from '@vue/test-utils';
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
