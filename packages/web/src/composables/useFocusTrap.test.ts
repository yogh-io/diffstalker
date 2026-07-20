/**
 * useFocusTrap tests: focus moves into the dialog on mount (the
 * [data-autofocus] target when present, else the container), Tab and
 * Shift+Tab wrap at the edges, and — the escape hatch that mattered —
 * when the active element is NOT one of the trap's focusable items
 * (the dialog root itself, tabindex="-1"), BOTH directions are
 * prevented and redirected into the dialog instead of walking out to
 * the page behind the scrim. Focus returns to the opener on unmount.
 * Includes HotkeysOverlay, whose only autofocus target is the close
 * button.
 */

import { describe, test, expect, afterEach, beforeEach } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import { mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { useFocusTrap } from './useFocusTrap';
import HotkeysOverlay from '../components/HotkeysOverlay.vue';

/** A dialog root (tabindex=-1) with two buttons; autofocus optional. */
function makeHarness(withAutofocus: boolean) {
  return defineComponent({
    setup() {
      const container = ref<HTMLElement | null>(null);
      useFocusTrap(container);
      return () =>
        h('div', { ref: container, tabindex: '-1', 'data-testid': 'dialog' }, [
          h('button', { 'data-testid': 'first', ...(withAutofocus ? { 'data-autofocus': '' } : {}) }, 'first'),
          h('button', { 'data-testid': 'last' }, 'last'),
        ]);
    },
  });
}

function pressTab(shiftKey: boolean): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'Tab',
    shiftKey,
    bubbles: true,
    cancelable: true,
  });
  (document.activeElement ?? document.body).dispatchEvent(event);
  return event;
}

let wrapper: VueWrapper;

beforeEach(() => {
  setActivePinia(createPinia());
});

afterEach(() => {
  wrapper?.unmount();
  document.body.innerHTML = '';
});

describe('initial focus', () => {
  test('lands on the [data-autofocus] target when present', () => {
    wrapper = mount(makeHarness(true), { attachTo: document.body });
    expect(document.activeElement).toBe(wrapper.find('[data-testid="first"]').element);
  });

  test('falls back to the container itself without one', () => {
    wrapper = mount(makeHarness(false), { attachTo: document.body });
    expect(document.activeElement).toBe(wrapper.find('[data-testid="dialog"]').element);
  });
});

describe('trapping', () => {
  test('Shift+Tab from the dialog root is prevented and focus stays inside', () => {
    wrapper = mount(makeHarness(false), { attachTo: document.body });
    // Focus sits on the container root — not one of the focusable items.
    expect(document.activeElement).toBe(wrapper.find('[data-testid="dialog"]').element);

    const event = pressTab(true);

    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(wrapper.find('[data-testid="last"]').element);
  });

  test('Tab from the dialog root is redirected to the first item', () => {
    wrapper = mount(makeHarness(false), { attachTo: document.body });

    const event = pressTab(false);

    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(wrapper.find('[data-testid="first"]').element);
  });

  test('Tab wraps from the last item to the first, Shift+Tab back', () => {
    wrapper = mount(makeHarness(true), { attachTo: document.body });
    const first = wrapper.find('[data-testid="first"]').element as HTMLElement;
    const last = wrapper.find('[data-testid="last"]').element as HTMLElement;

    last.focus();
    expect(pressTab(false).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);

    expect(pressTab(true).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);
  });

  test('focus returns to the opener on unmount', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();

    wrapper = mount(makeHarness(true), { attachTo: document.body });
    expect(document.activeElement).not.toBe(opener);

    wrapper.unmount();
    expect(document.activeElement).toBe(opener);
  });
});

describe('HotkeysOverlay', () => {
  test('opens with focus on the close button, and Shift+Tab stays trapped', () => {
    wrapper = mount(HotkeysOverlay, { attachTo: document.body });
    const close = wrapper.find('[data-testid="hotkeys-close"]').element as HTMLElement;
    expect(document.activeElement).toBe(close);

    // The close button is the only focusable item — both directions wrap
    // onto it; nothing escapes to the page behind the scrim.
    expect(pressTab(true).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(close);
    expect(pressTab(false).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(close);
  });
});
