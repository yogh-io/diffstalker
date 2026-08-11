/**
 * FinderOverlay tests: the file list comes from GET …/files, fzf
 * filters (smart-case) with matched-character highlighting, keyboard
 * nav + Enter reveals in the Explorer view, Esc/scrim-click closes,
 * focus is trapped on open and restored on close, and the empty/error
 * states are honest. Driven by the fake fetch — no daemon.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import FinderOverlay from './FinderOverlay.vue';
import { useDaemonStore } from '../stores/daemon';
import { useRepoStore } from '../stores/repo';
import { useExplorerStore } from '../stores/explorer';
import { useUiStore } from '../stores/ui';
import { makeFakeFetch } from '../testing/fakes';
import type { FakeFetch, FetchCall, FakeResponse } from '../testing/fakes';
import type { MockInstance } from 'vitest';

const FILES = [
  'README.md',
  'src/App.ts',
  'src/KeyBindings.ts',
  'src/utils/paths.ts',
  'docs/spec.md',
];

let fake: FakeFetch;
let onRequest: ((call: FetchCall) => FakeResponse | undefined) | null;

function routes(call: FetchCall): FakeResponse {
  if (call.url === '/repos/r1/files') return { body: FILES };
  return { status: 404, body: { error: `no fake route: ${call.method} ${call.url}` } };
}

/** The debounce is 15ms of real time — wait it out. */
async function settleDebounce(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 30));
  await flushPromises();
}

let revealSpy: MockInstance;

async function mountFinder(): Promise<VueWrapper> {
  const daemon = useDaemonStore();
  daemon.activeRepoId = 'r1';
  const repo = useRepoStore();
  repo.repoId = 'r1';
  const explorer = useExplorerStore();
  revealSpy = vi.spyOn(explorer, 'revealFile').mockResolvedValue(undefined);
  const ui = useUiStore();
  ui.openOverlay('finder');
  const wrapper = mount(FinderOverlay, { attachTo: document.body });
  await flushPromises();
  return wrapper;
}

function optionTexts(wrapper: VueWrapper): string[] {
  return wrapper.findAll('.finder-option').map((option) => option.text());
}

beforeEach(() => {
  setActivePinia(createPinia());
  onRequest = null;
  fake = makeFakeFetch((call) => onRequest?.(call) ?? routes(call));
  vi.stubGlobal('fetch', fake.fn);
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('file list', () => {
  test('fetches the repo file list once and shows it unfiltered', async () => {
    const wrapper = await mountFinder();
    expect(fake.callsTo('/files')).toHaveLength(1);
    expect(optionTexts(wrapper)).toEqual(FILES);
    // First row selected by default.
    expect(wrapper.find('.finder-option.selected').text()).toBe('README.md');
    wrapper.unmount();
  });

  test('focus lands in the input on open', async () => {
    const wrapper = await mountFinder();
    expect(document.activeElement).toBe(wrapper.find('input').element);
    wrapper.unmount();
  });

  test('a failed file-list fetch shows the error, not an empty list', async () => {
    onRequest = (call) =>
      call.url.includes('/files') ? { status: 500, body: { error: 'boom' } } : undefined;
    const wrapper = await mountFinder();
    expect(wrapper.find('[data-testid="finder-error"]').text()).toContain('boom');
    expect(wrapper.findAll('.finder-option')).toHaveLength(0);
    wrapper.unmount();
  });
});

describe('filtering', () => {
  test('the query fzf-filters the list and highlights matched characters', async () => {
    const wrapper = await mountFinder();
    await wrapper.find('input').setValue('keybind');
    await settleDebounce();

    expect(optionTexts(wrapper)).toEqual(['src/KeyBindings.ts']);
    // Smart-case: the lowercase query matched the CamelCase path; the
    // matched run is wrapped in .hit spans.
    const hits = wrapper.findAll('.finder-option .hit').map((hit) => hit.text());
    expect(hits.join('').toLowerCase()).toContain('keybind');
    wrapper.unmount();
  });

  test('no matches: honest empty state naming the query', async () => {
    const wrapper = await mountFinder();
    await wrapper.find('input').setValue('zzz-nothing');
    await settleDebounce();

    const empty = wrapper.find('[data-testid="finder-no-matches"]');
    expect(empty.exists()).toBe(true);
    expect(empty.text()).toContain('zzz-nothing');
    // No results list: the combobox must not point at a missing id.
    const input = wrapper.find('input');
    expect(input.attributes('aria-expanded')).toBe('false');
    expect(input.attributes('aria-controls')).toBeUndefined();
    wrapper.unmount();
  });

  test('an empty repo with an empty query does not claim "No files match"', async () => {
    onRequest = (call) => (call.url.includes('/files') ? { body: [] } : undefined);
    const wrapper = await mountFinder();

    const empty = wrapper.find('[data-testid="finder-no-matches"]');
    expect(empty.text()).toBe('This repository has no files.');
    expect(empty.text()).not.toContain('match');
    wrapper.unmount();
  });

  test('a query change resets the results scroll to the top', async () => {
    const wrapper = await mountFinder();
    const list = wrapper.find('[data-testid="finder-results"]').element as HTMLElement;
    list.scrollTop = 120;
    expect(list.scrollTop).toBe(120); // the environment tracks scrollTop

    await wrapper.find('input').setValue('s');
    await settleDebounce();

    expect(list.scrollTop).toBe(0);
    wrapper.unmount();
  });

  test('clearing the query restores the full list', async () => {
    const wrapper = await mountFinder();
    await wrapper.find('input').setValue('spec');
    await settleDebounce();
    expect(optionTexts(wrapper)).toEqual(['docs/spec.md']);

    await wrapper.find('input').setValue('');
    await settleDebounce();
    expect(optionTexts(wrapper)).toEqual(FILES);
    // Still exactly one /files fetch — the list is cached per open.
    expect(fake.callsTo('/files')).toHaveLength(1);
    wrapper.unmount();
  });
});

describe('selection', () => {
  test('ArrowDown/ArrowUp and Ctrl+j/k move the selection', async () => {
    const wrapper = await mountFinder();
    const input = wrapper.find('input');

    await input.trigger('keydown', { key: 'ArrowDown' });
    expect(wrapper.find('.finder-option.selected').text()).toBe('src/App.ts');

    await input.trigger('keydown', { key: 'j', ctrlKey: true });
    expect(wrapper.find('.finder-option.selected').text()).toBe('src/KeyBindings.ts');

    await input.trigger('keydown', { key: 'k', ctrlKey: true });
    await input.trigger('keydown', { key: 'ArrowUp' });
    expect(wrapper.find('.finder-option.selected').text()).toBe('README.md');

    // Bounded at the top — no wrap on arrows.
    await input.trigger('keydown', { key: 'ArrowUp' });
    expect(wrapper.find('.finder-option.selected').text()).toBe('README.md');
    wrapper.unmount();
  });

  test('Enter reveals the selected file: Explorer view + revealFile + close', async () => {
    const wrapper = await mountFinder();
    const ui = useUiStore();
    const input = wrapper.find('input');

    await input.trigger('keydown', { key: 'ArrowDown' });
    await input.trigger('keydown', { key: 'Enter' });

    expect(ui.activeOverlay).toBeNull();
    expect(ui.activeView).toBe('explorer');
    expect(revealSpy).toHaveBeenCalledWith('src/App.ts');
    wrapper.unmount();
  });

  test('clicking a result reveals it', async () => {
    const wrapper = await mountFinder();
    const ui = useUiStore();

    await wrapper.findAll('.finder-option')[4].trigger('click');

    expect(ui.activeOverlay).toBeNull();
    expect(ui.activeView).toBe('explorer');
    expect(revealSpy).toHaveBeenCalledWith('docs/spec.md');
    wrapper.unmount();
  });
});

describe('closing', () => {
  test('Esc closes the overlay', async () => {
    const wrapper = await mountFinder();
    const ui = useUiStore();
    await wrapper.find('input').trigger('keydown', { key: 'Escape' });
    expect(ui.activeOverlay).toBeNull();
    wrapper.unmount();
  });

  test('clicking the scrim closes; clicking inside the dialog does not', async () => {
    const wrapper = await mountFinder();
    const ui = useUiStore();

    await wrapper.find('.overlay-dialog').trigger('click');
    expect(ui.activeOverlay).toBe('finder');

    await wrapper.find('.overlay-scrim').trigger('click');
    expect(ui.activeOverlay).toBeNull();
    wrapper.unmount();
  });

  test('a repo switch while open closes the finder (its list is per-repo)', async () => {
    const wrapper = await mountFinder();
    const ui = useUiStore();
    expect(ui.activeOverlay).toBe('finder');

    useDaemonStore().activeRepoId = 'r2';
    await flushPromises();

    expect(ui.activeOverlay).toBeNull();
    wrapper.unmount();
  });

  test('focus returns to the previously focused element on close', async () => {
    const button = document.createElement('button');
    document.body.appendChild(button);
    button.focus();

    const wrapper = await mountFinder();
    expect(document.activeElement).not.toBe(button);

    wrapper.unmount();
    expect(document.activeElement).toBe(button);
  });
});

describe('the search modes strip', () => {
  test('is on the overlay, marking files', async () => {
    const wrapper = await mountFinder();

    expect(wrapper.find('[data-testid="search-modes"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="mode-files"]').classes()).toContain('current');
    // The other two keys are printed here or nowhere — this overlay is the
    // only one of the three with a visible way in.
    expect(wrapper.text()).toContain('Contents');
    expect(wrapper.text()).toContain('Outline');

    wrapper.unmount();
  });

  test('a query carried in from content search is applied on mount', async () => {
    useUiStore().setOverlayQuery('paths');

    const wrapper = await mountFinder();
    await settleDebounce();

    expect(optionTexts(wrapper)).toEqual(['src/utils/paths.ts']);
    wrapper.unmount();
  });

  test('typing keeps the shared query in step, for the trip across', async () => {
    const ui = useUiStore();
    const wrapper = await mountFinder();

    await wrapper.find('[data-testid="finder-input"]').setValue('App');
    await settleDebounce();

    expect(ui.overlayQuery).toBe('App');
    wrapper.unmount();
  });
});
