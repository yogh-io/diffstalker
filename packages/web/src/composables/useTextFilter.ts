/**
 * useTextFilter: narrow a list the client already holds, by fuzzy text.
 *
 * The same matcher the file finder uses (@diffstalker/core/view/finderModel,
 * fzf smart-case), so "narrow this list" and "find a file" rank alike.
 *
 * Entirely client-side: it filters an array that is already in memory.
 * There is no request here and there never should be — the moment a
 * filter needs to walk repo content it has stopped being a filter.
 *
 * Order is preserved. fzf ranks by score, but these lists are ordered for
 * a reason (staged after modified, commits newest first), and resorting
 * them by match quality would make rows jump around while typing.
 */

import { computed, type ComputedRef, type Ref } from 'vue';
import { createFinderIndex } from '@diffstalker/core/view/finderModel';
import { useFilterStore } from '../stores/filter';

/**
 * A ceiling on how much one keystroke can scan. These corpora are small
 * (a changeset, a page of commits), so this never binds in practice — it
 * is here so a later, bigger corpus cannot silently make typing quadratic.
 */
export const FILTER_MAX_ITEMS = 5000;

export interface TextFilter<T> {
  /** The narrowed list, in the input's order. */
  filtered: ComputedRef<T[]>;
  /** Size of the full set, before narrowing. */
  total: ComputedRef<number>;
  /** True when a non-empty query is actually narrowing something. */
  active: ComputedRef<boolean>;
  /** True when the query matched nothing (as opposed to "nothing loaded"). */
  empty: ComputedRef<boolean>;
}

/**
 * `toText` picks the string each item is matched on — a path, a subject.
 * It must be stable per item; it is called once per item per keystroke.
 */
export function useTextFilter<T>(
  items: Ref<T[]> | ComputedRef<T[]>,
  toText: (item: T) => string
): TextFilter<T> {
  const filter = useFilterStore();

  const total = computed(() => items.value.length);

  const filtered = computed(() => {
    const all = items.value;
    const query = filter.query;
    if (query === '' || all.length === 0) return all;

    const scanned = all.slice(0, FILTER_MAX_ITEMS);
    const texts = scanned.map(toText);
    const matched = new Set(
      createFinderIndex(texts, scanned.length)
        .find(query)
        .map((match) => match.text)
    );
    // Filter the ORIGINAL list rather than mapping fzf's ranked output:
    // that keeps input order, and keeps duplicate texts (two entries for
    // one path, staged and unstaged) both visible.
    return scanned.filter((item) => matched.has(toText(item)));
  });

  const active = computed(() => filter.query !== '');
  const empty = computed(() => active.value && total.value > 0 && filtered.value.length === 0);

  return { filtered, total, active, empty };
}
