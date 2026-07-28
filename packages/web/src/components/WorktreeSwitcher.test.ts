/**
 * WorktreeSwitcher tests: hidden for a single-worktree repo; for a repo
 * with several worktrees the trigger button shows ONLY the current
 * worktree's name (no meta — a stale-looking timestamp must not sit in
 * the closed control), and its dropdown lists every worktree sorted
 * most-recently-active first, each with a second line noting commits
 * ahead of base and how long ago it was edited. Picking a row opens it
 * (POST /repos). The worktree list is resolved the real way — through
 * GET /worktrees?path= into the worktree store — so these exercise the
 * same path the app does.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import WorktreeSwitcher from './WorktreeSwitcher.vue';
import { useDaemonStore } from '../stores/daemon';
import { useWorktreeStore } from '../stores/worktrees';
import { makeFakeFetch, worktree } from '../testing/fakes';
import type { WorktreeInfo } from '@diffstalker/client';

const CALC = '/w/calculator';
// A bare-repo layout: the bare git dir is the main entry, worktrees sit
// beside it. The switcher must not care which layout this is.
const WORKTREES: WorktreeInfo[] = [
  worktree(`${CALC}/.bare`, null, { main: true, bare: true }),
  worktree(`${CALC}/main`, 'main'),
  worktree(`${CALC}/fix-a`, 'fix-a'),
  worktree(`${CALC}/detached`, null),
];

let posted: Array<{ path: string }>;
/** What GET /worktrees?path= answers, per queried path. */
let worktreesByPath: Map<string, WorktreeInfo[]>;

/** The path a GET /worktrees call asked about. */
function queriedPath(url: string): string {
  return new URLSearchParams(url.split('?')[1] ?? '').get('path') ?? '';
}

async function prime(worktrees: WorktreeInfo[], activePath: string): Promise<void> {
  const daemon = useDaemonStore();
  daemon.repos = [{ id: 'r1', path: activePath, branch: null }];
  daemon.activeRepoId = 'r1';
  worktreesByPath.set(activePath, worktrees);
  useWorktreeStore(); // its active-path watcher resolves on creation
  await flushPromises();
}

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  posted = [];
  worktreesByPath = new Map();
  vi.stubGlobal(
    'fetch',
    makeFakeFetch((call) => {
      if (call.method === 'POST' && call.url === '/repos') {
        const body = call.body as { path: string };
        posted.push(body);
        return { body: { id: 'other', path: body.path } };
      }
      if (call.method === 'GET' && call.url.startsWith('/worktrees')) {
        return { body: worktreesByPath.get(queriedPath(call.url)) ?? [] };
      }
      return { status: 404, body: {} };
    }).fn
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('visibility', () => {
  test('hidden when no repo is active', async () => {
    const wrapper = mount(WorktreeSwitcher);
    expect(wrapper.find('[data-testid="worktree-select"]').exists()).toBe(false);
  });

  test('hidden when there is only one worktree', async () => {
    await prime(
      [
        {
          path: `${CALC}/only`,
          branch: 'only',
          head: 'aaa',
          isMain: false,
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
  test('the closed trigger shows only the current worktree name, no meta', async () => {
    await prime(
      [
        {
          path: `${CALC}/fix-a`,
          branch: 'fix-a',
          head: 'a',
          isMain: false,
          isBare: false,
          lastActivity: Date.now() - 60_000,
          aheadOfBase: 3,
        },
        {
          path: `${CALC}/main`,
          branch: 'main',
          head: 'b',
          isMain: false,
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
    await prime(WORKTREES, `${CALC}/fix-a`);
    const wrapper = mount(WorktreeSwitcher);
    await wrapper.find('[data-testid="worktree-select"]').trigger('click');

    const rows = wrapper.findAll('[data-testid="worktree-options"] .wt-row');
    expect(rows.map((r) => r.find('.name').text())).toEqual(['main', 'fix-a', 'detached']);
    expect(rows[1].classes()).toContain('active');
    expect(rows[0].classes()).not.toContain('active');
  });

  test('picking a different worktree opens it by path and closes the dropdown', async () => {
    await prime(WORKTREES, `${CALC}/fix-a`);
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
    await prime(
      [
        {
          path: `${CALC}/earlier`,
          branch: 'earlier',
          head: 'a',
          isMain: false,
          isBare: false,
          lastActivity: now - 3 * 60 * 60 * 1000,
          aheadOfBase: 2,
        },
        {
          path: `${CALC}/fresh`,
          branch: 'fresh',
          head: 'b',
          isMain: false,
          isBare: false,
          lastActivity: now - 60 * 1000,
          aheadOfBase: 0,
        },
        {
          path: `${CALC}/unknown`,
          branch: 'unknown',
          head: 'c',
          isMain: false,
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
      isMain: false,
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
    await prime(MANY, `${CALC}/now-a`);
    const wrapper = await openPanel();

    expect(
      wrapper.findAll('[data-testid="worktree-options"] .group-label').map((l) => l.text())
    ).toEqual(['Recent', 'Stale']);

    // Both recent ones, but only the three freshest of the five stale.
    expect(names(wrapper)).toEqual(['now-a', 'now-b', 'old-a', 'old-b', 'old-c']);
    expect(wrapper.find('[data-testid="worktree-more"]').text()).toBe('2 more');
  });

  test('"N more" reveals the rest', async () => {
    await prime(MANY, `${CALC}/now-a`);
    const wrapper = await openPanel();

    await wrapper.find('[data-testid="worktree-more"]').trigger('click');

    expect(names(wrapper)).toEqual(MANY.map((w) => w.branch));
    expect(wrapper.find('[data-testid="worktree-more"]').exists()).toBe(false);
  });

  test('the active worktree stays visible even when buried in the stale list', async () => {
    // old-e is the 5th stale entry — past the three-row preview. Being
    // unable to see which worktree you are on would be worse than the
    // extra row, so it is shown anyway (and still counted as hidden-none).
    await prime(MANY, `${CALC}/old-e`);
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
    await prime([wt('now-a', 1 * DAY), wt('now-b', 2 * DAY)], `${CALC}/now-a`);
    const wrapper = await openPanel();

    expect(wrapper.find('[data-testid="worktree-options"] .group-label').exists()).toBe(false);
    expect(names(wrapper)).toEqual(['now-a', 'now-b']);
  });

  test('reopening collapses the stale list again', async () => {
    await prime(MANY, `${CALC}/now-a`);
    const wrapper = await openPanel();
    await wrapper.find('[data-testid="worktree-more"]').trigger('click');
    expect(names(wrapper)).toHaveLength(MANY.length);

    const trigger = wrapper.find('[data-testid="worktree-select"]');
    await trigger.trigger('click'); // close
    await trigger.trigger('click'); // reopen

    expect(names(wrapper)).toEqual(['now-a', 'now-b', 'old-a', 'old-b', 'old-c']);
  });
});
