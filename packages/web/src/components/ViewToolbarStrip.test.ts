/**
 * ViewToolbarStrip tests: the strip is the home of the #view-toolbar-slot
 * Teleport target — its OWN full-width row under the activity rail, so a
 * view's lifted toolbar (Compare's base picker, Explorer's filters) never
 * shares the rail's right group with the global display toggles. The slot
 * is adopted as a child of the strip and its portrait CSS is in-flow (a
 * plain flex row), never absolutely positioned.
 */

import { describe, test, expect, afterEach } from 'vitest';
import { mount } from '@vue/test-utils';
import ViewToolbarStrip from './ViewToolbarStrip.vue';
import stripSource from './ViewToolbarStrip.vue?raw';

afterEach(() => {
  // The strip parks the adopted slot on <body> on unmount; clean it up so
  // tests don't leak the singleton element between runs.
  document.getElementById('view-toolbar-slot')?.remove();
});

describe('ViewToolbarStrip', () => {
  test('adopts #view-toolbar-slot as a child of the strip', () => {
    const wrapper = mount(ViewToolbarStrip, { attachTo: document.body });
    const strip = wrapper.find('.view-toolbar-strip').element;
    const slot = strip.querySelector('#view-toolbar-slot');
    expect(slot).not.toBeNull();
    expect(slot!.classList.contains('toolbar-slot')).toBe(true);
    wrapper.unmount();
  });

  test('parks the slot back on <body> on unmount (kept for the next instance)', () => {
    const wrapper = mount(ViewToolbarStrip, { attachTo: document.body });
    wrapper.unmount();
    const slot = document.getElementById('view-toolbar-slot');
    expect(slot).not.toBeNull();
    expect(slot!.parentElement).toBe(document.body);
  });

  test('the slot is never absolutely positioned (it is an in-flow flex row)', () => {
    const slotRules = stripSource.match(/\.toolbar-slot[^{]*\{[^}]*\}/g) ?? [];
    expect(slotRules.length).toBeGreaterThan(0);
    for (const rule of slotRules) {
      expect(rule).not.toMatch(/position\s*:\s*absolute/);
    }
  });
});
