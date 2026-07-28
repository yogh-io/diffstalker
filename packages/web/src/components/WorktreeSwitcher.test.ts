/**
 * WorktreeSwitcher tests: hidden for a single-worktree repo; for a repo
 * with several worktrees the trigger button shows ONLY the current
 * worktree's name (no meta — a stale-looking timestamp must not sit in
 * the closed control), and its dropdown lists every worktree sorted
 * most-recently-active first, each with a second line noting commits
 * ahead of base and how long ago it was edited. Picking a row opens it
 * (POST /repos). The worktree list comes from the daemon store (set
 * directly here).
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
  { path: `${CALC}/main`, branch: 'main', head: 'aaa', isBare: false, lastActivity: null, aheadOfBase: null },
  { path: `${CALC}/fix-a`, branch: 'fix-a', head: 'bbb', isBare: false, lastActivity: null, aheadOfBase: null },
  { path: `${CALC}/detached`, branch: null, head: 'ccc', isBare: false, lastActivity: null, aheadOfBase: null },
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
    prime(
      [
        {
          path: `${CALC}/only`,
          branch: 'only',
          head: 'aaa',
          isBare: false,
          lastActivity: null,
          aheadOfBase: null,
        },
      ],
      `${CALC}/only`
    );
    const wrapper = mount(WorktreeSwitcher);
    expect(wrapper.find('[data-testid="worktree-select"]').exists()).toBe(false);
  });
});

describe('multi-worktree repo', () => {
  test('the closed trigger shows only the current worktree name, no meta', () => {
    prime(
      [
        {
          path: `${CALC}/fix-a`,
          branch: 'fix-a',
          head: 'a',
          isBare: false,
          lastActivity: Date.now() - 60_000,
          aheadOfBase: 3,
        },
        {
          path: `${CALC}/main`,
          branch: 'main',
          head: 'b',
          isBare: false,
          lastActivity: Date.now() - 120_000,
          aheadOfBase: 0,
        },
      ],
      `${CALC}/fix-a`
    );
    const trigger = mount(WorktreeSwitcher).find('[data-testid="worktree-select"]');
    expect(trigger.find('.wt-name').text()).toBe('fix-a');
  });

  test('opening the dropdown lists worktrees, active one highlighted, detached -> dir name', async () => {
    prime(WORKTREES, `${CALC}/fix-a`);
    const wrapper = mount(WorktreeSwitcher);
    await wrapper.find('[data-testid="worktree-select"]').trigger('click');

    const rows = wrapper.findAll('[data-testid="worktree-options"] .wt-row');
    expect(rows.map((r) => r.find('.name').text())).toEqual(['main', 'fix-a', 'detached']);
    expect(rows[1].classes()).toContain('active');
    expect(rows[0].classes()).not.toContain('active');
  });

  test('picking a different worktree opens it by path and closes the dropdown', async () => {
    prime(WORKTREES, `${CALC}/fix-a`);
    const wrapper = mount(WorktreeSwitcher);
    await wrapper.find('[data-testid="worktree-select"]').trigger('click');

    const rows = wrapper.findAll('[data-testid="worktree-options"] .wt-row');
    await rows[0].trigger('click'); // 'main'
    await flushPromises();

    expect(posted).toContainEqual({ path: `${CALC}/main` });
    expect(wrapper.find('[data-testid="worktree-options"]').exists()).toBe(false);
  });

  test('sorts by most-recently-active first and labels ahead-count + how long ago', async () => {
    const now = Date.now();
    prime(
      [
        {
          path: `${CALC}/stale`,
          branch: 'stale',
          head: 'a',
          isBare: false,
          lastActivity: now - 3 * 60 * 60 * 1000,
          aheadOfBase: 2,
        },
        {
          path: `${CALC}/fresh`,
          branch: 'fresh',
          head: 'b',
          isBare: false,
          lastActivity: now - 60 * 1000,
          aheadOfBase: 0,
        },
        {
          path: `${CALC}/unknown`,
          branch: 'unknown',
          head: 'c',
          isBare: false,
          lastActivity: null,
          aheadOfBase: null,
        },
      ],
      `${CALC}/fresh`
    );
    const wrapper = mount(WorktreeSwitcher);
    await wrapper.find('[data-testid="worktree-select"]').trigger('click');

    const rows = wrapper.findAll('[data-testid="worktree-options"] .wt-row');
    const names = rows.map((r) => r.find('.name').text());
    expect(names).toEqual(['fresh', 'stale', 'unknown']);

    // fresh: 0 ahead is not shown, just the relative time.
    expect(rows[0].find('.meta').text()).toMatch(/^\d+ (second|minute)s? ago$/);
    // stale: both halves, ahead-count first.
    expect(rows[1].find('.meta').text()).toMatch(/^2 commits ahead · \d+ hours? ago$/);
    // unknown: nothing resolved — no meta line at all.
    expect(rows[2].find('.meta').exists()).toBe(false);
  });
});
