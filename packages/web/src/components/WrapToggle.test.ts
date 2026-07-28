/**
 * WrapToggle: a self-contained button reading/writing ui.wrapEnabled
 * directly (no props). Off by default; click flips it and updates the
 * pressed state.
 */

import { test, expect, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import WrapToggle from './WrapToggle.vue';
import { useUiStore } from '../stores/ui';

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
});

test('off by default', () => {
  const wrapper = mount(WrapToggle);
  const button = wrapper.find('[data-testid="wrap-toggle"]');
  expect(button.attributes('aria-pressed')).toBe('false');
  expect(button.classes()).not.toContain('on');
});

test('click flips ui.wrapEnabled and the pressed state', async () => {
  const wrapper = mount(WrapToggle);
  const ui = useUiStore();
  const button = wrapper.find('[data-testid="wrap-toggle"]');

  await button.trigger('click');
  expect(ui.wrapEnabled).toBe(true);
  expect(button.attributes('aria-pressed')).toBe('true');
  expect(button.classes()).toContain('on');

  await button.trigger('click');
  expect(ui.wrapEnabled).toBe(false);
  expect(button.attributes('aria-pressed')).toBe('false');
});
