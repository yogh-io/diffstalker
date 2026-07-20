/**
 * CommitPanel tests: the staged summary, commit enablement (open repo
 * required; message required; staged files or amend required),
 * Ctrl/Cmd+Enter submit (plain Enter never submits), the amend
 * prefill from the HEAD message (cleared again by amend-off while
 * unedited; a fetch failure degrades to no prefill), the pending
 * state while committing, and the clear-on-success / keep-on-failure
 * draft behavior.
 *
 * The repo store runs for real; mountPanel assigns a repoId so the
 * panel sees an open repo (the no-repo test leaves it null);
 * commit/getHeadCommitMessage are spied per test.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { Pinia } from 'pinia';
import CommitPanel from './CommitPanel.vue';
import { useRepoStore } from '../stores/repo';
import type { RepoSharedState } from '../stores/types';
import type { FileEntry, GitStatus } from '@diffstalker/core/git/status';

function makeShared(files: FileEntry[]): RepoSharedState {
  const status: GitStatus = {
    files,
    branch: { current: 'main', ahead: 0, behind: 0 },
    isRepo: true,
  };
  return {
    status,
    hunkCounts: null,
    stashList: [],
    operationInProgress: null,
    error: null,
    isLoading: false,
  };
}

const STAGED: FileEntry[] = [
  { path: 'a.ts', status: 'modified', staged: true, insertions: 1 },
  { path: 'b.ts', status: 'added', staged: true, insertions: 5 },
];

const UNSTAGED_ONLY: FileEntry[] = [
  { path: 'a.ts', status: 'modified', staged: false, insertions: 1 },
];

let pinia: Pinia;

function mountPanel(files: FileEntry[] = STAGED, { repoId = 'repo-1' as string | null } = {}) {
  const repo = useRepoStore();
  repo.repoId = repoId;
  repo.shared = makeShared(files);
  const wrapper = mount(CommitPanel, { global: { plugins: [pinia] } });
  return { wrapper, repo };
}

async function flush(wrapper: ReturnType<typeof mount>): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await wrapper.vm.$nextTick();
}

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
});

describe('staged summary', () => {
  test('counts staged files only', () => {
    const { wrapper } = mountPanel(STAGED);
    expect(wrapper.find('[data-testid="staged-summary"]').text()).toBe('2 files staged');
  });

  test('singular for one file', () => {
    const { wrapper } = mountPanel([STAGED[0]]);
    expect(wrapper.find('[data-testid="staged-summary"]').text()).toBe('1 file staged');
  });

  test('says nothing staged when only unstaged changes exist', () => {
    const { wrapper } = mountPanel(UNSTAGED_ONLY);
    expect(wrapper.find('[data-testid="staged-summary"]').text()).toBe('nothing staged');
  });
});

describe('enablement', () => {
  test('disabled with an empty (or whitespace-only) message', async () => {
    const { wrapper } = mountPanel(STAGED);
    expect(wrapper.find('[data-testid="commit-button"]').attributes('disabled')).toBeDefined();

    await wrapper.find('[data-testid="commit-message"]').setValue('   \n  ');
    expect(wrapper.find('[data-testid="commit-button"]').attributes('disabled')).toBeDefined();
  });

  test('disabled with a message but nothing staged and no amend', async () => {
    const { wrapper } = mountPanel(UNSTAGED_ONLY);
    await wrapper.find('[data-testid="commit-message"]').setValue('a message');
    expect(wrapper.find('[data-testid="commit-button"]').attributes('disabled')).toBeDefined();
  });

  test('enabled with message + staged files; and with message + amend alone', async () => {
    const { wrapper } = mountPanel(STAGED);
    await wrapper.find('[data-testid="commit-message"]').setValue('a message');
    expect(wrapper.find('[data-testid="commit-button"]').attributes('disabled')).toBeUndefined();

    // Amend with nothing staged (a reword) is committable too.
    const bare = mountPanel(UNSTAGED_ONLY);
    await bare.wrapper.find('[data-testid="commit-message"]').setValue('reworded');
    await bare.wrapper.find('[data-testid="commit-amend"]').setValue(true);
    expect(
      bare.wrapper.find('[data-testid="commit-button"]').attributes('disabled')
    ).toBeUndefined();
  });

  test('disabled without an open repo — Ctrl+Enter is a no-op and the draft survives', async () => {
    // repoId null = open in flight (or failed): repo.commit would no-op,
    // so a "successful" commit here would silently throw the draft away.
    const { wrapper, repo } = mountPanel(STAGED, { repoId: null });
    const commitSpy = vi.spyOn(repo, 'commit');

    const textarea = wrapper.find('[data-testid="commit-message"]');
    await textarea.setValue('a message');
    expect(wrapper.find('[data-testid="commit-button"]').attributes('disabled')).toBeDefined();

    await wrapper.find('[data-testid="commit-button"]').trigger('click');
    await textarea.trigger('keydown', { key: 'Enter', ctrlKey: true });
    await flush(wrapper);

    expect(commitSpy).not.toHaveBeenCalled();
    expect((textarea.element as HTMLTextAreaElement).value).toBe('a message');
  });

  test('the no-repo reason is surfaced to assistive tech, not only via title', async () => {
    const { wrapper } = mountPanel(STAGED, { repoId: null });
    await wrapper.find('[data-testid="commit-message"]').setValue('a message');

    const button = wrapper.find('[data-testid="commit-button"]');
    const describedBy = button.attributes('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(wrapper.find(`#${describedBy}`).text()).toBe('No repository open');
  });
});

describe('committing', () => {
  test('the button calls repo.commit with the trimmed message and the amend flag', async () => {
    const { wrapper, repo } = mountPanel(STAGED);
    const commitSpy = vi.spyOn(repo, 'commit').mockResolvedValue();
    vi.spyOn(repo, 'getHeadCommitMessage').mockResolvedValue('old subject');

    await wrapper.find('[data-testid="commit-message"]').setValue('  fix: the bug  ');
    await wrapper.find('[data-testid="commit-amend"]').setValue(true);
    await wrapper.find('[data-testid="commit-button"]').trigger('click');

    expect(commitSpy).toHaveBeenCalledTimes(1);
    expect(commitSpy).toHaveBeenCalledWith('fix: the bug', true);
  });

  test('Ctrl+Enter and Cmd+Enter commit; plain Enter does not', async () => {
    const { wrapper, repo } = mountPanel(STAGED);
    const commitSpy = vi.spyOn(repo, 'commit').mockResolvedValue();
    const textarea = wrapper.find('[data-testid="commit-message"]');
    await textarea.setValue('a message');

    await textarea.trigger('keydown', { key: 'Enter' });
    expect(commitSpy).not.toHaveBeenCalled();

    await textarea.trigger('keydown', { key: 'Enter', ctrlKey: true });
    expect(commitSpy).toHaveBeenCalledTimes(1);

    await flush(wrapper);
    await textarea.setValue('another message');
    await textarea.trigger('keydown', { key: 'Enter', metaKey: true });
    expect(commitSpy).toHaveBeenCalledTimes(2);
  });

  test('shows a pending state and blocks re-submit while committing', async () => {
    const { wrapper, repo } = mountPanel(STAGED);
    let resolveCommit!: () => void;
    const commitSpy = vi
      .spyOn(repo, 'commit')
      .mockImplementation(() => new Promise<void>((resolve) => (resolveCommit = resolve)));

    await wrapper.find('[data-testid="commit-message"]').setValue('a message');
    await wrapper.find('[data-testid="commit-button"]').trigger('click');

    const button = wrapper.find('[data-testid="commit-button"]');
    expect(button.attributes('disabled')).toBeDefined();
    expect(button.text()).toBe('committing…');
    // The textarea locks too: an in-flight edit would be silently wiped
    // by the clear-on-success.
    expect(
      wrapper.find('[data-testid="commit-message"]').attributes('disabled')
    ).toBeDefined();
    // Ctrl+Enter during the pending window is swallowed by the guard.
    await wrapper
      .find('[data-testid="commit-message"]')
      .trigger('keydown', { key: 'Enter', ctrlKey: true });
    expect(commitSpy).toHaveBeenCalledTimes(1);

    resolveCommit();
    await flush(wrapper);
    expect(wrapper.find('[data-testid="commit-button"]').text()).toBe('commit');
    expect(
      wrapper.find('[data-testid="commit-message"]').attributes('disabled')
    ).toBeUndefined();
  });

  test('clears the message (and amend) on success', async () => {
    const { wrapper, repo } = mountPanel(STAGED);
    vi.spyOn(repo, 'commit').mockResolvedValue();
    vi.spyOn(repo, 'getHeadCommitMessage').mockResolvedValue('old subject');

    await wrapper.find('[data-testid="commit-message"]').setValue('a message');
    await wrapper.find('[data-testid="commit-amend"]').setValue(true);
    await wrapper.find('[data-testid="commit-button"]').trigger('click');
    await flush(wrapper);

    const textarea = wrapper.find('[data-testid="commit-message"]').element as HTMLTextAreaElement;
    expect(textarea.value).toBe('');
    const amend = wrapper.find('[data-testid="commit-amend"]').element as HTMLInputElement;
    expect(amend.checked).toBe(false);
  });

  test('keeps the draft when the commit failed (error in shared.error)', async () => {
    const { wrapper, repo } = mountPanel(STAGED);
    vi.spyOn(repo, 'commit').mockImplementation(() => {
      // The store never throws: a failed mutation lands in shared.error.
      repo.shared = { ...repo.shared, error: 'Failed to commit: hook rejected' };
      return Promise.resolve();
    });

    await wrapper.find('[data-testid="commit-message"]').setValue('a message');
    await wrapper.find('[data-testid="commit-button"]').trigger('click');
    await flush(wrapper);

    const textarea = wrapper.find('[data-testid="commit-message"]').element as HTMLTextAreaElement;
    expect(textarea.value).toBe('a message');
  });
});

describe('amend prefill', () => {
  test('toggling amend on with an empty draft prefills the HEAD message', async () => {
    const { wrapper, repo } = mountPanel(STAGED);
    const headSpy = vi.spyOn(repo, 'getHeadCommitMessage').mockResolvedValue('feat: earlier work');

    // setValue on a checkbox fires the change event itself.
    await wrapper.find('[data-testid="commit-amend"]').setValue(true);
    await flush(wrapper);

    expect(headSpy).toHaveBeenCalledTimes(1);
    const textarea = wrapper.find('[data-testid="commit-message"]').element as HTMLTextAreaElement;
    expect(textarea.value).toBe('feat: earlier work');
  });

  test('an existing draft is NOT overwritten by the prefill', async () => {
    const { wrapper, repo } = mountPanel(STAGED);
    const headSpy = vi.spyOn(repo, 'getHeadCommitMessage').mockResolvedValue('feat: earlier work');

    await wrapper.find('[data-testid="commit-message"]').setValue('my own message');
    await wrapper.find('[data-testid="commit-amend"]').setValue(true);
    await flush(wrapper);

    expect(headSpy).not.toHaveBeenCalled();
    const textarea = wrapper.find('[data-testid="commit-message"]').element as HTMLTextAreaElement;
    expect(textarea.value).toBe('my own message');
  });

  test('toggling amend OFF clears an UNEDITED prefill — no stray HEAD message as a new draft', async () => {
    const { wrapper, repo } = mountPanel(STAGED);
    vi.spyOn(repo, 'getHeadCommitMessage').mockResolvedValue('feat: earlier work');

    const amend = wrapper.find('[data-testid="commit-amend"]');
    await amend.setValue(true);
    await flush(wrapper);
    const textarea = wrapper.find('[data-testid="commit-message"]').element as HTMLTextAreaElement;
    expect(textarea.value).toBe('feat: earlier work');

    // Accidental toggle back: the prefill must not survive — a NEW
    // commit would otherwise silently carry HEAD's message.
    await amend.setValue(false);
    await flush(wrapper);
    expect(textarea.value).toBe('');
    // And the commit button is back to disabled (empty message).
    expect(wrapper.find('[data-testid="commit-button"]').attributes('disabled')).toBeDefined();
  });

  test('toggling amend OFF keeps a prefill the user has EDITED (now a real draft)', async () => {
    const { wrapper, repo } = mountPanel(STAGED);
    vi.spyOn(repo, 'getHeadCommitMessage').mockResolvedValue('feat: earlier work');

    const amend = wrapper.find('[data-testid="commit-amend"]');
    await amend.setValue(true);
    await flush(wrapper);

    // setValue fires the input event — exactly what a user edit does.
    await wrapper.find('[data-testid="commit-message"]').setValue('feat: earlier work, refined');
    await amend.setValue(false);
    await flush(wrapper);

    const textarea = wrapper.find('[data-testid="commit-message"]').element as HTMLTextAreaElement;
    expect(textarea.value).toBe('feat: earlier work, refined');
  });

  test('a failed head-message fetch degrades to no prefill — no unhandled rejection', async () => {
    const { wrapper, repo } = mountPanel(STAGED);
    const headSpy = vi
      .spyOn(repo, 'getHeadCommitMessage')
      .mockRejectedValue(new Error('repo not found'));

    await wrapper.find('[data-testid="commit-amend"]').setValue(true);
    await flush(wrapper);

    expect(headSpy).toHaveBeenCalledTimes(1);
    const textarea = wrapper.find('[data-testid="commit-message"]').element as HTMLTextAreaElement;
    expect(textarea.value).toBe('');
    // Amend itself stays on — only the prefill degraded.
    expect(
      (wrapper.find('[data-testid="commit-amend"]').element as HTMLInputElement).checked
    ).toBe(true);
  });

  test('an empty head message ("" — no commits) leaves no phantom prefill state', async () => {
    const { wrapper, repo } = mountPanel(STAGED);
    vi.spyOn(repo, 'getHeadCommitMessage').mockResolvedValue('');

    const amend = wrapper.find('[data-testid="commit-amend"]');
    await amend.setValue(true);
    await flush(wrapper);
    const textarea = wrapper.find('[data-testid="commit-message"]').element as HTMLTextAreaElement;
    expect(textarea.value).toBe('');

    // Type a message AFTER the empty prefill, then toggle off: it stays.
    await wrapper.find('[data-testid="commit-message"]').setValue('my message');
    await amend.setValue(false);
    await flush(wrapper);
    expect(textarea.value).toBe('my message');
  });
});
