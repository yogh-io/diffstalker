/**
 * CopyPathButton: a self-contained button (only a path prop) that writes
 * the repo-relative path to the clipboard and says what happened.
 */

import { test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import CopyPathButton from './CopyPathButton.vue';

function stubClipboard(impl: () => Promise<void>): ReturnType<typeof vi.fn> {
  const writeText = vi.fn(impl);
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
  return writeText;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

test('click copies the path and flashes back, then returns to the label', async () => {
  const writeText = stubClipboard(() => Promise.resolve());
  const wrapper = mount(CopyPathButton, { props: { path: 'src/a/b/foo.ts' } });

  await wrapper.find('[data-testid="copy-path"]').trigger('click');
  await vi.waitFor(() => expect(wrapper.text()).toBe('copied'));
  expect(writeText).toHaveBeenCalledWith('src/a/b/foo.ts');

  vi.advanceTimersByTime(1500);
  await wrapper.vm.$nextTick();
  expect(wrapper.text()).toBe('copy path');
});

test('a refused clipboard says so instead of doing nothing visible', async () => {
  stubClipboard(() => Promise.reject(new Error('denied')));
  const wrapper = mount(CopyPathButton, { props: { path: 'src/foo.ts' } });

  await wrapper.find('[data-testid="copy-path"]').trigger('click');
  await vi.waitFor(() => expect(wrapper.text()).toBe('copy failed'));
});

test('the full path is on the title, so a truncated header still explains it', () => {
  const wrapper = mount(CopyPathButton, { props: { path: 'src/a/b/foo.ts' } });
  expect(wrapper.find('[data-testid="copy-path"]').attributes('title')).toContain('src/a/b/foo.ts');
});
