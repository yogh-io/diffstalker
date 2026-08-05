/**
 * useFilterStore: the "narrow this list" query.
 *
 * A filter, not a search. It hides rows from a set the client already
 * holds — no network, no syntax, no scopes, no query language. The
 * corpus is whatever the active view is showing.
 *
 * Session-only, and deliberately never persisted and never in the URL: a
 * query is a filter over an existing set, not a place. It resets when the
 * repo changes, because the set it narrowed no longer exists — follow
 * mode switching repos under the user is the common case.
 */

import { shallowRef, watch } from 'vue';
import { defineStore } from 'pinia';
import { useDaemonStore } from './daemon';

export const useFilterStore = defineStore('filter', () => {
  const daemon = useDaemonStore();

  /** The live input value. Empty means "no filter". */
  const query = shallowRef('');
  /** True while the chip is on screen — it stays open on an empty query. */
  const open = shallowRef(false);

  /**
   * A one-shot "focus the filter input" request. Pressing `/` again while
   * the chip is already open must return the caret to it; a plain boolean
   * would be inert the second time. Same seq trick as stackScrollRequest.
   */
  const focusRequest = shallowRef(0);

  function setQuery(value: string): void {
    query.value = value;
  }

  /** Open the chip (if closed) and ask for the caret. */
  function openAndFocus(): void {
    open.value = true;
    focusRequest.value += 1;
  }

  /** Close and clear. Escape from the input, and the chip's x. */
  function close(): void {
    open.value = false;
    query.value = '';
  }

  /** The repo changed under us: the narrowed set is gone. */
  function reset(): void {
    open.value = false;
    query.value = '';
  }

  // Any repo switch clears the filter — follow mode yanking the app to
  // another repo is the common case, and a query left over from the last
  // repo would silently hide most of the new one.
  watch(
    () => daemon.activeRepoId,
    () => reset()
  );

  return { query, open, focusRequest, setQuery, openAndFocus, close, reset };
});
