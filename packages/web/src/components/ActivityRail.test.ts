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
import { useRepoStore } from '../stores/repo';

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

describe('band right group (global display toggles)', () => {
  test('the right group holds the global toggles, right-pinned, and NOT the view-toolbar slot', () => {
    const wrapper = mount(ActivityRail, { global: { plugins: [pinia] } });
    const band = wrapper.find('nav.rail').element;

    const children = Array.from(band.children);
    const tabs = children.filter((el) => el.classList.contains('rail-item'));
    expect(tabs).toHaveLength(5);

    // The right group is a direct flex sibling of the tabs in the band.
    const bandRight = children.find((el) => el.classList.contains('band-right'));
    expect(bandRight).toBeDefined();
    expect(bandRight!.parentElement).toBe(tabs[0].parentElement);

    // The global toggles render there (the follow one is conditional).
    expect(bandRight!.querySelector('[data-testid="auto-toggle"]')).not.toBeNull();
    // The per-view toolbar slot does NOT live in the rail any more — it moved
    // to ViewToolbarStrip so it gets its own row, not this toggles group.
    expect(bandRight!.querySelector('#view-toolbar-slot')).toBeNull();
    expect(railSource).not.toContain('view-toolbar-slot');
  });

  test('the right group is in-flow and right-aligned (margin-left auto, not absolute)', () => {
    const bandRightRule = railSource.match(/\.band-right\s*\{[^}]*\}/)?.[0] ?? '';
    expect(bandRightRule).toMatch(/margin-left\s*:\s*auto/);
    expect(bandRightRule).not.toMatch(/position\s*:\s*absolute/);
  });
});

describe('changed-file count on the Changes tab', () => {
  function primeStatus(fileCount: number): void {
    const repo = useRepoStore();
    repo.shared = {
      ...repo.shared,
      status: {
        files: Array.from({ length: fileCount }, (_, i) => ({
          path: `f${i}.ts`,
          status: 'modified' as const,
          staged: false,
          insertions: 1,
          deletions: 0,
        })),
        branch: { current: 'main', ahead: 0, behind: 0 },
        isRepo: true,
      },
      isLoading: false,
    };
  }

  test('no count before any status has loaded (no repo open)', () => {
    const wrapper = mount(ActivityRail, { global: { plugins: [pinia] } });
    expect(wrapper.find('[data-testid="changes-count"]').exists()).toBe(false);
    expect(wrapper.findAll('button.rail-item')[0].text()).toBe('Changes');
  });

  test('shows the count beside the label', () => {
    primeStatus(31);
    const wrapper = mount(ActivityRail, { global: { plugins: [pinia] } });
    expect(wrapper.find('[data-testid="changes-count"]').text()).toBe('(31)');
    expect(wrapper.findAll('button.rail-item')[0].text()).toBe('Changes(31)');
  });

  test('shows (0) on a clean tree — the point is to see it is empty without opening it', () => {
    primeStatus(0);
    const wrapper = mount(ActivityRail, { global: { plugins: [pinia] } });
    expect(wrapper.find('[data-testid="changes-count"]').text()).toBe('(0)');
  });

  test('only the Changes tab carries a count', () => {
    primeStatus(3);
    const wrapper = mount(ActivityRail, { global: { plugins: [pinia] } });
    expect(wrapper.findAll('[data-testid="changes-count"]')).toHaveLength(1);
    const tabs = wrapper.findAll('button.rail-item');
    expect(tabs.slice(1).map((t) => t.text())).toEqual([
      'Journal',
      'History',
      'Compare',
      'Explorer',
    ]);
  });

  test('the count is a sibling of the label, so it survives the icon-only band', () => {
    // The cramped media query hides .rail-label; the count must not be
    // inside it, or the one signal worth keeping disappears with the word.
    primeStatus(5);
    const wrapper = mount(ActivityRail, { global: { plugins: [pinia] } });
    const count = wrapper.find('[data-testid="changes-count"]').element;
    expect(count.parentElement?.classList.contains('rail-item')).toBe(true);
    expect(count.closest('.rail-label')).toBeNull();
    expect(railSource).toMatch(/@media[^{]*\{[\s\S]*\.rail-label\s*\{\s*display:\s*none/);
  });
});
