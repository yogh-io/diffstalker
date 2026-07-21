/**
 * RemoteActions tests: the header's fetch/pull/push buttons over the
 * store's remote-op machine — actions call the store, in-progress
 * disables the cluster and shows the op label, error/result render in
 * the status slot (dismissed by click / clearRemoteState, results also
 * auto-clear), and push/pull reflect ahead/behind. The repo store runs
 * for real; state is set directly and actions are spied — no daemon.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { Pinia } from 'pinia';
import RemoteActions from './RemoteActions.vue';
import { useRepoStore } from '../stores/repo';
import type { RemoteOperationState } from '@diffstalker/core/types/remote';
import type { RepoSharedState } from '../stores/types';

function sharedState(overrides: Partial<RepoSharedState> = {}): RepoSharedState {
  return {
    status: null,
    hunkCounts: null,
    stashList: [],
    operationInProgress: null,
    error: null,
    isLoading: false,
    ...overrides,
  };
}

function remoteState(overrides: Partial<RemoteOperationState> = {}): RemoteOperationState {
  return { operation: null, inProgress: false, error: null, lastResult: null, ...overrides };
}

let pinia: Pinia;

function mountActions(): { wrapper: VueWrapper; repo: ReturnType<typeof useRepoStore> } {
  const repo = useRepoStore();
  repo.repoId = 'r1';
  const wrapper = mount(RemoteActions, { global: { plugins: [pinia] } });
  return { wrapper, repo };
}

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('action buttons', () => {
  test('fetch / pull / push call the store', async () => {
    const { wrapper, repo } = mountActions();
    const fetchSpy = vi.spyOn(repo, 'fetchRemote').mockResolvedValue();
    const pullSpy = vi.spyOn(repo, 'pull').mockResolvedValue();
    const pushSpy = vi.spyOn(repo, 'push').mockResolvedValue();

    await wrapper.find('[data-testid="remote-fetch"]').trigger('click');
    await wrapper.find('[data-testid="remote-pull"]').trigger('click');
    await wrapper.find('[data-testid="remote-push"]').trigger('click');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(pullSpy).toHaveBeenCalledTimes(1);
    expect(pushSpy).toHaveBeenCalledTimes(1);
  });

  test('disabled without an active repo', () => {
    const repo = useRepoStore();
    expect(repo.repoId).toBeNull();
    const wrapper = mount(RemoteActions, { global: { plugins: [pinia] } });
    for (const id of ['remote-fetch', 'remote-pull', 'remote-push']) {
      expect(wrapper.find(`[data-testid="${id}"]`).attributes('disabled')).toBeDefined();
    }
  });

  test('push and pull show the branch ahead/behind counts', async () => {
    const { wrapper, repo } = mountActions();
    repo.shared = sharedState({
      status: {
        files: [],
        branch: { current: 'main', tracking: 'origin/main', ahead: 2, behind: 3 },
        isRepo: true,
      },
    });
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-testid="remote-push"]').text()).toContain('2');
    expect(wrapper.find('[data-testid="remote-pull"]').text()).toContain('3');
    expect(wrapper.find('[data-testid="remote-push"]').attributes('title')).toContain(
      'origin/main'
    );
  });
});

describe('progress machine', () => {
  test('in progress: op label shows and the buttons disable', async () => {
    const { wrapper, repo } = mountActions();
    repo.remote = remoteState({ operation: 'push', inProgress: true });
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-testid="remote-progress"]').text()).toContain('pushing…');
    for (const id of ['remote-fetch', 'remote-pull', 'remote-push']) {
      expect(wrapper.find(`[data-testid="${id}"]`).attributes('disabled')).toBeDefined();
    }
  });

  test('every operation renders its own label', async () => {
    const { wrapper, repo } = mountActions();
    const cases: Array<[string, string]> = [
      ['stash', 'stashing…'],
      ['branchSwitch', 'switching branch…'],
      ['softReset', 'resetting…'],
    ];
    for (const [operation, label] of cases) {
      repo.remote = remoteState({
        operation: operation as RemoteOperationState['operation'],
        inProgress: true,
      });
      await wrapper.vm.$nextTick();
      expect(wrapper.find('[data-testid="remote-progress"]').text()).toContain(label);
    }
  });

  test('a finished op shows lastResult; clicking dismisses it', async () => {
    const { wrapper, repo } = mountActions();
    repo.remote = remoteState({ operation: 'push', lastResult: 'Pushed 2 commits' });
    await wrapper.vm.$nextTick();

    const result = wrapper.find('[data-testid="remote-result"]');
    expect(result.text()).toBe('Pushed 2 commits');

    await result.trigger('click');
    expect(repo.remote.lastResult).toBeNull();
    expect(wrapper.find('[data-testid="remote-result"]').exists()).toBe(false);
  });

  test('a result clears itself after a few seconds', async () => {
    vi.useFakeTimers();
    const { wrapper, repo } = mountActions();
    repo.remote = remoteState({ operation: 'fetch', lastResult: 'Fetched origin' });
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-testid="remote-result"]').exists()).toBe(true);

    vi.advanceTimersByTime(6000);
    await wrapper.vm.$nextTick();
    expect(repo.remote.lastResult).toBeNull();
    expect(wrapper.find('[data-testid="remote-result"]').exists()).toBe(false);
  });

  test('a daemon 409 surfaces as an actionable message and dismisses on click', async () => {
    const { wrapper, repo } = mountActions();
    // What the daemon answers a rejected push with (routes/shared.ts).
    repo.remote = remoteState({
      operation: 'push',
      error: 'A push operation is already in progress',
    });
    await wrapper.vm.$nextTick();

    const error = wrapper.find('[data-testid="remote-error"]');
    expect(error.text()).toBe('A push operation is already in progress');

    await error.trigger('click');
    expect(repo.remote.error).toBeNull();
    expect(wrapper.find('[data-testid="remote-error"]').exists()).toBe(false);
  });

  test('an error is never auto-cleared', async () => {
    vi.useFakeTimers();
    const { wrapper, repo } = mountActions();
    repo.remote = remoteState({ operation: 'pull', error: 'pull failed: conflicts' });
    await wrapper.vm.$nextTick();

    vi.advanceTimersByTime(60_000);
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-testid="remote-error"]').text()).toBe('pull failed: conflicts');
  });
});
