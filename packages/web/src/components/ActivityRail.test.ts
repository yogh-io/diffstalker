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
  test('renders the five views (Journal second); clicking one activates it', async () => {
    const wrapper = mount(ActivityRail, { global: { plugins: [pinia] } });
    const ui = useUiStore();

    const tabs = wrapper.findAll('button.rail-item');
    expect(tabs.map((t) => t.text())).toEqual([
      'Changes',
      'Journal',
      'History',
      'Compare',
      'Explorer',
    ]);
    expect(tabs[0].classes()).toContain('active');

    await tabs[3].trigger('click');
    expect(ui.activeView).toBe('compare');
    expect(wrapper.findAll('button.rail-item')[3].classes()).toContain('active');
  });
});

describe('band right group (view toolbar + display toggles)', () => {
  test('the toolbar slot lives in .band-right, a flex sibling of the tabs', () => {
    const wrapper = mount(ActivityRail, { global: { plugins: [pinia] } });
    const band = wrapper.find('nav.rail').element;

    const children = Array.from(band.children);
    const tabs = children.filter((el) => el.classList.contains('rail-item'));
    expect(tabs).toHaveLength(5);

    // The right group is a direct flex sibling of the tabs in the band.
    const bandRight = children.find((el) => el.classList.contains('band-right'));
    expect(bandRight).toBeDefined();
    expect(bandRight!.parentElement).toBe(tabs[0].parentElement);

    // The view-toolbar slot is adopted INTO the right group (to the left of
    // the global toggles), not left absolutely positioned over the tabs.
    const slot = bandRight!.querySelector('#view-toolbar-slot');
    expect(slot).not.toBeNull();
    // The toggles render there too (the follow one is conditional).
    expect(bandRight!.querySelector('[data-testid="auto-toggle"]')).not.toBeNull();
  });

  test('the slot is never absolutely positioned; the right group is in-flow, right-aligned', () => {
    // No .toolbar-slot rule may take the slot out of flow (that is what made
    // it overlap the tab labels).
    const slotRules = railSource.match(/\.toolbar-slot[^{]*\{[^}]*\}/g) ?? [];
    expect(slotRules.length).toBeGreaterThan(0);
    for (const rule of slotRules) {
      expect(rule).not.toMatch(/position\s*:\s*absolute/);
    }
    // The right group is pushed to the edge as a flex item (margin-left
    // auto), not positioned out of flow.
    const bandRightRule = railSource.match(/\.band-right\s*\{[^}]*\}/)?.[0] ?? '';
    expect(bandRightRule).toMatch(/margin-left\s*:\s*auto/);
    expect(bandRightRule).not.toMatch(/position\s*:\s*absolute/);
  });
});
