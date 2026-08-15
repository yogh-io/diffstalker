/**
 * ShowChangesButton: the Explorer's way OUT — the mirror of
 * ViewFileButton. It navigates to Changes and selects the file's row; it
 * renders no diff and reads none.
 */

import { test, expect, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import ShowChangesButton from './ShowChangesButton.vue';
import { useUiStore } from '../stores/ui';
import { useRepoStore } from '../stores/repo';
import type { FileEntry, FileStatus } from '@diffstalker/core/git/status';

function entry(path: string, overrides: Partial<FileEntry> = {}): FileEntry {
  return { path, status: 'modified' as FileStatus, staged: false, ...overrides };
}

/** Put files into the store's shared status without a daemon. */
function seedStatus(files: FileEntry[]): void {
  const repo = useRepoStore();
  repo.shared = {
    ...repo.shared,
    status: { files, branch: { current: 'main', ahead: 0, behind: 0 }, isRepo: true },
  };
}

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
});

test('does not render for a file with no working-tree change', () => {
  seedStatus([entry('other.ts')]);
  const wrapper = mount(ShowChangesButton, { props: { path: 'src/clean.ts' } });
  // Never a dead control: most files the Explorer shows are unchanged,
  // and a button that does nothing is worse than no button.
  expect(wrapper.find('[data-testid="show-changes"]').exists()).toBe(false);
});

test('click switches to Changes and anchors that file', async () => {
  seedStatus([entry('src/foo.ts')]);
  const wrapper = mount(ShowChangesButton, { props: { path: 'src/foo.ts' } });
  const ui = useUiStore();

  await wrapper.find('[data-testid="show-changes"]').trigger('click');

  expect(ui.activeView).toBe('changes');
  expect(ui.activeStackKey).toBe('u:src/foo.ts');
});

test('a partially staged file aims at the UNSTAGED row', async () => {
  // Two rows exist for it. The unstaged one is the row whose new side is
  // the working-tree bytes the Explorer was just showing.
  seedStatus([entry('src/foo.ts', { staged: true }), entry('src/foo.ts')]);
  const wrapper = mount(ShowChangesButton, { props: { path: 'src/foo.ts' } });

  await wrapper.find('[data-testid="show-changes"]').trigger('click');

  expect(useUiStore().activeStackKey).toBe('u:src/foo.ts');
});

test('a staged-only file aims at the staged row', async () => {
  seedStatus([entry('src/foo.ts', { staged: true })]);
  const wrapper = mount(ShowChangesButton, { props: { path: 'src/foo.ts' } });

  await wrapper.find('[data-testid="show-changes"]').trigger('click');

  expect(useUiStore().activeStackKey).toBe('s:src/foo.ts');
});
