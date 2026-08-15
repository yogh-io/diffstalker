/**
 * WholeFileToggle: props in, one event out. Which fetch to fire is the
 * owning surface's business, so this component holds no store and no ref.
 */

import { test, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import WholeFileToggle from './WholeFileToggle.vue';

const sel = '[data-testid="whole-file"]';

test('off reads "whole file", on reads "hunks"', () => {
  expect(mount(WholeFileToggle, { props: { on: false } }).find(sel).text()).toBe('whole file');
  expect(mount(WholeFileToggle, { props: { on: true } }).find(sel).text()).toBe('hunks');
});

test('busy says so and cannot be clicked twice', async () => {
  const wrapper = mount(WholeFileToggle, { props: { on: false, busy: true } });
  expect(wrapper.find(sel).text()).toBe('loading…');
  expect(wrapper.find(sel).attributes('disabled')).toBeDefined();
});

test('emits toggle on click', async () => {
  const wrapper = mount(WholeFileToggle, { props: { on: false } });
  await wrapper.find(sel).trigger('click');
  expect(wrapper.emitted('toggle')).toHaveLength(1);
});

test('disabled carries the reason on the title, not just a dead button', () => {
  const wrapper = mount(WholeFileToggle, {
    props: { on: false, disabled: true, disabledReason: 'Binary file — there is no text to show' },
  });
  expect(wrapper.find(sel).attributes('disabled')).toBeDefined();
  expect(wrapper.find(sel).attributes('title')).toContain('Binary file');
});

test('disabled does not emit', async () => {
  const wrapper = mount(WholeFileToggle, { props: { on: false, disabled: true } });
  await wrapper.find(sel).trigger('click');
  expect(wrapper.emitted('toggle')).toBeUndefined();
});

test('aria-pressed tracks the mode, so it reads as a toggle', () => {
  expect(mount(WholeFileToggle, { props: { on: true } }).find(sel).attributes('aria-pressed')).toBe(
    'true'
  );
  expect(mount(WholeFileToggle, { props: { on: false } }).find(sel).attributes('aria-pressed')).toBe(
    'false'
  );
});
