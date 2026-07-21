/**
 * CommitActionConfirm tests: the cherry-pick/revert confirm dialog.
 * Names the verb + commit, y confirms (and ONLY y — a held modifier
 * like Ctrl+Y never confirms), n/Escape/scrim-click cancel, the safe
 * Cancel button autofocuses, and the alertdialog aria wiring is right.
 * Purely presentational — no store, no pinia.
 */

import { describe, test, expect, afterEach } from 'vitest';
import { mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import CommitActionConfirm from './CommitActionConfirm.vue';
import type { CommitInfo } from '@diffstalker/core/git/status';

const COMMIT: CommitInfo = {
  hash: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
  shortHash: 'a1b2c3d',
  message: 'Fix the thing',
  author: 'Jorn',
  date: new Date('2026-07-01T12:00:00Z'),
  refs: '',
};

let wrapper: VueWrapper;

function mountConfirm(verb: 'cherry-pick' | 'revert' = 'cherry-pick'): VueWrapper {
  wrapper = mount(CommitActionConfirm, {
    props: { verb, commit: COMMIT },
    attachTo: document.body,
  });
  return wrapper;
}

function dialog() {
  return wrapper.find('[data-testid="commit-action-confirm"]');
}

async function press(key: string, init: KeyboardEventInit = {}): Promise<void> {
  await dialog().trigger('keydown', { key, ...init });
}

afterEach(() => {
  wrapper?.unmount();
  document.body.innerHTML = '';
});

describe('content and aria', () => {
  test('is an alertdialog labelled by the verb question, naming the commit', () => {
    mountConfirm('revert');
    const el = dialog();
    expect(el.attributes('role')).toBe('alertdialog');
    expect(el.attributes('aria-modal')).toBe('true');
    expect(el.attributes('aria-labelledby')).toBe('commit-action-question');
    expect(wrapper.find('#commit-action-question').text()).toBe('Revert this commit?');
    const commitLine = wrapper.find('[data-testid="commit-action-commit"]');
    expect(commitLine.text()).toContain('a1b2c3d');
    expect(commitLine.text()).toContain('Fix the thing');
  });

  test('focus starts on the safe Cancel button', () => {
    mountConfirm();
    expect(document.activeElement).toBe(
      wrapper.find('[data-testid="commit-action-cancel"]').element
    );
  });
});

describe('keyboard', () => {
  test('y confirms; nothing cancels alongside it', async () => {
    mountConfirm();
    await press('y');
    expect(wrapper.emitted('confirm')).toHaveLength(1);
    expect(wrapper.emitted('cancel')).toBeUndefined();
  });

  test('Y (shifted) confirms too', async () => {
    mountConfirm();
    await press('Y', { shiftKey: true });
    expect(wrapper.emitted('confirm')).toHaveLength(1);
  });

  test.each([
    ['ctrlKey', { ctrlKey: true }],
    ['metaKey', { metaKey: true }],
    ['altKey', { altKey: true }],
  ])('y with %s held does NOT confirm', async (_name, init) => {
    mountConfirm();
    await press('y', init);
    expect(wrapper.emitted('confirm')).toBeUndefined();
    expect(wrapper.emitted('cancel')).toBeUndefined();
  });

  test.each(['n', 'N', 'Escape'])('%s cancels without confirming', async (key) => {
    mountConfirm();
    await press(key);
    expect(wrapper.emitted('cancel')).toHaveLength(1);
    expect(wrapper.emitted('confirm')).toBeUndefined();
  });

  test('an unrelated key emits nothing', async () => {
    mountConfirm();
    await press('x');
    expect(wrapper.emitted('confirm')).toBeUndefined();
    expect(wrapper.emitted('cancel')).toBeUndefined();
  });
});

describe('pointer', () => {
  test('the go button confirms, the cancel button cancels', async () => {
    mountConfirm();
    await wrapper.find('[data-testid="commit-action-go"]').trigger('click');
    expect(wrapper.emitted('confirm')).toHaveLength(1);

    await wrapper.find('[data-testid="commit-action-cancel"]').trigger('click');
    expect(wrapper.emitted('cancel')).toHaveLength(1);
  });

  test('clicking the scrim cancels; clicking the dialog body does not', async () => {
    mountConfirm();
    await dialog().trigger('click'); // inside the dialog: not a dismissal
    expect(wrapper.emitted('cancel')).toBeUndefined();

    await wrapper.find('.overlay-scrim').trigger('click');
    expect(wrapper.emitted('cancel')).toHaveLength(1);
  });
});
