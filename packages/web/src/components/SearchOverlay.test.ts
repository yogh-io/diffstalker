/**
 * SearchOverlay: repo-wide content search.
 *
 * The properties worth pinning are the ones that make it different from
 * the finder next door: it goes to the network per keystroke (so it
 * debounces, drops superseded replies, and refuses a too-short query
 * client-side), it renders untrusted repo bytes (so never as markup), and
 * activating a hit must carry the LINE, not just the path.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { nextTick } from 'vue';
import { mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import SearchOverlay from './SearchOverlay.vue';
import { useDaemonStore } from '../stores/daemon';
import { useExplorerStore } from '../stores/explorer';
import { useUiStore } from '../stores/ui';
import type { GrepResult } from '@diffstalker/core/git/grep';

const search = vi.hoisted(() => vi.fn());
vi.mock('../api/client', () => ({
  DiffstalkerClient: class {
    search = search;
  },
}));

function result(matches: GrepResult['matches'], extra: Partial<GrepResult> = {}): GrepResult {
  return { matches, capped: false, incomplete: false, binarySkipped: 0, ...extra };
}

const HITS = [
  { path: 'src/a.ts', line: 12, text: 'const needle = 1;', truncated: false },
  { path: 'src/a.ts', line: 40, text: 'use(needle);', truncated: false },
  { path: 'src/b.ts', line: 7, text: 'needle again', truncated: false },
];

let wrapper: VueWrapper;

function mountOverlay(): VueWrapper {
  const daemon = useDaemonStore();
  daemon.activeRepoId = 'repo1';
  return mount(SearchOverlay, { attachTo: document.body });
}

async function type(text: string): Promise<void> {
  await wrapper.find('[data-testid="search-input"]').setValue(text);
}

/** Let the debounce fire and the mocked request settle. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(500);
  await nextTick();
  await nextTick();
}

beforeEach(() => {
  vi.useFakeTimers();
  setActivePinia(createPinia());
  search.mockReset();
  search.mockResolvedValue(result(HITS));
});

afterEach(() => {
  wrapper?.unmount();
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('querying', () => {
  test('does not search below the minimum query length', async () => {
    wrapper = mountOverlay();
    await type('ne');
    await settle();

    expect(search).not.toHaveBeenCalled();
    expect(wrapper.find('[data-testid="search-too-short"]').exists()).toBe(true);
  });

  test('searches once for a settled query, not once per keystroke', async () => {
    wrapper = mountOverlay();
    await type('n');
    await type('ne');
    await type('nee');
    await type('needle');
    await settle();

    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith('repo1', 'needle');
  });

  test('trims the query before sending it', async () => {
    wrapper = mountOverlay();
    await type('  needle  ');
    await settle();

    expect(search).toHaveBeenCalledWith('repo1', 'needle');
  });

  test('groups hits by file, in first-hit order', async () => {
    wrapper = mountOverlay();
    await type('needle');
    await settle();

    const paths = wrapper.findAll('.hit-path').map((el) => el.text());
    expect(paths[0]).toContain('src/a.ts');
    expect(paths[0]).toContain('2');
    expect(paths[1]).toContain('src/b.ts');
    expect(wrapper.findAll('.hit-row').length).toBe(3);
  });

  test('an empty result says so rather than looking like a failure', async () => {
    search.mockResolvedValue(result([]));
    wrapper = mountOverlay();
    await type('needle');
    await settle();

    expect(wrapper.find('[data-testid="search-no-matches"]').exists()).toBe(true);
  });

  test('surfaces a failed search instead of throwing or showing stale hits', async () => {
    wrapper = mountOverlay();
    await type('needle');
    await settle();
    expect(wrapper.findAll('.hit-row').length).toBe(3);

    search.mockRejectedValue(new Error('daemon exploded'));
    await type('needle2');
    await settle();

    // The message itself is displayError's call (a bare Error reads as a
    // connection loss, which is the app-wide convention) — what matters
    // here is that the failure is shown and the old hits are gone.
    expect(wrapper.find('[data-testid="search-error"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="search-error"]').text().length).toBeGreaterThan(0);
    expect(wrapper.findAll('.hit-row').length).toBe(0);
  });

  test('clearing the query clears the results', async () => {
    wrapper = mountOverlay();
    await type('needle');
    await settle();
    expect(wrapper.findAll('.hit-row').length).toBe(3);

    await type('');
    await settle();
    expect(wrapper.findAll('.hit-row').length).toBe(0);
  });
});

describe('stale replies', () => {
  test('a slow earlier reply never overwrites a newer one', async () => {
    let resolveFirst!: (value: GrepResult) => void;
    search.mockImplementationOnce(
      () =>
        new Promise<GrepResult>((resolve) => {
          resolveFirst = resolve;
        })
    );
    search.mockResolvedValueOnce(result([HITS[2]]));

    wrapper = mountOverlay();
    await type('needle');
    await vi.advanceTimersByTimeAsync(500); // first request in flight
    await type('needle2');
    await settle(); // second request resolves

    // The first request answers late, with different results.
    resolveFirst(result(HITS));
    await nextTick();
    await nextTick();

    expect(wrapper.findAll('.hit-row').length).toBe(1);
  });
});

describe('reporting its own limits', () => {
  test('says when the result set was capped', async () => {
    search.mockResolvedValue(result(HITS, { capped: true }));
    wrapper = mountOverlay();
    await type('needle');
    await settle();

    expect(wrapper.find('[data-testid="search-capped"]').exists()).toBe(true);
  });

  test('says when the search stopped early', async () => {
    search.mockResolvedValue(result(HITS, { incomplete: true }));
    wrapper = mountOverlay();
    await type('needle');
    await settle();

    expect(wrapper.find('[data-testid="search-incomplete"]').exists()).toBe(true);
  });
});

describe('untrusted content', () => {
  test('renders matched text as text, never as markup', async () => {
    search.mockResolvedValue(
      result([
        {
          path: 'evil.ts',
          line: 1,
          text: '<img src=x onerror="alert(1)">',
          truncated: false,
        },
      ])
    );
    wrapper = mountOverlay();
    await type('needle');
    await settle();

    const row = wrapper.find('.hit-text');
    expect(row.text()).toContain('<img src=x');
    expect(row.element.querySelector('img')).toBeNull();
  });

  test('marks a truncated line so it does not read as the whole line', async () => {
    search.mockResolvedValue(
      result([{ path: 'min.js', line: 1, text: 'x'.repeat(400), truncated: true }])
    );
    wrapper = mountOverlay();
    await type('needle');
    await settle();

    expect(wrapper.find('.hit-text').text().endsWith('…')).toBe(true);
  });
});

describe('activating a hit', () => {
  test('reveals the file AT ITS LINE and closes the overlay', async () => {
    wrapper = mountOverlay();
    const explorer = useExplorerStore();
    const ui = useUiStore();
    const reveal = vi.spyOn(explorer, 'revealFile').mockResolvedValue();

    await type('needle');
    await settle();
    await wrapper.findAll('.hit-row')[2].trigger('click');

    expect(reveal).toHaveBeenCalledWith('src/b.ts', { line: 7 });
    expect(ui.activeView).toBe('explorer');
    expect(ui.activeOverlay).toBeNull();
  });

  test('Enter activates the selected hit, not always the first', async () => {
    wrapper = mountOverlay();
    const explorer = useExplorerStore();
    const reveal = vi.spyOn(explorer, 'revealFile').mockResolvedValue();

    await type('needle');
    await settle();

    const input = wrapper.find('[data-testid="search-input"]');
    await input.trigger('keydown', { key: 'ArrowDown' });
    await input.trigger('keydown', { key: 'Enter' });

    expect(reveal).toHaveBeenCalledWith('src/a.ts', { line: 40 });
  });

  test('selection stops at the ends rather than wrapping off the list', async () => {
    wrapper = mountOverlay();
    const explorer = useExplorerStore();
    const reveal = vi.spyOn(explorer, 'revealFile').mockResolvedValue();

    await type('needle');
    await settle();

    const input = wrapper.find('[data-testid="search-input"]');
    for (let i = 0; i < 10; i++) await input.trigger('keydown', { key: 'ArrowDown' });
    await input.trigger('keydown', { key: 'Enter' });

    expect(reveal).toHaveBeenCalledWith('src/b.ts', { line: 7 });
  });
});

describe('repo switching', () => {
  test('closes when the active repo changes under it (follow mode)', async () => {
    wrapper = mountOverlay();
    const ui = useUiStore();
    ui.openOverlay('search');
    const daemon = useDaemonStore();

    daemon.activeRepoId = 'other-repo';
    await nextTick();

    expect(ui.activeOverlay).toBeNull();
  });
});
