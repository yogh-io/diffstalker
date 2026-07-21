/**
 * OperationBanner tests: renders nothing on a clean repo; a wedged
 * rebase offers Abort + Continue, while cherry-pick / revert / merge
 * offer Abort only (POST /rebase-continue is rebase-only — the daemon
 * 409s it otherwise); the buttons call the store; an in-flight
 * abort/continue replaces the buttons with its progress label.
 */

import { test, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { Pinia } from 'pinia';
import OperationBanner from './OperationBanner.vue';
import { useRepoStore } from '../stores/repo';
import type { InProgressOperation } from '@diffstalker/core/git/status';

let pinia: Pinia;

function mountBanner(operation: InProgressOperation | null): {
  wrapper: VueWrapper;
  repo: ReturnType<typeof useRepoStore>;
} {
  const repo = useRepoStore();
  repo.repoId = 'r1';
  repo.shared = {
    status: null,
    hunkCounts: null,
    stashList: [],
    operationInProgress: operation,
    error: null,
    isLoading: false,
  };
  const wrapper = mount(OperationBanner, { global: { plugins: [pinia] } });
  return { wrapper, repo };
}

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
});

test('clean repo: no banner', () => {
  const { wrapper } = mountBanner(null);
  expect(wrapper.find('[data-testid="operation-banner"]').exists()).toBe(false);
});

test('mid-rebase: names the state, Abort and Continue call the store', async () => {
  const { wrapper, repo } = mountBanner('rebase');
  const abortSpy = vi.spyOn(repo, 'abort').mockResolvedValue();
  const continueSpy = vi.spyOn(repo, 'rebaseContinue').mockResolvedValue();

  const banner = wrapper.find('[data-testid="operation-banner"]');
  expect(banner.text()).toContain('rebase in progress');

  await wrapper.find('[data-testid="banner-continue"]').trigger('click');
  expect(continueSpy).toHaveBeenCalledTimes(1);

  await wrapper.find('[data-testid="banner-abort"]').trigger('click');
  expect(abortSpy).toHaveBeenCalledTimes(1);
});

test.each(['cherry-pick', 'revert', 'merge'] as const)(
  'mid-%s: Abort only — continue is rebase-only',
  (operation) => {
    const { wrapper } = mountBanner(operation);
    const banner = wrapper.find('[data-testid="operation-banner"]');
    expect(banner.text()).toContain(`${operation} in progress`);
    expect(wrapper.find('[data-testid="banner-abort"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="banner-continue"]').exists()).toBe(false);
    // Non-rebase ops finish by committing the resolution; say so.
    expect(banner.text()).toContain('commit');
  }
);

test('an in-flight abort replaces the buttons with its progress label', async () => {
  const { wrapper, repo } = mountBanner('cherry-pick');
  repo.remote = { operation: 'abort', inProgress: true, error: null, lastResult: null };
  await wrapper.vm.$nextTick();

  expect(wrapper.find('[data-testid="banner-progress"]').text()).toBe('aborting…');
  expect(wrapper.find('[data-testid="banner-abort"]').exists()).toBe(false);
});

test('the banner clears when the wire state resolves the operation', async () => {
  const { wrapper, repo } = mountBanner('rebase');
  expect(wrapper.find('[data-testid="operation-banner"]').exists()).toBe(true);

  repo.shared = { ...repo.shared, operationInProgress: null };
  await wrapper.vm.$nextTick();
  expect(wrapper.find('[data-testid="operation-banner"]').exists()).toBe(false);
});
