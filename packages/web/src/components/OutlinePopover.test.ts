/**
 * OutlinePopover.
 *
 * The properties worth pinning: it renders every "nothing to show" state
 * distinctly (the strings come from outlineStatus, which is unit-tested
 * separately — here we check the component actually surfaces them),
 * activating a symbol asks for its line, and a file switch never leaves a
 * stale outline on screen.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { nextTick } from 'vue';
import { mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import OutlinePopover from './OutlinePopover.vue';
import { useExplorerStore } from '../stores/explorer';
import type { FileSymbol } from '@diffstalker/core/symbols/types';

const SYMBOLS: FileSymbol[] = [
  { kind: 'class', name: 'Widget', startLine: 1, endLine: 20, column: 0, parent: null },
  { kind: 'method', name: 'render', startLine: 3, endLine: 8, column: 2, parent: 'Widget' },
  { kind: 'function', name: 'helper', startLine: 30, endLine: 34, column: 0, parent: null },
];

let wrapper: VueWrapper;

function seed(symbols: FileSymbol[] | null, fileOverrides: Record<string, unknown> = {}) {
  const explorer = useExplorerStore();
  explorer.selectedPath = 'src/a.ts';
  explorer.file = {
    content: 'x',
    binary: false,
    truncated: false,
    tooLarge: false,
    size: 1,
    totalLines: 40,
    ...fileOverrides,
  } as never;
  explorer.fileSymbols = symbols === null ? null : { status: 'ok', symbols };
  return explorer;
}

async function openIt(): Promise<void> {
  (wrapper.vm as unknown as { openPopover(): void }).openPopover();
  await nextTick();
}

beforeEach(() => {
  setActivePinia(createPinia());
});

afterEach(() => {
  wrapper?.unmount();
  document.body.innerHTML = '';
});

describe('focus', () => {
  test('closing hands focus back to whatever opened it', async () => {
    seed(SYMBOLS);
    // Stand in for the Explorer tree row the user was arrowing through.
    const row = document.createElement('button');
    document.body.appendChild(row);
    row.focus();

    wrapper = mount(OutlinePopover, { attachTo: document.body });
    await openIt();
    expect(document.activeElement).toBe(wrapper.find('[data-testid="outline-input"]').element);

    await wrapper.find('[data-testid="outline-input"]').trigger('keydown', { key: 'Escape' });
    await nextTick();
    // Without this the input is torn out by v-if and focus lands on <body>,
    // so the arrow keys stop moving the tree.
    expect(document.activeElement).toBe(row);
    row.remove();
  });

  test('an outside click keeps the focus it gave away', async () => {
    seed(SYMBOLS);
    const row = document.createElement('button');
    const elsewhere = document.createElement('button');
    document.body.append(row, elsewhere);
    row.focus();

    wrapper = mount(OutlinePopover, { attachTo: document.body });
    await openIt();

    // What an outside click looks like: focus moves out, then it closes.
    elsewhere.focus();
    document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await nextTick();

    expect(document.activeElement).toBe(elsewhere);
    row.remove();
    elsewhere.remove();
  });
});

describe('rendering', () => {
  test('is closed until opened', () => {
    seed(SYMBOLS);
    wrapper = mount(OutlinePopover, { attachTo: document.body });
    expect(wrapper.find('[data-testid="outline-popover"]').exists()).toBe(false);
  });

  test('lists symbols with kind, name, parent and line', async () => {
    seed(SYMBOLS);
    wrapper = mount(OutlinePopover, { attachTo: document.body });
    await openIt();

    const rows = wrapper.findAll('.outline-row');
    expect(rows.length).toBe(3);
    expect(rows[1].text()).toContain('render');
    expect(rows[1].text()).toContain('Widget');
    expect(rows[1].text()).toContain('3');
  });

  test('an unsupported language says so by extension', async () => {
    const explorer = seed(null);
    explorer.selectedPath = 'main.rs';
    explorer.fileSymbols = { status: 'unsupported', reason: 'language' };
    wrapper = mount(OutlinePopover, { attachTo: document.body });
    await openIt();

    expect(wrapper.find('[data-testid="outline-note"]').text()).toBe('No outline for .rs files.');
  });

  test('a parsed-but-empty file is distinct from unavailable', async () => {
    const explorer = seed([]);
    wrapper = mount(OutlinePopover, { attachTo: document.body });
    await openIt();
    const empty = wrapper.find('[data-testid="outline-note"]').text();

    explorer.fileSymbols = { status: 'unavailable', reason: 'deadline' };
    await nextTick();
    expect(wrapper.find('[data-testid="outline-note"]').text()).not.toBe(empty);
  });

  test('a truncated file says which part the outline covers', async () => {
    seed(SYMBOLS, { truncated: true, totalLines: 12431 });
    wrapper = mount(OutlinePopover, { attachTo: document.body });
    await openIt();

    expect(wrapper.find('[data-testid="outline-partial"]').text()).toContain('12,431');
  });
});

describe('filtering and activation', () => {
  test('filters by symbol name, keeping declaration order', async () => {
    seed(SYMBOLS);
    wrapper = mount(OutlinePopover, { attachTo: document.body });
    await openIt();

    await wrapper.find('[data-testid="outline-input"]').setValue('e');
    const names = wrapper.findAll('.outline-name').map((n) => n.text());
    expect(names).toEqual(names.slice().sort((a, b) => SYMBOLS.findIndex((s) => s.name === a) - SYMBOLS.findIndex((s) => s.name === b)));
  });

  test('a filter matching nothing says so', async () => {
    seed(SYMBOLS);
    wrapper = mount(OutlinePopover, { attachTo: document.body });
    await openIt();

    await wrapper.find('[data-testid="outline-input"]').setValue('zzzz');
    expect(wrapper.find('[data-testid="outline-no-match"]').exists()).toBe(true);
  });

  test('clicking a symbol asks for its line and closes', async () => {
    const explorer = seed(SYMBOLS);
    const requestLine = vi.spyOn(explorer, 'requestLine');
    wrapper = mount(OutlinePopover, { attachTo: document.body });
    await openIt();

    await wrapper.findAll('.outline-row')[2].trigger('click');
    expect(requestLine).toHaveBeenCalledWith(30);
    await nextTick();
    expect(wrapper.find('[data-testid="outline-popover"]').exists()).toBe(false);
  });

  test('Enter activates the selected symbol, not always the first', async () => {
    const explorer = seed(SYMBOLS);
    const requestLine = vi.spyOn(explorer, 'requestLine');
    wrapper = mount(OutlinePopover, { attachTo: document.body });
    await openIt();

    const input = wrapper.find('[data-testid="outline-input"]');
    await input.trigger('keydown', { key: 'ArrowDown' });
    await input.trigger('keydown', { key: 'Enter' });
    expect(requestLine).toHaveBeenCalledWith(3);
  });

  test('Escape closes without asking for a line', async () => {
    const explorer = seed(SYMBOLS);
    const requestLine = vi.spyOn(explorer, 'requestLine');
    wrapper = mount(OutlinePopover, { attachTo: document.body });
    await openIt();

    await wrapper.find('[data-testid="outline-input"]').trigger('keydown', { key: 'Escape' });
    await nextTick();
    expect(wrapper.find('[data-testid="outline-popover"]').exists()).toBe(false);
    expect(requestLine).not.toHaveBeenCalled();
  });
});

describe('staleness', () => {
  test('opening another file closes the outline rather than showing the old one', async () => {
    const explorer = seed(SYMBOLS);
    wrapper = mount(OutlinePopover, { attachTo: document.body });
    await openIt();
    expect(wrapper.find('[data-testid="outline-popover"]').exists()).toBe(true);

    explorer.selectedPath = 'src/other.ts';
    await nextTick();
    expect(wrapper.find('[data-testid="outline-popover"]').exists()).toBe(false);
  });
});
