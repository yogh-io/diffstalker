/**
 * HoverTip tests: a `data-tip` shows at once (no timer), above the
 * pointer, follows it, and goes on leaving, a click or a scroll. Touch
 * pointers get none.
 */

import { describe, test, expect, afterEach } from 'vitest';
import { mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import HoverTip from './HoverTip.vue';

let wrapper: VueWrapper | null = null;

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.body.innerHTML = '';
});

function setup(): { tipped: HTMLElement; plain: HTMLElement } {
  wrapper = mount(HoverTip, { attachTo: document.body });
  const tipped = document.createElement('span');
  tipped.setAttribute('data-tip', 'Line one\nLine two');
  const inner = document.createElement('b');
  tipped.appendChild(inner);
  const plain = document.createElement('span');
  document.body.append(tipped, plain);
  return { tipped: inner, plain };
}

async function move(target: Element, x: number, y: number, pointerType = 'mouse'): Promise<void> {
  const event = new MouseEvent('pointermove', { bubbles: true, clientX: x, clientY: y });
  Object.defineProperty(event, 'pointerType', { value: pointerType });
  target.dispatchEvent(event);
  await nextTick();
  await nextTick();
}

const tip = () => document.querySelector<HTMLElement>('[data-testid="hover-tip"]');

describe('HoverTip', () => {
  test('shows at once over a data-tip, from a child too, above the pointer', async () => {
    const { tipped } = setup();
    await move(tipped, 200, 300);
    expect(tip()?.textContent?.trim()).toBe('Line one\nLine two');
    expect(Number.parseFloat(tip()?.style.top ?? '')).toBeLessThan(300);
  });

  test('follows the pointer', async () => {
    const { tipped } = setup();
    await move(tipped, 200, 300);
    await move(tipped, 400, 500);
    expect(Number.parseFloat(tip()?.style.left ?? '')).toBe(400);
    expect(Number.parseFloat(tip()?.style.top ?? '')).toBeLessThan(500);
  });

  test('goes when the pointer leaves for an element without one', async () => {
    const { tipped, plain } = setup();
    await move(tipped, 200, 300);
    await move(plain, 200, 300);
    expect(tip()).toBeNull();
  });

  test('a click or a scroll hides it', async () => {
    const { tipped } = setup();
    await move(tipped, 200, 300);
    document.dispatchEvent(new Event('pointerdown'));
    await nextTick();
    expect(tip()).toBeNull();
    await move(tipped, 200, 300);
    document.dispatchEvent(new Event('scroll'));
    await nextTick();
    expect(tip()).toBeNull();
  });

  test('near the top edge it goes below the pointer', async () => {
    const { tipped } = setup();
    await move(tipped, 200, 4);
    expect(Number.parseFloat(tip()?.style.top ?? '')).toBeGreaterThan(4);
  });

  test('a touch gets none', async () => {
    const { tipped } = setup();
    await move(tipped, 200, 300, 'touch');
    expect(tip()).toBeNull();
  });
});
