/**
 * RepoSwitcher tests: the popover shell only — the trigger label and the
 * open/close behaviour. What the panel CONTAINS is RepoPicker, tested in
 * RepoPicker.test.ts against the same DOM the empty state renders.
 *
 * The label is the interesting half: it names the active repo's DIRECTORY
 * for a plain repo, but the PROJECT name when the repo is one of several
 * worktrees, so the worktree name does not appear twice across the two
 * header controls.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import RepoSwitcher from './RepoSwitcher.vue';
import { useDaemonStore } from '../stores/daemon';
import { useWorktreeStore } from '../stores/worktrees';
import { makeFakeFetch, worktree } from '../testing/fakes';
import type { WorktreeInfo } from '@diffstalker/client';

const CALC = '/w/calculator';

/** The path a GET /worktrees call asked about. */
function queriedPath(url: string): string {
  return new URLSearchParams(url.split('?')[1] ?? '').get('path') ?? '';
}

/** Serve the picker's calls, and GET /worktrees from a path -> family map. */
function pickerFetch(byPath: Map<string, WorktreeInfo[]>) {
  return makeFakeFetch((call) => {
    if (call.url.startsWith('/worktrees')) {
      return { body: byPath.get(queriedPath(call.url)) ?? [] };
    }
    if (call.url.startsWith('/discovered')) return { body: { roots: [] } };
    return { status: 404, body: {} };
  }).fn;
}

async function primeWorktrees(worktrees: WorktreeInfo[], activePath: string): Promise<void> {
  const daemon = useDaemonStore();
  daemon.repos = [{ id: 'r1', path: activePath, branch: null }];
  daemon.activeRepoId = 'r1';
  vi.stubGlobal('fetch', pickerFetch(new Map([[activePath, worktrees]])));
  useWorktreeStore(); // its active-path watcher resolves on creation
  await flushPromises();
}

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  vi.stubGlobal('fetch', pickerFetch(new Map()));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('trigger label', () => {
  test('"no repo" when nothing is active', async () => {
    expect(mount(RepoSwitcher).find('.repo-label').text()).toBe('no repo');
  });

  test('the repo directory name for a single-worktree repo', async () => {
    await primeWorktrees([worktree('/proj/solo', 'main', { main: true })], '/proj/solo');
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

describe('the panel', () => {
  test('the trigger toggles the picker, and mounts it fresh each time', async () => {
    const wrapper = mount(RepoSwitcher);
    expect(wrapper.find('[data-testid="repo-picker"]').exists()).toBe(false);

    await wrapper.find('.switch-btn').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid="repo-picker"]').exists()).toBe(true);
    // v-if, not v-show: closing must UNMOUNT, since that is what resets the
    // query, the selection and the expanded state for the next open.
    await wrapper.find('.switch-btn').trigger('click');
    expect(wrapper.find('[data-testid="repo-picker"]').exists()).toBe(false);
  });

  test('the trigger reports its expanded state', async () => {
    const wrapper = mount(RepoSwitcher);
    expect(wrapper.find('.switch-btn').attributes('aria-expanded')).toBe('false');
    await wrapper.find('.switch-btn').trigger('click');
    expect(wrapper.find('.switch-btn').attributes('aria-expanded')).toBe('true');
  });
});
