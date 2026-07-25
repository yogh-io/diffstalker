/**
 * WorktreeSwitcher tests: hidden for a single-worktree repo; for a repo
 * with several worktrees it shows a branch-labeled select with the active
 * worktree selected; picking another opens it by path (POST /repos). The
 * worktree list comes from the daemon store (set directly here).
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import WorktreeSwitcher from './WorktreeSwitcher.vue';
import { useDaemonStore } from '../stores/daemon';
import { makeFakeFetch } from '../testing/fakes';
import type { WorktreeInfo } from '@diffstalker/client';

const CALC = '/home/u/gitRepos/calculator';
const WORKTREES: WorktreeInfo[] = [
  { path: `${CALC}/main`, branch: 'main', head: 'aaa', isBare: false },
  { path: `${CALC}/fix-a`, branch: 'fix-a', head: 'bbb', isBare: false },
  { path: `${CALC}/detached`, branch: null, head: 'ccc', isBare: false },
];

let posted: Array<{ path: string }>;

function prime(worktrees: WorktreeInfo[], activePath: string): void {
  const daemon = useDaemonStore();
  daemon.repos = [{ id: 'r1', path: activePath, branch: null }];
  daemon.activeRepoId = 'r1';
  daemon.worktrees = worktrees;
}

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  posted = [];
  vi.stubGlobal(
    'fetch',
    makeFakeFetch((call) => {
      if (call.method === 'POST' && call.url === '/repos') {
        const body = call.body as { path: string };
        posted.push(body);
        return { body: { id: 'other', path: body.path } };
      }
      return { status: 404, body: {} };
    }).fn
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('visibility', () => {
  test('hidden when no repo is active', () => {
    const wrapper = mount(WorktreeSwitcher);
    expect(wrapper.find('[data-testid="worktree-select"]').exists()).toBe(false);
  });

  test('hidden when there is only one worktree', () => {
    prime([{ path: `${CALC}/only`, branch: 'only', head: 'aaa', isBare: false }], `${CALC}/only`);
    const wrapper = mount(WorktreeSwitcher);
    expect(wrapper.find('[data-testid="worktree-select"]').exists()).toBe(false);
  });
});

describe('multi-worktree repo', () => {
  test('branch-labeled options, active worktree selected, detached -> dir name', () => {
    prime(WORKTREES, `${CALC}/fix-a`);
    const select = mount(WorktreeSwitcher).find('[data-testid="worktree-select"]');

    expect(select.exists()).toBe(true);
    expect(select.findAll('option').map((o) => o.text())).toEqual(['main', 'fix-a', 'detached']);
    expect((select.element as HTMLSelectElement).value).toBe(`${CALC}/fix-a`);
  });

  test('picking a different worktree opens it by path', async () => {
    prime(WORKTREES, `${CALC}/fix-a`);
    const select = mount(WorktreeSwitcher).find('[data-testid="worktree-select"]');

    await select.setValue(`${CALC}/main`);
    await flushPromises();

    expect(posted).toContainEqual({ path: `${CALC}/main` });
  });
});
