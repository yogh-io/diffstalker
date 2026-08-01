/**
 * ViewFileButton: a self-contained button reading the ui and explorer
 * stores directly (only a path prop). Clicking it switches to the
 * Explorer view and reveals the file there.
 */

import { test, expect, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import ViewFileButton from './ViewFileButton.vue';
import { useUiStore } from '../stores/ui';
import { useExplorerStore } from '../stores/explorer';

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
});

test('click switches to the Explorer and reveals the path', async () => {
  const wrapper = mount(ViewFileButton, { props: { path: 'src/foo.ts' } });
  const ui = useUiStore();
  const explorer = useExplorerStore();
  const reveal = vi.spyOn(explorer, 'revealFile').mockResolvedValue();

  await wrapper.find('[data-testid="view-file"]').trigger('click');

  expect(ui.activeView).toBe('explorer');
  expect(reveal).toHaveBeenCalledWith('src/foo.ts');
});

test('the full path is on the title, so a truncated header still explains it', () => {
  const wrapper = mount(ViewFileButton, { props: { path: 'src/a/b/foo.ts' } });
  expect(wrapper.find('[data-testid="view-file"]').attributes('title')).toContain('src/a/b/foo.ts');
});
