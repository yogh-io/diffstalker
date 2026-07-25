/**
 * HeaderToggles tests: the four home-row display toggles (a s d f) —
 * compact dot+word pills whose lit state (aria-pressed) reflects the
 * store, click flips the store, and the follow pill is hidden until follow
 * state loads, disabled without a target, and NAMED BY REPO ID (in its
 * aria-label / title), not by the hook file path.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import HeaderToggles from './HeaderToggles.vue';
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

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  vi.stubGlobal('fetch', makeFakeFetch(() => ({ status: 404, body: {} })).fn);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('auto toggle (a)', () => {
  test('off by default; clicking flips autoModeEnabled and aria-pressed', async () => {
    const ui = useUiStore();
    const toggle = mount(HeaderToggles).find('[data-testid="auto-toggle"]');

    expect(toggle.text()).toBe('auto');
    expect(toggle.attributes('aria-pressed')).toBe('false');

    await toggle.trigger('click');
    expect(ui.autoModeEnabled).toBe(true);
    expect(toggle.attributes('aria-pressed')).toBe('true');
  });

  test('reflects a stored auto-mode preference on mount', () => {
    localStorage.setItem('diffstalker:prefs', JSON.stringify({ autoMode: true }));
    const toggle = mount(HeaderToggles).find('[data-testid="auto-toggle"]');
    expect(toggle.attributes('aria-pressed')).toBe('true');
  });
});

describe('syntax toggle (s)', () => {
  test('off by default; clicking flips diffSyntaxEnabled', async () => {
    const ui = useUiStore();
    const toggle = mount(HeaderToggles).find('[data-testid="syntax-toggle"]');

    expect(toggle.text()).toBe('syntax');
    expect(toggle.attributes('aria-pressed')).toBe('false');

    await toggle.trigger('click');
    expect(ui.diffSyntaxEnabled).toBe(true);
    expect(toggle.attributes('aria-pressed')).toBe('true');
  });
});

describe('split toggle (d)', () => {
  test('unified by default; clicking flips diffMode to split', async () => {
    const ui = useUiStore();
    const toggle = mount(HeaderToggles).find('[data-testid="split-toggle"]');

    expect(toggle.text()).toBe('diff');
    expect(toggle.attributes('aria-pressed')).toBe('false');

    await toggle.trigger('click');
    expect(ui.diffMode).toBe('split');
    expect(toggle.attributes('aria-pressed')).toBe('true');
  });

  test('reflects a stored split preference on mount', () => {
    localStorage.setItem('diffstalker:prefs', JSON.stringify({ diffMode: 'split' }));
    const toggle = mount(HeaderToggles).find('[data-testid="split-toggle"]');
    expect(toggle.attributes('aria-pressed')).toBe('true');
  });
});

describe('follow toggle (f)', () => {
  test('hidden until the daemon follow state is loaded', () => {
    expect(mount(HeaderToggles).find('[data-testid="follow-toggle"]').exists()).toBe(false);
  });

  test('no hook file: disabled, aria-label reports no target', () => {
    useDaemonStore().follow = followState({ targetFile: null, enabled: false });
    const toggle = mount(HeaderToggles).find('[data-testid="follow-toggle"]');
    expect(toggle.text()).toBe('follow');
    expect(toggle.attributes('disabled')).toBeDefined();
    expect(toggle.attributes('aria-label')).toContain('no target');
  });

  test('clicking flips followEnabled', async () => {
    const daemon = useDaemonStore();
    daemon.follow = followState();
    const toggle = mount(HeaderToggles).find('[data-testid="follow-toggle"]');

    expect(toggle.attributes('aria-pressed')).toBe('true');
    await toggle.trigger('click');
    expect(daemon.followEnabled).toBe(false);
    expect(toggle.attributes('aria-pressed')).toBe('false');
  });

  test('names the followed repo by id, not by the hook path (which may be a file)', () => {
    // A follow-change event carries the hook file CONTENT as `path` — often
    // a file inside the repo. The name must come from the followed REPO (by
    // id, the same repo the diffs switch to), not basename that file path.
    const daemon = useDaemonStore();
    daemon.repos = [{ id: 'r1', path: '/home/u/projects/calc', branch: 'main' }];
    daemon.follow = followState({
      followedRepoId: 'r1',
      followedPath: '/home/u/projects/calc/src/e2e/CommonPage.ts',
    });
    const toggle = mount(HeaderToggles).find('[data-testid="follow-toggle"]');
    expect(toggle.attributes('aria-label')).toBe('Follow mode (f): following calc');
    expect(toggle.attributes('title')).toContain('/home/u/projects/calc');
  });
});
