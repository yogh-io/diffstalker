/**
 * Keyboard list navigation, shared by the views whose lists behave the same
 * way: Changes' file rows, Compare's file tree, History's commits.
 *
 * Deliberately NOT used by two lists that look similar and are not:
 *   - ExplorerView's tree, where `current` comes from the row the keydown
 *     arrived on, so -1 means "that row is gone from the tree" and the early
 *     return is correct stale-row handling. The entry rule below would turn a
 *     deliberate no-op into a jump to first/last.
 *   - FinderOverlay, whose selectedIndex starts at 0 and is never -1, and
 *     which wraps with a modulo rule (cycleSelection) rather than clamping.
 */

/**
 * The index `delta` steps from `current` in a list of `length`.
 *
 * Entering from nothing selected (`current === -1`) lands on the first row
 * going forward and the last going back, so a first Down and a first Up both
 * enter the list from the near end. Otherwise the move clamps — it does not
 * wrap; running off the end holds at the end.
 *
 * Returns -1 for an empty list, so callers can guard on the result alone.
 */
export function nextIndex(current: number, delta: number, length: number): number {
  if (length === 0) return -1;
  if (current === -1) return delta > 0 ? 0 : length - 1;
  return Math.min(length - 1, Math.max(0, current + delta));
}
