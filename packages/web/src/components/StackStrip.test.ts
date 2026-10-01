/**
 * StackStrip tests: the strip names `all`, the trunk and every layer with
 * its commit count, marks the picked one and the checked-out one, says
 * when the stack forks above HEAD, and reports a click as a pick — it
 * owns nothing else.
 */

import { describe, test, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import StackStrip from './StackStrip.vue';
import type { CompareStack, StackLayer } from '@diffstalker/core/types/stack';

function layer(name: string, commits: number, isHead = false, refs: string[] = [name]): StackLayer {
  return { name, refs, tip: `${name}-tip`, commits, isHead };
}

const STACK: CompareStack = {
  trunk: 'upstream/main',
  layers: [
    layer('feature/jsp-to-html', 3, false, ['feature/jsp-to-html', 'upstream/feature/jsp-to-html']),
    layer('feature/nginx', 1),
    layer('feature/nginx-image', 4, true),
  ],
  forkedAbove: false,
};

function mountStrip(active: string | null = null, stack: CompareStack = STACK): VueWrapper {
  return mount(StackStrip, { props: { stack, active } });
}

function layerButtons(wrapper: VueWrapper) {
  return wrapper.findAll('[data-testid="stack-layer"]');
}

describe('what the strip says', () => {
  test('all, then the trunk as a label, then every layer bottom to top with its count', () => {
    const wrapper = mountStrip();
    expect(wrapper.find('[data-testid="stack-all"]').text()).toBe('all');
    // The trunk is what the base picker chooses: a label, never a button.
    const trunk = wrapper.find('[data-testid="stack-trunk"]');
    expect(trunk.text()).toBe('upstream/main');
    expect(trunk.element.tagName).toBe('SPAN');

    const buttons = layerButtons(wrapper);
    expect(buttons.map((b) => b.find('.name').text())).toEqual([
      'feature/jsp-to-html',
      'feature/nginx',
      'feature/nginx-image',
    ]);
    expect(buttons.map((b) => b.find('.commits').text())).toEqual([
      '3 commits',
      '1 commit',
      '4 commits',
    ]);
    expect(buttons.map((b) => b.attributes('data-layer'))).toEqual([
      'feature/jsp-to-html',
      'feature/nginx',
      'feature/nginx-image',
    ]);
  });

  test('all is pressed with no pick; the picked layer is pressed otherwise', () => {
    const none = mountStrip(null);
    expect(none.find('[data-testid="stack-all"]').attributes('aria-pressed')).toBe('true');
    expect(layerButtons(none).map((b) => b.attributes('aria-pressed'))).toEqual([
      'false',
      'false',
      'false',
    ]);

    const picked = mountStrip('feature/nginx');
    expect(picked.find('[data-testid="stack-all"]').attributes('aria-pressed')).toBe('false');
    expect(layerButtons(picked).map((b) => b.attributes('aria-pressed'))).toEqual([
      'false',
      'true',
      'false',
    ]);
    expect(layerButtons(picked)[1].classes()).toContain('current');
  });

  test('the checked-out layer carries the marker, and only it', () => {
    const buttons = layerButtons(mountStrip());
    expect(buttons.map((b) => b.find('.head-mark').exists())).toEqual([false, false, true]);
    // The mark is decoration; the fact is text the button reads out, and
    // the title repeats it for the mouse.
    expect(buttons[2].find('.head-mark').attributes('aria-hidden')).toBe('true');
    expect(buttons.map((b) => b.text().includes('checked out'))).toEqual([false, false, true]);
    expect(buttons[2].attributes('title')).toContain('checked out');
  });

  test('the other refs at a tip are read out from the button, but not shown in the label', () => {
    const buttons = layerButtons(mountStrip());
    expect(buttons[0].find('.name').text()).toBe('feature/jsp-to-html');
    expect(buttons[0].text()).toContain('also upstream/feature/jsp-to-html');
    expect(buttons[0].attributes('title')).toContain('upstream/feature/jsp-to-html');
    expect(buttons[1].text()).not.toContain('also');
  });

  test('disabled while a compare pull is in flight, like the base picker', () => {
    const wrapper = mount(StackStrip, { props: { stack: STACK, active: null, disabled: true } });
    expect(wrapper.find('[data-testid="stack-all"]').attributes('disabled')).toBeDefined();
    expect(layerButtons(wrapper).every((b) => b.attributes('disabled') !== undefined)).toBe(true);
    expect(
      layerButtons(mountStrip()).every((b) => b.attributes('disabled') === undefined)
    ).toBe(true);
  });

  test('a stack that forks above HEAD says so', () => {
    expect(mountStrip().find('[data-testid="stack-forked"]').exists()).toBe(false);
    const forked = mountStrip(null, { ...STACK, forkedAbove: true });
    expect(forked.find('[data-testid="stack-forked"]').text()).toContain('forks above HEAD');
  });
});

describe('picking', () => {
  test('a layer click reports its name; all reports null', async () => {
    const wrapper = mountStrip('feature/nginx');
    await layerButtons(wrapper)[2].trigger('click');
    await wrapper.find('[data-testid="stack-all"]').trigger('click');
    expect(wrapper.emitted('pick')).toEqual([['feature/nginx-image'], [null]]);
  });

  test('every pick is a real button, so the keyboard reaches it', () => {
    const wrapper = mountStrip();
    const all = wrapper.find('[data-testid="stack-all"]');
    expect(all.element.tagName).toBe('BUTTON');
    expect(all.attributes('type')).toBe('button');
    expect(layerButtons(wrapper).every((b) => b.element.tagName === 'BUTTON')).toBe(true);
  });
});
