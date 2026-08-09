/**
 * useFocusTrap tests: focus moves into the dialog on mount (the
 * [data-autofocus] target when present, else the container), Tab and
 * Shift+Tab wrap at the edges, and — the escape hatch that mattered —
 * when the active element is NOT one of the trap's focusable items
 * (the dialog root itself, tabindex="-1"), BOTH directions are
 * prevented and redirected into the dialog instead of walking out to
 * the page behind the scrim. Focus returns to the opener on unmount —
 * unless the opener can no longer take it (disabled or gone), in which
 * case the caller's fallback gets it instead of <body>. Includes
 * HotkeysOverlay, which autofocuses its close button and cycles between
 * it and the focusable shortcut list.
 */

import { describe, test, expect, afterEach, beforeEach } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import { mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { useFocusTrap } from './useFocusTrap';
import HotkeysOverlay from '../components/HotkeysOverlay.vue';

/** A dialog root (tabindex=-1) with two buttons; autofocus optional. */
function makeHarness(withAutofocus: boolean, fallback?: () => HTMLElement | null) {
  return defineComponent({
    setup() {
      const container = ref<HTMLElement | null>(null);
      useFocusTrap(container, fallback ? { fallback } : {});
      return () =>
        h('div', { ref: container, tabindex: '-1', 'data-testid': 'dialog' }, [
          h(
            'button',
            { 'data-testid': 'first', ...(withAutofocus ? { 'data-autofocus': '' } : {}) },
            'first'
          ),
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

describe('restore fallback', () => {
  /** An opener button + a fallback target (tabindex=-1), both in body. */
  function setupTargets(): { opener: HTMLButtonElement; fallback: HTMLElement } {
    const opener = document.createElement('button');
    const fallback = document.createElement('div');
    fallback.tabIndex = -1;
    document.body.append(opener, fallback);
    opener.focus();
    return { opener, fallback };
  }

  test('an opener DISABLED while the dialog was open: focus lands on the fallback, not body', () => {
    const { opener, fallback } = setupTargets();
    wrapper = mount(
      makeHarness(true, () => fallback),
      { attachTo: document.body }
    );

    // An opener can be disabled while the dialog is open (e.g. a repo
    // switch disables it) — restoring focus there is a no-op.
    opener.disabled = true;
    wrapper.unmount();

    expect(document.activeElement).toBe(fallback);
    expect(document.activeElement).not.toBe(document.body);
  });

  test('an opener REMOVED from the DOM: focus lands on the fallback', () => {
    const { opener, fallback } = setupTargets();
    wrapper = mount(
      makeHarness(true, () => fallback),
      { attachTo: document.body }
    );

    opener.remove();
    wrapper.unmount();

    expect(document.activeElement).toBe(fallback);
  });

  test('a healthy opener still wins over the fallback (cancel path)', () => {
    const { opener, fallback } = setupTargets();
    wrapper = mount(
      makeHarness(true, () => fallback),
      { attachTo: document.body }
    );

    wrapper.unmount();

    expect(document.activeElement).toBe(opener);
  });

  test('no fallback and a disabled opener: focus is simply not restored', () => {
    const { opener } = setupTargets();
    wrapper = mount(makeHarness(true), { attachTo: document.body });

    opener.disabled = true;
    expect(() => wrapper.unmount()).not.toThrow();
    expect(document.activeElement).not.toBe(opener);
  });
});

describe('HotkeysOverlay', () => {
  test('opens on the close button and cycles between it and the list', () => {
    wrapper = mount(HotkeysOverlay, { attachTo: document.body });
    const close = wrapper.find('[data-testid="hotkeys-close"]').element as HTMLElement;
    const body = wrapper.find('[data-testid="hotkeys-body"]').element as HTMLElement;
    expect(document.activeElement).toBe(close);

    // Two focusables — the button and the scroll region, which takes a
    // tab stop so the list can be scrolled without a pointer. Both
    // directions wrap between them; nothing escapes the scrim.
    expect(pressTab(true).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(body);
    expect(pressTab(false).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(close);
  });
});
