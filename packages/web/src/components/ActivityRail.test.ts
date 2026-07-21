/**
 * ActivityRail tests: the four view tabs render and switch the active
 * view, and the portrait tab band keeps the lifted per-view toolbar
 * controls BESIDE the tabs — the #view-toolbar-slot is a plain flex
 * sibling of the tab buttons inside the band, never absolutely
 * positioned (an absolute slot overlapped and clipped the tab labels
 * in portrait). jsdom applies no scoped CSS, so the layout stance is
 * asserted against the component source: the portrait .toolbar-slot
 * rule must be in-flow (margin-left auto) with no position:absolute.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { Pinia } from 'pinia';
import ActivityRail from './ActivityRail.vue';
import railSource from './ActivityRail.vue?raw';
import { useUiStore } from '../stores/ui';

let pinia: Pinia;

beforeEach(() => {
  localStorage.clear();
  pinia = createPinia();
  setActivePinia(pinia);
});

afterEach(() => {
  localStorage.clear();
});

describe('tabs', () => {
  test('renders the four views; clicking one activates it', async () => {
    const wrapper = mount(ActivityRail, { global: { plugins: [pinia] } });
    const ui = useUiStore();

    const tabs = wrapper.findAll('button.rail-item');
    expect(tabs.map((t) => t.text())).toEqual(['Changes', 'History', 'Compare', 'Explorer']);
    expect(tabs[0].classes()).toContain('active');

    await tabs[2].trigger('click');
    expect(ui.activeView).toBe('compare');
    expect(wrapper.findAll('button.rail-item')[2].classes()).toContain('active');
  });
});

describe('portrait toolbar slot layout', () => {
  test('the slot is a direct flex sibling of the tab buttons inside the band', () => {
    const wrapper = mount(ActivityRail, { global: { plugins: [pinia] } });
    const band = wrapper.find('nav.rail').element;

    const children = Array.from(band.children);
    const tabs = children.filter((el) => el.classList.contains('rail-item'));
    expect(tabs).toHaveLength(4);

    // Same parent, same flow — the slot shares the band row with the tabs.
    const slot = children.find((el) => el.id === 'view-toolbar-slot');
    expect(slot).toBeDefined();
    expect(slot!.parentElement).toBe(tabs[0].parentElement);
  });

  test('the slot is never absolutely positioned; portrait right-aligns it in flow', () => {
    // Every .toolbar-slot rule in the SFC: none may take the slot out
    // of flow (that is what made it overlap the tab labels).
    const slotRules = railSource.match(/\.toolbar-slot[^{]*\{[^}]*\}/g) ?? [];
    expect(slotRules.length).toBeGreaterThan(0);
    for (const rule of slotRules) {
      expect(rule).not.toMatch(/position\s*:\s*absolute/);
    }
    // The portrait rule right-aligns it as a flex item instead.
    expect(slotRules.some((rule) => /margin-left\s*:\s*auto/.test(rule))).toBe(true);
  });
});
