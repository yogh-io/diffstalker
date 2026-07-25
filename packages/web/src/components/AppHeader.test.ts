/**
 * AppHeader tests: the finder trigger opens the overlay (disabled without
 * an active repo), and the viewer stance — the header carries NO git
 * controls (fetch/pull/push, branch, stash, reset are gone). The display
 * toggles (auto/syntax/split/follow) moved to the tab band; they are
 * covered by HeaderToggles.test.ts.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import AppHeader from './AppHeader.vue';
import { useDaemonStore } from '../stores/daemon';
import { useUiStore } from '../stores/ui';
import { makeFakeFetch } from '../testing/fakes';
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
