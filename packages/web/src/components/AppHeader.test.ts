/**
 * AppHeader tests: the finder trigger opens the overlay (disabled without
 * an active repo), and the viewer stance — the header carries NO git
 * controls (fetch/pull/push, branch, stash, reset are gone). The display
 * toggles (auto/syntax/split/follow) moved to the tab band; they are
 * covered by HeaderToggles.test.ts.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import AppHeader from './AppHeader.vue';
import { useDaemonStore } from '../stores/daemon';
import { useRepoStore } from '../stores/repo';
import { useUiStore } from '../stores/ui';
import { useWorktreeStore } from '../stores/worktrees';
import { makeFakeFetch, worktree } from '../testing/fakes';
import type { FollowState } from '@diffstalker/client';

function followState(overrides: Partial<FollowState> = {}): FollowState {
  return {
    targetFile: '/home/u/.cache/diffstalker/target',
    enabled: true,
    followedRepoId: null,
    followedPath: null,
    ...overrides,
  };
}

function mountHeader(): VueWrapper {
  return mount(AppHeader);
}

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  vi.stubGlobal('fetch', makeFakeFetch(() => ({ status: 404, body: {} })).fn);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('viewer stance (read-only)', () => {
  test('the header carries NO fetch/pull/push/branch/stash controls', () => {
    useDaemonStore().follow = followState();
    useDaemonStore().activeRepoId = 'r1';
    const wrapper = mountHeader();

    for (const id of ['remote-fetch', 'remote-pull', 'remote-push', 'actions-trigger']) {
      expect(wrapper.find(`[data-testid="${id}"]`).exists()).toBe(false);
    }
    // The only buttons left are the read-side chrome: repo switcher, finder
    // trigger, theme switcher (the display toggles moved to the tab band).
    const labels = wrapper.findAll('button').map((b) => b.text());
    expect(labels.join(' ')).not.toMatch(/fetch|pull|push|stash|branch|reset/i);
  });
});

describe('finder trigger', () => {
  test('disabled without an active repo', () => {
    const wrapper = mountHeader();
    expect(wrapper.find('[data-testid="finder-open"]').attributes('disabled')).toBeDefined();
  });

  test('with a repo active, clicking opens the finder overlay', async () => {
    useDaemonStore().activeRepoId = 'r1';
    const ui = useUiStore();
    const wrapper = mountHeader();

    await wrapper.find('[data-testid="finder-open"]').trigger('click');
    expect(ui.activeOverlay).toBe('finder');
  });
});

describe('branch breadcrumb', () => {
  const CALC = '/w/calculator';

  /** Point the header at one worktree of a multi-worktree project. */
  async function primeWorktree(
    dir: string,
    branch: string,
    tracking: string | null,
    siblings: string[] = ['fix-bbox']
  ): Promise<VueWrapper> {
    const daemon = useDaemonStore();
    const repo = useRepoStore();
    const activePath = `${CALC}/${dir}`;
    daemon.repos = [{ id: 'r1', path: activePath, branch }];
    daemon.activeRepoId = 'r1';
    repo.shared = {
      ...repo.shared,
      status: {
        files: [],
        branch: { current: branch, tracking: tracking ?? undefined, ahead: 0, behind: 0 },
        isRepo: true,
      },
    };
    vi.stubGlobal(
      'fetch',
      makeFakeFetch((call) =>
        call.url.startsWith('/worktrees')
          ? {
              body: [
                worktree(`${CALC}/.bare`, null, { main: true, bare: true }),
                worktree(activePath, branch),
                ...siblings.map((s) => worktree(`${CALC}/${s}`, s)),
              ],
            }
          : { status: 404, body: {} }
      ).fn
    );
    useWorktreeStore();
    await flushPromises();
    return mountHeader();
  }

  test('the branch IS shown when the worktree directory has a different name', async () => {
    // The reported case: a `main` worktree with a feature branch checked
    // out. The breadcrumb used to suppress the branch name believing the
    // worktree select displayed it — the select shows the DIRECTORY.
    const wrapper = await primeWorktree(
      'main',
      'aer-4569-mobile-machinery-terms',
      'origin/aer-4569-mobile-machinery-terms'
    );

    expect(wrapper.find('[data-testid="branch-info"] .branch-name').text()).toBe(
      'aer-4569-mobile-machinery-terms'
    );
  });

  test('the branch is dropped when the worktree select already shows that name', async () => {
    const wrapper = await primeWorktree('fix-bbox', 'fix-bbox', 'origin/fix-bbox', ['main']);

    expect(wrapper.find('[data-testid="branch-info"] .branch-name').exists()).toBe(false);
  });

  test('a same-named upstream shortens to its remote', async () => {
    const wrapper = await primeWorktree('main', 'aer-4569', 'origin/aer-4569');
    const tracking = wrapper.find('[data-testid="branch-info"] .tracking');

    expect(tracking.text()).toBe('origin');
    // The full ref stays available on hover.
    expect(tracking.attributes('title')).toBe('origin/aer-4569');
  });

  test('an upstream with a DIFFERENT branch name is spelled out', async () => {
    const wrapper = await primeWorktree('main', 'aer-4569', 'upstream/release-2025.1');

    expect(wrapper.find('[data-testid="branch-info"] .tracking').text()).toBe(
      'upstream/release-2025.1'
    );
  });
});
