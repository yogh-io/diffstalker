/**
 * useGlobalKeys tests: 1–5 switch views (rail order) and the home-row toggles
 * a/s/d/f flip auto mode, diff syntax, split/unified, and follow
 * (never while typing or with a modifier held, never under an open
 * overlay; f is inert without a follow target), Ctrl/⌘+P toggles the finder (only with an active repo),
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
import { useFilterStore } from '../stores/filter';

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

describe('view switching (1-5)', () => {
  test('digits follow the rail order: Changes/Journal/History/Compare/Explorer', () => {
    const ui = useUiStore();
    press('2');
    expect(ui.activeView).toBe('journal');
    press('3');
    expect(ui.activeView).toBe('history');
    press('4');
    expect(ui.activeView).toBe('compare');
    press('5');
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

describe('diff syntax (s)', () => {
  test('s toggles syntax highlighting on and off', () => {
    const ui = useUiStore();
    const start = ui.diffSyntaxEnabled;
    press('s');
    expect(ui.diffSyntaxEnabled).toBe(!start);
    press('s');
    expect(ui.diffSyntaxEnabled).toBe(start);
  });

  test('s is inert while typing, chorded, or under an overlay', () => {
    const ui = useUiStore();
    const start = ui.diffSyntaxEnabled;
    pressInInput('s');
    press('s', { ctrlKey: true });
    ui.openOverlay('help');
    press('s');
    expect(ui.diffSyntaxEnabled).toBe(start);
  });
});

describe('diff layout (d)', () => {
  test('d toggles split / unified', () => {
    const ui = useUiStore();
    const start = ui.diffMode;
    const other = start === 'split' ? 'unified' : 'split';
    press('d');
    expect(ui.diffMode).toBe(other);
    press('d');
    expect(ui.diffMode).toBe(start);
  });

  test('d is inert while typing, chorded, or under an overlay', () => {
    const ui = useUiStore();
    const start = ui.diffMode;
    pressInInput('d');
    press('d', { metaKey: true });
    ui.openOverlay('help');
    press('d');
    expect(ui.diffMode).toBe(start);
  });
});

describe('list filter (/)', () => {
  test('/ opens the filter and asks for the caret', () => {
    const filter = useFilterStore();
    press('/');
    expect(filter.open).toBe(true);
    expect(filter.focusRequest).toBe(1);
  });

  test('/ pressed again re-focuses rather than toggling closed', () => {
    const filter = useFilterStore();
    press('/');
    press('/');
    expect(filter.open).toBe(true);
    expect(filter.focusRequest).toBe(2);
  });

  test('/ is inert while typing — it is a character, not a command, there', () => {
    const filter = useFilterStore();
    pressInInput('/');
    expect(filter.open).toBe(false);
  });

  test('/ is inert under an open overlay', () => {
    const ui = useUiStore();
    const filter = useFilterStore();
    ui.openOverlay('help');
    press('/');
    expect(filter.open).toBe(false);
  });
});

describe('expand gated diffs (e)', () => {
  test('e asks the stacked views to mount every gated body', () => {
    const ui = useUiStore();
    const start = ui.expandGatedRequest;
    press('e');
    expect(ui.expandGatedRequest).toBe(start + 1);
  });

  test('e is repeatable — a second press is a distinct request', () => {
    const ui = useUiStore();
    const start = ui.expandGatedRequest;
    press('e');
    press('e');
    expect(ui.expandGatedRequest).toBe(start + 2);
  });

  test('e is inert while typing, chorded, or under an overlay', () => {
    const ui = useUiStore();
    const start = ui.expandGatedRequest;
    pressInInput('e');
    press('e', { metaKey: true });
    ui.openOverlay('help');
    press('e');
    expect(ui.expandGatedRequest).toBe(start);
  });
});

describe('follow (f)', () => {
  const withTarget = {
    targetFile: '/repo/.git/HEAD',
    enabled: true,
    followedRepoId: null,
    followedPath: null,
  };

  test('f toggles follow when the daemon has a follow target', () => {
    const daemon = useDaemonStore();
    daemon.follow = { ...withTarget };
    expect(daemon.followEnabled).toBe(true);
    press('f');
    expect(daemon.followEnabled).toBe(false);
    press('f');
    expect(daemon.followEnabled).toBe(true);
  });

  test('f is a no-op when there is no follow target', () => {
    const daemon = useDaemonStore();
    daemon.follow = null;
    press('f');
    expect(daemon.followEnabled).toBe(true);
    daemon.follow = { ...withTarget, targetFile: null };
    press('f');
    expect(daemon.followEnabled).toBe(true);
  });

  test('f is inert while typing or under an overlay', () => {
    const daemon = useDaemonStore();
    const ui = useUiStore();
    daemon.follow = { ...withTarget };
    pressInInput('f');
    expect(daemon.followEnabled).toBe(true);
    ui.openOverlay('help');
    press('f');
    expect(daemon.followEnabled).toBe(true);
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

describe('content search (Ctrl/⌘+Shift+F, bare F)', () => {
  test('the chord opens the search overlay when a repo is active', () => {
    const ui = useUiStore();
    useDaemonStore().activeRepoId = 'repo1';
    const event = press('F', { ctrlKey: true, shiftKey: true });
    expect(ui.activeOverlay).toBe('search');
    expect(event.defaultPrevented).toBe(true);
  });

  test('the chord toggles it closed again', () => {
    const ui = useUiStore();
    useDaemonStore().activeRepoId = 'repo1';
    press('F', { ctrlKey: true, shiftKey: true });
    press('F', { ctrlKey: true, shiftKey: true });
    expect(ui.activeOverlay).toBeNull();
  });

  test('with no repo the chord stays the browser’s', () => {
    const ui = useUiStore();
    const event = press('F', { metaKey: true, shiftKey: true });
    expect(ui.activeOverlay).toBeNull();
    expect(event.defaultPrevented).toBe(false);
  });

  test('the chord fires even while typing — it is a chord, not a bare key', () => {
    const ui = useUiStore();
    useDaemonStore().activeRepoId = 'repo1';
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    input.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'F',
        ctrlKey: true,
        shiftKey: true,
        cancelable: true,
        bubbles: true,
      })
    );
    input.remove();
    expect(ui.activeOverlay).toBe('search');
  });

  test('bare F opens it too, for parity with a terminal that has no chords', () => {
    const ui = useUiStore();
    useDaemonStore().activeRepoId = 'repo1';
    press('F');
    expect(ui.activeOverlay).toBe('search');
  });

  test('bare F is inert while typing', () => {
    const ui = useUiStore();
    useDaemonStore().activeRepoId = 'repo1';
    pressInInput('F');
    expect(ui.activeOverlay).toBeNull();
  });

  test('Ctrl+F is left to the browser — find-in-page is the in-diff search', () => {
    const ui = useUiStore();
    useDaemonStore().activeRepoId = 'repo1';
    const event = press('f', { ctrlKey: true });
    expect(ui.activeOverlay).toBeNull();
    expect(event.defaultPrevented).toBe(false);
  });
});

describe('/ only where a list narrows', () => {
  test('opens on Changes', () => {
    const ui = useUiStore();
    ui.setActiveView('changes');
    press('/');
    expect(useFilterStore().open).toBe(true);
  });

  test('is inert on a view with no filter chip, and does not preventDefault', () => {
    const ui = useUiStore();
    const filter = useFilterStore();
    for (const view of ['journal', 'history', 'compare', 'explorer'] as const) {
      ui.setActiveView(view);
      const event = press('/');
      expect(filter.open).toBe(false);
      expect(event.defaultPrevented).toBe(false);
    }
  });
});

describe('file outline (o)', () => {
  test('o asks for the outline in the Explorer', () => {
    const ui = useUiStore();
    useDaemonStore().activeRepoId = 'repo1';
    ui.setActiveView('explorer');
    const event = press('o');
    expect(ui.outlineRequest).toBe(1);
    expect(event.defaultPrevented).toBe(true);
  });

  test('o is repeatable', () => {
    const ui = useUiStore();
    useDaemonStore().activeRepoId = 'repo1';
    ui.setActiveView('explorer');
    press('o');
    press('o');
    expect(ui.outlineRequest).toBe(2);
  });

  test('o is inert outside the Explorer, and stays the browser’s', () => {
    const ui = useUiStore();
    useDaemonStore().activeRepoId = 'repo1';
    ui.setActiveView('changes');
    const event = press('o');
    expect(ui.outlineRequest).toBe(0);
    expect(event.defaultPrevented).toBe(false);
  });

  test('o is inert with no repo, while typing, and under an overlay', () => {
    const ui = useUiStore();
    ui.setActiveView('explorer');
    press('o');
    expect(ui.outlineRequest).toBe(0);

    useDaemonStore().activeRepoId = 'repo1';
    pressInInput('o');
    ui.openOverlay('help');
    press('o');
    expect(ui.outlineRequest).toBe(0);
  });
});
