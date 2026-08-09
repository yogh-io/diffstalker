/**
 * HotkeysOverlay tests: the sheet is a set of small groups, none past
 * five rows, and the digits stay derived from the rail order.
 *
 * The five-row ceiling is the load-bearing part. The layout is CSS
 * multi-column with `break-inside: avoid`, so the tallest group is a
 * floor under every column's height — a sixth row in one group would
 * quietly unbalance the whole sheet with nothing erroring. jsdom has no
 * layout engine, so the layout stance itself is asserted against the
 * component source, the same way ActivityRail does it.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import HotkeysOverlay from './HotkeysOverlay.vue';
import source from './HotkeysOverlay.vue?raw';
import { VIEWS } from '../stores/ui';

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
});

describe('the shortcut groups', () => {
  test('no group runs past five rows', () => {
    const wrapper = mount(HotkeysOverlay);
    const groups = wrapper.findAll('.hotkeys-group');
    expect(groups.length).toBeGreaterThan(6);

    // Reported as a list so a failure names WHICH group outgrew its column.
    const tooTall = groups
      .map((group) => ({
        title: group.find('.group-title').text(),
        rows: group.findAll('dt').length,
      }))
      .filter((group) => group.rows > 5);
    expect(tooTall).toEqual([]);
  });

  test('the digit rows are derived from the rail, so they cannot drift', () => {
    const wrapper = mount(HotkeysOverlay);
    const rows = wrapper
      .findAll('.hotkeys-group')
      .find((group) => group.find('.group-title').text() === 'Switch view');

    expect(rows).toBeDefined();
    expect(rows?.findAll('dt').map((dt) => dt.text())).toEqual(
      VIEWS.map((_, index) => String(index + 1))
    );
    expect(rows?.findAll('dd').map((dd) => dd.text())).toEqual(VIEWS.map((view) => view.label));
  });
});

describe('what the sheet claims', () => {
  test('the search key is Shift+F, which is what the handler tests for', () => {
    const wrapper = mount(HotkeysOverlay);
    const chips = wrapper.findAll('kbd').map((kbd) => kbd.text());
    // A bare capital F was the one row naming a key that does nothing:
    // useGlobalKeys tests `event.key === 'F'`, i.e. Shift+f.
    expect(chips).not.toContain('F');
    expect(chips).toContain('⇧ F');
  });

  test('Enter and Space are separate rows, because they do different things', () => {
    const wrapper = mount(HotkeysOverlay);
    const lists = wrapper
      .findAll('.hotkeys-group')
      .find((group) => group.find('.group-title').text().startsWith('Lists'));

    const rows = lists?.findAll('dt').map((dt, index) => ({
      keys: dt.text(),
      description: lists.findAll('dd')[index]?.text(),
    }));
    // Enter hands focus to the diff, Space leaves it in the list.
    expect(rows).toContainEqual({ keys: 'Enter', description: 'Select, focus the diff' });
    expect(rows).toContainEqual({ keys: 'Space', description: 'Select, stay in the list' });
  });

  test('alternates are separate chips joined by a word, not one string', () => {
    const wrapper = mount(HotkeysOverlay);
    const row = wrapper.findAll('.entry-keys').find((dt) => dt.text().includes('Ctrl j k'));

    // "or" travels inside the chip's own wrapper, so a wrap never
    // strands it at the end of the line above.
    expect(row?.findAll('kbd').map((kbd) => kbd.text())).toEqual(['↑ ↓', 'Ctrl j k']);
    expect(row?.findAll('.key-or')).toHaveLength(1);
  });

  test('the finder row App.test.ts anchors on is spelled out here', () => {
    // App.test.ts asserts the overlay contains 'Find file'; this file is
    // the only place that literal comes from, so pin it where it lives.
    expect(mount(HotkeysOverlay).text()).toContain('Find file by name');
  });
});

describe('the layout stance', () => {
  test('columns, not a grid: a grid row couples its cells heights', () => {
    // The whole redesign is this: one 18-row group beside a 3-row group
    // in a grid stretched the short cell to match, and widening the
    // dialog only widened the hole.
    expect(source).toMatch(/\.hotkeys-columns\s*\{[^}]*column-width/);
    expect(source).not.toMatch(/\.hotkeys-columns\s*\{[^}]*display:\s*grid/);
    expect(source).toMatch(/\.hotkeys-group\s*\{[^}]*break-inside:\s*avoid/);
  });

  test('the height budget subtracts the scrim inset it actually sits below', () => {
    // A flat 100vh - 4rem ignored the scrim's clamp(2rem, 12vh, 8rem)
    // top padding, so on a short window the foot of the sheet was
    // clipped by a scrim that has no overflow of its own.
    expect(source).not.toMatch(/max-height:\s*min\(/);
    expect(source).toMatch(/max-height:\s*calc\(100dvh - clamp\(2rem, 12vh, 8rem\)/);
  });
});
