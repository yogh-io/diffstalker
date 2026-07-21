/**
 * useGlobalKeys tests: 1–4 switch views and `a` toggles auto mode
 * (never while typing or with a modifier held, never under an open
 * overlay), Ctrl/⌘+P toggles the finder (only with an active repo),
 * ? toggles the help overlay, Esc closes the open overlay. Driven through window keydown events on a
 * bare harness component — the overlays themselves are covered by their
 * own component tests.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { defineComponent, h } from 'vue';
import { mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { useGlobalKeys } from './useGlobalKeys';
import { useDaemonStore } from '../stores/daemon';
import { useUiStore } from '../stores/ui';

const Harness = defineComponent({
  setup() {
    useGlobalKeys();
    return () => h('div');
  },
});

let wrapper: VueWrapper;

function press(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, cancelable: true, bubbles: true, ...init });
  window.dispatchEvent(event);
  return event;
}

/** Dispatch a key from a focused text input (typing must never be hijacked). */
function pressInInput(key: string): KeyboardEvent {
  const input = document.createElement('input');
  document.body.appendChild(input);
  input.focus();
  const event = new KeyboardEvent('keydown', { key, cancelable: true, bubbles: true });
  input.dispatchEvent(event);
  input.remove();
  return event;
}

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  wrapper = mount(Harness, { attachTo: document.body });
});

afterEach(() => {
  wrapper.unmount();
  document.body.innerHTML = '';
});

describe('view switching (1-4)', () => {
  test('digits switch to Changes/History/Compare/Explorer', () => {
    const ui = useUiStore();
    press('2');
    expect(ui.activeView).toBe('history');
    press('3');
    expect(ui.activeView).toBe('compare');
    press('4');
    expect(ui.activeView).toBe('explorer');
    press('1');
    expect(ui.activeView).toBe('changes');
  });

  test('typing a digit in a text input does NOT switch views', () => {
    const ui = useUiStore();
    pressInInput('2');
    expect(ui.activeView).toBe('changes');
  });

  test('a modifier chord does NOT switch views', () => {
    const ui = useUiStore();
    press('2', { ctrlKey: true });
    press('3', { altKey: true });
    expect(ui.activeView).toBe('changes');
  });

  test('digits are inert while an overlay is open', () => {
    const ui = useUiStore();
    ui.openOverlay('help');
    press('2');
    expect(ui.activeView).toBe('changes');
    expect(ui.activeOverlay).toBe('help');
  });
});

describe('auto mode (a)', () => {
  test('a toggles auto mode on and off', () => {
    const ui = useUiStore();
    expect(ui.autoModeEnabled).toBe(false);
    press('a');
    expect(ui.autoModeEnabled).toBe(true);
    press('a');
    expect(ui.autoModeEnabled).toBe(false);
  });

  test('typing a in a text input does NOT toggle', () => {
    const ui = useUiStore();
    pressInInput('a');
    expect(ui.autoModeEnabled).toBe(false);
  });

  test('a modifier chord does NOT toggle', () => {
    const ui = useUiStore();
    press('a', { ctrlKey: true });
    press('a', { metaKey: true });
    press('a', { altKey: true });
    expect(ui.autoModeEnabled).toBe(false);
  });

  test('a is inert while an overlay is open', () => {
    const ui = useUiStore();
    ui.openOverlay('help');
    press('a');
    expect(ui.autoModeEnabled).toBe(false);
    expect(ui.activeOverlay).toBe('help');
  });
});

describe('finder (Ctrl/⌘+P)', () => {
  test('Ctrl+P opens the finder when a repo is active, and prevents printing', () => {
    useDaemonStore().activeRepoId = 'r1';
    const ui = useUiStore();
    const event = press('p', { ctrlKey: true });
    expect(ui.activeOverlay).toBe('finder');
    expect(event.defaultPrevented).toBe(true);
  });

  test('⌘+P opens the finder too', () => {
    useDaemonStore().activeRepoId = 'r1';
    press('p', { metaKey: true });
    expect(useUiStore().activeOverlay).toBe('finder');
  });

  test('Ctrl+P works even while typing in an input', () => {
    useDaemonStore().activeRepoId = 'r1';
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    const event = new KeyboardEvent('keydown', {
      key: 'p',
      ctrlKey: true,
      cancelable: true,
      bubbles: true,
    });
    input.dispatchEvent(event);
    expect(useUiStore().activeOverlay).toBe('finder');
  });

  test('Ctrl+P toggles: pressed again it closes the finder', () => {
    useDaemonStore().activeRepoId = 'r1';
    const ui = useUiStore();
    press('p', { ctrlKey: true });
    press('p', { ctrlKey: true });
    expect(ui.activeOverlay).toBeNull();
  });

  test('without an active repo the finder does not open — and print is NOT suppressed', () => {
    const ui = useUiStore();
    const event = press('p', { ctrlKey: true });
    expect(ui.activeOverlay).toBeNull();
    expect(event.defaultPrevented).toBe(false);
  });

  test('Ctrl+Shift+P is not ours — no finder, no preventDefault', () => {
    useDaemonStore().activeRepoId = 'r1';
    const ui = useUiStore();
    const event = press('P', { ctrlKey: true, shiftKey: true });
    expect(ui.activeOverlay).toBeNull();
    expect(event.defaultPrevented).toBe(false);
  });
});

describe('help (?)', () => {
  test('? toggles the help overlay', () => {
    const ui = useUiStore();
    press('?');
    expect(ui.activeOverlay).toBe('help');
    press('?');
    expect(ui.activeOverlay).toBeNull();
  });

  test('? typed in an input is ignored', () => {
    const ui = useUiStore();
    pressInInput('?');
    expect(ui.activeOverlay).toBeNull();
  });
});

describe('Escape', () => {
  test('Esc closes the open overlay', () => {
    const ui = useUiStore();
    ui.openOverlay('help');
    const event = press('Escape');
    expect(ui.activeOverlay).toBeNull();
    expect(event.defaultPrevented).toBe(true);
  });

  test('Esc with nothing open is a no-op (not claimed)', () => {
    const event = press('Escape');
    expect(event.defaultPrevented).toBe(false);
  });
});
