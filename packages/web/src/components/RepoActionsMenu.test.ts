/**
 * RepoActionsMenu tests: the branch / stash / soft-reset popover. The
 * branch list loads on open (current marked, inert), picking calls
 * switchBranch and the create form calls createBranch; stash + per-entry
 * pop drive stash/stashPop; soft reset only fires through its inline
 * confirm naming the count; everything disables while a remote op runs;
 * Esc closes the panel (returning focus to the trigger); a repo switch
 * closes it and clears every piece of transient state; a failed branch
 * load shows a hint instead of rejecting unhandled; the reset count
 * sanitizes to a positive integer. Store state set directly, actions
 * spied.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { Pinia } from 'pinia';
import RepoActionsMenu from './RepoActionsMenu.vue';
import { useRepoStore } from '../stores/repo';
import type { LocalBranch } from '@diffstalker/core/git/status';
import type { RepoSharedState } from '../stores/types';

const BRANCHES: LocalBranch[] = [
  { name: 'main', current: true, tracking: 'origin/main' },
  { name: 'feat-x', current: false },
];

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

let pinia: Pinia;

async function mountOpen(branches: LocalBranch[] = BRANCHES): Promise<{
  wrapper: VueWrapper;
  repo: ReturnType<typeof useRepoStore>;
}> {
  const repo = useRepoStore();
  repo.repoId = 'r1';
  vi.spyOn(repo, 'listBranches').mockResolvedValue(branches);
  const wrapper = mount(RepoActionsMenu, {
    global: { plugins: [pinia] },
    attachTo: document.body,
  });
  await wrapper.find('[data-testid="actions-trigger"]').trigger('click');
  await flushPromises();
  return { wrapper, repo };
}

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('trigger', () => {
  test('disabled without an active repo', () => {
    const wrapper = mount(RepoActionsMenu, { global: { plugins: [pinia] } });
    expect(wrapper.find('[data-testid="actions-trigger"]').attributes('disabled')).toBeDefined();
  });

  test('Escape closes the panel and returns focus to the trigger', async () => {
    const { wrapper } = await mountOpen();
    expect(wrapper.find('[data-testid="actions-panel"]').exists()).toBe(true);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-testid="actions-panel"]').exists()).toBe(false);
    expect(document.activeElement).toBe(wrapper.find('[data-testid="actions-trigger"]').element);
  });

  test('an action close returns focus to the trigger too', async () => {
    const { wrapper, repo } = await mountOpen();
    vi.spyOn(repo, 'switchBranch').mockResolvedValue();

    await wrapper.findAll('[data-testid="branch-list"] .row')[1].trigger('click');
    expect(document.activeElement).toBe(wrapper.find('[data-testid="actions-trigger"]').element);
  });
});

describe('repo switch', () => {
  test('a repo switch closes the panel — a stale menu cannot act on the new repo', async () => {
    const { wrapper, repo } = await mountOpen();
    const switchSpy = vi.spyOn(repo, 'switchBranch').mockResolvedValue();
    expect(wrapper.find('[data-testid="actions-panel"]').exists()).toBe(true);

    // Follow mode (or the switcher) activates another repo.
    repo.repoId = 'r2';
    repo.repoPath = '/other';
    await wrapper.vm.$nextTick();

    // The panel is gone; the old repo's branch rows cannot be clicked.
    expect(wrapper.find('[data-testid="actions-panel"]').exists()).toBe(false);
    expect(switchSpy).not.toHaveBeenCalled();
  });

  test('a repo switch clears ALL transient state, not just visibility', async () => {
    const { wrapper, repo } = await mountOpen();
    await wrapper.find('[data-testid="new-branch-name"]').setValue('feat-y');
    await wrapper.find('[data-testid="stash-message"]').setValue('wip');
    await wrapper.find('[data-testid="reset-count"]').setValue(5);
    await wrapper.find('[data-testid="reset-start"]').trigger('click');
    expect(wrapper.find('[data-testid="reset-confirm"]').exists()).toBe(true);

    repo.repoId = 'r2';
    repo.repoPath = '/other';
    await wrapper.vm.$nextTick();

    // Reopen on the new repo: fresh defaults everywhere — no pending
    // reset confirm, no typed names, count back to 1, branch list reloads.
    await wrapper.find('[data-testid="actions-trigger"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid="reset-confirm"]').exists()).toBe(false);
    expect((wrapper.find('[data-testid="new-branch-name"]').element as HTMLInputElement).value).toBe('');
    expect((wrapper.find('[data-testid="stash-message"]').element as HTMLInputElement).value).toBe('');
    expect((wrapper.find('[data-testid="reset-count"]').element as HTMLInputElement).value).toBe('1');
    expect(repo.listBranches).toHaveBeenCalledTimes(2);
  });
});

describe('branch load failure', () => {
  test('a rejected listBranches shows the hint and leaves the list empty', async () => {
    const repo = useRepoStore();
    repo.repoId = 'r1';
    vi.spyOn(repo, 'listBranches').mockRejectedValue(new Error('git branch failed'));
    const wrapper = mount(RepoActionsMenu, {
      global: { plugins: [pinia] },
      attachTo: document.body,
    });

    await wrapper.find('[data-testid="actions-trigger"]').trigger('click');
    await flushPromises();

    expect(wrapper.find('[data-testid="branches-error"]').text()).toBe("couldn't load branches");
    expect(wrapper.find('[data-testid="branch-list"]').exists()).toBe(false);
  });
});

describe('branches', () => {
  test('opening loads the branch list with the current branch marked and inert', async () => {
    const { wrapper, repo } = await mountOpen();
    expect(repo.listBranches).toHaveBeenCalledTimes(1);

    const rows = wrapper.findAll('[data-testid="branch-list"] .row');
    expect(rows.map((row) => row.text())).toEqual([
      expect.stringContaining('main'),
      expect.stringContaining('feat-x'),
    ]);
    expect(rows[0].attributes('aria-current')).toBe('true');
    expect(rows[0].attributes('disabled')).toBeDefined();
    expect(rows[1].attributes('disabled')).toBeUndefined();
  });

  test('picking a branch calls switchBranch and closes the panel', async () => {
    const { wrapper, repo } = await mountOpen();
    const spy = vi.spyOn(repo, 'switchBranch').mockResolvedValue();

    await wrapper.findAll('[data-testid="branch-list"] .row')[1].trigger('click');
    expect(spy).toHaveBeenCalledWith('feat-x');
    expect(wrapper.find('[data-testid="actions-panel"]').exists()).toBe(false);
  });

  test('the create form calls createBranch with the trimmed name', async () => {
    const { wrapper, repo } = await mountOpen();
    const spy = vi.spyOn(repo, 'createBranch').mockResolvedValue();

    const create = wrapper.find('[data-testid="create-branch"]');
    expect(create.attributes('disabled')).toBeDefined(); // empty name

    await wrapper.find('[data-testid="new-branch-name"]').setValue('  feat-y  ');
    expect(create.attributes('disabled')).toBeUndefined();

    await wrapper.find('[data-testid="create-branch-form"]').trigger('submit');
    expect(spy).toHaveBeenCalledWith('feat-y');
    expect(wrapper.find('[data-testid="actions-panel"]').exists()).toBe(false);
  });
});

describe('stash', () => {
  test('stash without a message passes undefined', async () => {
    const { wrapper, repo } = await mountOpen();
    const spy = vi.spyOn(repo, 'stash').mockResolvedValue();

    await wrapper.find('[data-testid="stash-form"]').trigger('submit');
    expect(spy).toHaveBeenCalledWith(undefined);
  });

  test('stash with a message passes it through', async () => {
    const { wrapper, repo } = await mountOpen();
    const spy = vi.spyOn(repo, 'stash').mockResolvedValue();

    await wrapper.find('[data-testid="stash-message"]').setValue('wip: header');
    await wrapper.find('[data-testid="stash-form"]').trigger('submit');
    expect(spy).toHaveBeenCalledWith('wip: header');
  });

  test('the stash list renders shared.stashList and pop passes the entry index', async () => {
    const { wrapper, repo } = await mountOpen();
    repo.shared = sharedState({
      stashList: [
        { index: 0, message: 'WIP on main: abc123 top' },
        { index: 1, message: 'older stash' },
      ],
    });
    await wrapper.vm.$nextTick();

    const list = wrapper.find('[data-testid="stash-list"]');
    expect(list.text()).toContain('stash@{0}');
    expect(list.text()).toContain('older stash');

    const spy = vi.spyOn(repo, 'stashPop').mockResolvedValue();
    await wrapper.find('[data-testid="stash-pop-1"]').trigger('click');
    expect(spy).toHaveBeenCalledWith(1);
  });
});

describe('soft reset', () => {
  test('reset only fires through the confirm, with the chosen count', async () => {
    const { wrapper, repo } = await mountOpen();
    const spy = vi.spyOn(repo, 'softReset').mockResolvedValue();

    await wrapper.find('[data-testid="reset-count"]').setValue(3);
    await wrapper.find('[data-testid="reset-start"]').trigger('click');
    expect(spy).not.toHaveBeenCalled(); // the confirm guards HEAD moves

    const confirm = wrapper.find('[data-testid="reset-confirm"]');
    expect(confirm.text()).toContain('3');

    await wrapper.find('[data-testid="reset-go"]').trigger('click');
    expect(spy).toHaveBeenCalledWith(3);
    expect(wrapper.find('[data-testid="actions-panel"]').exists()).toBe(false);
  });

  test('cancel backs out without a call', async () => {
    const { wrapper, repo } = await mountOpen();
    const spy = vi.spyOn(repo, 'softReset').mockResolvedValue();

    await wrapper.find('[data-testid="reset-start"]').trigger('click');
    await wrapper.find('[data-testid="reset-cancel"]').trigger('click');

    expect(spy).not.toHaveBeenCalled();
    expect(wrapper.find('[data-testid="reset-confirm"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="actions-panel"]').exists()).toBe(true);
  });

  test.each([
    ['empty', '', '1'],
    ['negative', '-3', '1'],
    ['zero', '0', '1'],
    ['fractional', '2.5', '2'],
  ])('the count input sanitizes a %s value on change', async (_name, raw, sanitized) => {
    const { wrapper } = await mountOpen();
    const input = wrapper.find('[data-testid="reset-count"]');

    await input.setValue(raw);
    await input.trigger('change');

    expect((input.element as HTMLInputElement).value).toBe(sanitized);
  });

  test('the confirm names the SANITIZED count and reset fires with it', async () => {
    const { wrapper, repo } = await mountOpen();
    const spy = vi.spyOn(repo, 'softReset').mockResolvedValue();

    await wrapper.find('[data-testid="reset-count"]').setValue('2.5');
    await wrapper.find('[data-testid="reset-start"]').trigger('click');

    const confirm = wrapper.find('[data-testid="reset-confirm"]');
    expect(confirm.text()).not.toContain('2.5');
    expect(confirm.text()).toContain('2 commits');

    await wrapper.find('[data-testid="reset-go"]').trigger('click');
    expect(spy).toHaveBeenCalledWith(2);
  });

  test('a garbage count falls back to 1 in the confirm', async () => {
    const { wrapper, repo } = await mountOpen();
    const spy = vi.spyOn(repo, 'softReset').mockResolvedValue();

    await wrapper.find('[data-testid="reset-count"]').setValue('');
    await wrapper.find('[data-testid="reset-start"]').trigger('click');

    expect(wrapper.find('[data-testid="reset-confirm"]').text()).toContain('1 commit');

    await wrapper.find('[data-testid="reset-go"]').trigger('click');
    expect(spy).toHaveBeenCalledWith(1);
  });
});

describe('busy state', () => {
  test('all mutating controls disable while a remote op runs', async () => {
    const { wrapper, repo } = await mountOpen();
    repo.shared = sharedState({ stashList: [{ index: 0, message: 'wip' }] });
    repo.remote = { operation: 'push', inProgress: true, error: null, lastResult: null };
    await wrapper.vm.$nextTick();

    for (const id of ['create-branch', 'stash-save', 'stash-pop-0', 'reset-start']) {
      expect(wrapper.find(`[data-testid="${id}"]`).attributes('disabled')).toBeDefined();
    }
    // The non-current branch row disables too.
    expect(
      wrapper.findAll('[data-testid="branch-list"] .row')[1].attributes('disabled')
    ).toBeDefined();
  });
});
