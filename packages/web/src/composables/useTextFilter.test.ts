/**
 * useTextFilter: the "narrow this list" matcher. Order preservation is
 * the load-bearing property — fzf ranks by score, but these lists are
 * ordered for a reason (staged after modified, commits newest first) and
 * rows must not jump around while typing.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { computed, ref } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { useTextFilter } from './useTextFilter';
import { useFilterStore } from '../stores/filter';

interface Row {
  path: string;
}

const ROWS: Row[] = [
  { path: 'packages/web/src/components/FinderOverlay.vue' },
  { path: 'packages/cli/src/ui/modals/FileFinder.ts' },
  { path: 'packages/core/src/view/finderModel.ts' },
  { path: 'README.md' },
];

function setup(rows: Row[] = ROWS) {
  const items = ref(rows);
  const filter = useTextFilter(
    computed(() => items.value),
    (row: Row) => row.path
  );
  return { items, filter, store: useFilterStore() };
}

beforeEach(() => {
  setActivePinia(createPinia());
});

describe('useTextFilter', () => {
  test('an empty query passes the whole list through', () => {
    const { filter } = setup();
    expect(filter.filtered.value).toEqual(ROWS);
    expect(filter.active.value).toBe(false);
  });

  test('narrows to fuzzy matches', () => {
    const { filter, store } = setup();
    store.setQuery('README');
    expect(filter.filtered.value.map((r) => r.path)).toEqual(['README.md']);
    expect(filter.active.value).toBe(true);
  });

  test('preserves input order rather than fzf score order', () => {
    const { filter, store } = setup();
    // 'finder' matches all three package paths; the shortest/best-scoring
    // is the third, but it must stay third.
    store.setQuery('finder');
    const paths = filter.filtered.value.map((r) => r.path);
    expect(paths).toEqual(ROWS.slice(0, 3).map((r) => r.path));
  });

  test('reports total against the unfiltered set', () => {
    const { filter, store } = setup();
    store.setQuery('README');
    expect(filter.total.value).toBe(4);
    expect(filter.filtered.value.length).toBe(1);
  });

  test('empty is true only when a query matched nothing', () => {
    const { filter, store } = setup();
    expect(filter.empty.value).toBe(false);
    store.setQuery('zzzzzzzz');
    expect(filter.empty.value).toBe(true);
  });

  test('empty stays false for an empty corpus — that is "nothing loaded"', () => {
    const { filter, store } = setup([]);
    store.setQuery('anything');
    expect(filter.empty.value).toBe(false);
  });

  test('keeps duplicate texts together (one path staged and unstaged)', () => {
    const { filter, store } = setup([{ path: 'a.ts' }, { path: 'a.ts' }, { path: 'b.ts' }]);
    store.setQuery('a.ts');
    expect(filter.filtered.value.length).toBe(2);
  });

  test('smart-case: lowercase is insensitive, uppercase is not', () => {
    const { filter, store } = setup([{ path: 'README.md' }]);
    store.setQuery('readme');
    expect(filter.filtered.value.length).toBe(1);
    store.setQuery('Readme');
    expect(filter.filtered.value.length).toBe(0);
  });

  test('reacts to the underlying list changing under a live query', () => {
    const { items, filter, store } = setup();
    store.setQuery('README');
    expect(filter.filtered.value.length).toBe(1);
    items.value = [{ path: 'other.ts' }];
    expect(filter.filtered.value.length).toBe(0);
    expect(filter.total.value).toBe(1);
  });
});

describe('filter store', () => {
  test('close clears the query and hides the chip', () => {
    const store = useFilterStore();
    store.openAndFocus();
    store.setQuery('abc');
    store.close();
    expect(store.open).toBe(false);
    expect(store.query).toBe('');
  });

  test('openAndFocus is repeatable — a second press re-focuses', () => {
    const store = useFilterStore();
    store.openAndFocus();
    const first = store.focusRequest;
    store.openAndFocus();
    expect(store.focusRequest).toBe(first + 1);
  });
});
