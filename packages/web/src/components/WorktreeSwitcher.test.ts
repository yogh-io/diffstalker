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
          path: `${CALC}/earlier`,
          branch: 'earlier',
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
    expect(names).toEqual(['fresh', 'earlier', 'unknown']);

    // fresh: 0 ahead is not shown, just the relative time.
    expect(rows[0].find('.meta').text()).toMatch(/^\d+ (second|minute)s? ago$/);
    // earlier: both halves, ahead-count first.
    expect(rows[1].find('.meta').text()).toMatch(/^2 commits ahead · \d+ hours? ago$/);
    // unknown: nothing resolved — no meta line at all.
    expect(rows[2].find('.meta').exists()).toBe(false);
  });
});

describe('recent / stale sections', () => {
  const DAY = 24 * 60 * 60 * 1000;

  /** A worktree last touched `ageMs` ago (null = activity unknown). */
  function wt(name: string, ageMs: number | null): WorktreeInfo {
    return {
      path: `${CALC}/${name}`,
      branch: name,
      head: 'h',
      isBare: false,
      lastActivity: ageMs === null ? null : Date.now() - ageMs,
      aheadOfBase: null,
    };
  }

  /** Two fresh worktrees + five long-untouched ones. */
  const MANY = [
    wt('now-a', 1 * DAY),
    wt('now-b', 6 * DAY),
    wt('old-a', 8 * DAY),
    wt('old-b', 9 * DAY),
    wt('old-c', 10 * DAY),
    wt('old-d', 11 * DAY),
    wt('old-e', 12 * DAY),
  ];

  async function openPanel() {
    const wrapper = mount(WorktreeSwitcher);
    await wrapper.find('[data-testid="worktree-select"]').trigger('click');
    return wrapper;
  }

  function names(wrapper: ReturnType<typeof mount>): string[] {
    return wrapper
      .findAll('[data-testid="worktree-options"] .wt-row')
      .map((r) => r.find('.name').text());
  }

  test('splits at a week and collapses stale to three behind "N more"', async () => {
    prime(MANY, `${CALC}/now-a`);
    const wrapper = await openPanel();

    expect(
      wrapper.findAll('[data-testid="worktree-options"] .group-label').map((l) => l.text())
    ).toEqual(['Recent', 'Stale']);

    // Both recent ones, but only the three freshest of the five stale.
    expect(names(wrapper)).toEqual(['now-a', 'now-b', 'old-a', 'old-b', 'old-c']);
    expect(wrapper.find('[data-testid="worktree-more"]').text()).toBe('2 more');
  });

  test('"N more" reveals the rest', async () => {
    prime(MANY, `${CALC}/now-a`);
    const wrapper = await openPanel();

    await wrapper.find('[data-testid="worktree-more"]').trigger('click');

    expect(names(wrapper)).toEqual(MANY.map((w) => w.branch));
    expect(wrapper.find('[data-testid="worktree-more"]').exists()).toBe(false);
  });

  test('the active worktree stays visible even when buried in the stale list', async () => {
    // old-e is the 5th stale entry — past the three-row preview. Being
    // unable to see which worktree you are on would be worse than the
    // extra row, so it is shown anyway (and still counted as hidden-none).
    prime(MANY, `${CALC}/old-e`);
    const wrapper = await openPanel();

    expect(names(wrapper)).toContain('old-e');
    const active = wrapper
      .findAll('[data-testid="worktree-options"] .wt-row')
      .filter((r) => r.classes().includes('active'));
    expect(active).toHaveLength(1);
    expect(active[0].find('.name').text()).toBe('old-e');
    expect(wrapper.find('[data-testid="worktree-more"]').text()).toBe('1 more');
  });

  test('no section headings when nothing is stale', async () => {
    prime([wt('now-a', 1 * DAY), wt('now-b', 2 * DAY)], `${CALC}/now-a`);
    const wrapper = await openPanel();

    expect(wrapper.find('[data-testid="worktree-options"] .group-label').exists()).toBe(false);
    expect(names(wrapper)).toEqual(['now-a', 'now-b']);
  });

  test('reopening collapses the stale list again', async () => {
    prime(MANY, `${CALC}/now-a`);
    const wrapper = await openPanel();
    await wrapper.find('[data-testid="worktree-more"]').trigger('click');
    expect(names(wrapper)).toHaveLength(MANY.length);

    const trigger = wrapper.find('[data-testid="worktree-select"]');
    await trigger.trigger('click'); // close
    await trigger.trigger('click'); // reopen

    expect(names(wrapper)).toEqual(['now-a', 'now-b', 'old-a', 'old-b', 'old-c']);
  });
});
