/**
 * WorktreeSwitcher tests: hidden for a single-worktree repo; for a repo
 * with several worktrees it shows the project name (common parent dir) +
 * a select of the worktrees (branch-labeled), with the active worktree
 * selected; picking another opens it by path (POST /repos).
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import WorktreeSwitcher from './WorktreeSwitcher.vue';
import { useDaemonStore } from '../stores/daemon';
import { makeFakeFetch } from '../testing/fakes';
import type { WorktreeInfo } from '@diffstalker/core/git/worktree';

const CALC = '/home/u/gitRepos/calculator';
const WORKTREES: WorktreeInfo[] = [
  { path: `${CALC}/.bare`, branch: null, head: null, isBare: true },
  { path: `${CALC}/main`, branch: 'main', head: 'aaa', isBare: false },
  { path: `${CALC}/fix-a`, branch: 'fix-a', head: 'bbb', isBare: false },
  { path: `${CALC}/detached`, branch: null, head: 'ccc', isBare: false },
];

let posted: Array<{ path: string }>;

function stubFetch(worktrees: WorktreeInfo[]): void {
  posted = [];
  vi.stubGlobal(
    'fetch',
    makeFakeFetch((call) => {
      if (call.method === 'GET' && /\/repos\/[^/]+\/worktrees$/.test(call.url)) {
        return { body: worktrees };
      }
      if (call.method === 'POST' && call.url === '/repos') {
        const body = call.body as { path: string };
        posted.push(body);
        return { body: { id: 'other', path: body.path } };
      }
      return { status: 404, body: {} };
    }).fn
  );
}

function primeActive(path: string): void {
  const daemon = useDaemonStore();
  daemon.repos = [{ id: 'r1', path, branch: null }];
  daemon.activeRepoId = 'r1';
}

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('visibility', () => {
  test('hidden when the repo has no active id', async () => {
    stubFetch(WORKTREES);
    const wrapper = mount(WorktreeSwitcher);
    await flushPromises();
    expect(wrapper.find('[data-testid="worktree-select"]').exists()).toBe(false);
  });

  test('hidden when there is only one (non-bare) worktree', async () => {
    stubFetch([
      { path: `${CALC}/only`, branch: 'only', head: 'aaa', isBare: false },
      { path: `${CALC}/.bare`, branch: null, head: null, isBare: true },
    ]);
    primeActive(`${CALC}/only`);
    const wrapper = mount(WorktreeSwitcher);
    await flushPromises();
    expect(wrapper.find('[data-testid="worktree-select"]').exists()).toBe(false);
  });
});

describe('multi-worktree repo', () => {
  test('shows the project name + a branch-labeled select, active worktree selected', async () => {
    stubFetch(WORKTREES);
    primeActive(`${CALC}/fix-a`);
    const wrapper = mount(WorktreeSwitcher);
    await flushPromises();

    expect(wrapper.find('.project').text()).toBe('calculator');

    const select = wrapper.find('[data-testid="worktree-select"]');
    expect(select.exists()).toBe(true);
    // The bare entry is filtered out; the three working trees remain.
    const options = select.findAll('option');
    expect(options.map((o) => o.text())).toEqual(['main', 'fix-a', 'detached']);
    // Detached (no branch) falls back to its dir name.
    expect(options[2].text()).toBe('detached');
    // The active worktree is the selected value.
    expect((select.element as HTMLSelectElement).value).toBe(`${CALC}/fix-a`);
  });

  test('picking a different worktree opens it by path', async () => {
    stubFetch(WORKTREES);
    primeActive(`${CALC}/fix-a`);
    const wrapper = mount(WorktreeSwitcher);
    await flushPromises();

    const select = wrapper.find('[data-testid="worktree-select"]');
    await select.setValue(`${CALC}/main`);
    await flushPromises();

    expect(posted).toContainEqual({ path: `${CALC}/main` });
  });
});
