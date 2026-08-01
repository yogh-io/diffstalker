/**
 * useActiveRowScroll: keep the active row of a list visible in its own
 * scroller, without stealing the scroll from under a pointing user.
 *
 * Changes and Compare both had this — the same nearest-edge rect math, the
 * same pointerInList suppression ref, the same nextTick watch, and the same
 * pair of pointerenter/pointerleave bindings. CompareView's comment literally
 * says it "mirrors ChangesView, which already does this".
 *
 * The handlers are returned rather than the ref, so the suppression half does
 * not stay duplicated in both templates.
 *
 * TWO ORDERING INVARIANTS. Both change behaviour if rearranged:
 *
 *  1. The pointerInList check happens BEFORE nextTick, not inside it. A
 *     pointerleave landing between the watch firing and the flush must not
 *     un-suppress a scroll the user already declined by pointing at the list.
 *  2. The watch stays at Vue's default pre-flush timing with the DOM read
 *     deferred to nextTick — the row for the new key does not exist yet when
 *     the watch fires.
 *
 * Deliberately NOT used by Explorer or the finder. Explorer's `treeEl` is the
 * inner .tree, not its scroller; that band is width:max-content in an
 * overflow:auto box, so its reveal must move horizontally too, which this
 * vertical-only scrollTop math would silently drop. Its trigger is also a
 * discrete watch (finder, follow mode) where pointer suppression would swallow
 * a reveal the user asked for, rather than a continuous scroll-spy.
 */

import { nextTick, ref, watch } from 'vue';
import type { Ref, WatchSource } from 'vue';

export interface ActiveRowScroll {
  /** Bind to @pointerenter on the list. */
  onPointerEnter: () => void;
  /** Bind to @pointerleave on the list. */
  onPointerLeave: () => void;
}

export function useActiveRowScroll(
  scroller: Ref<HTMLElement | null>,
  source: WatchSource,
  resolveRow: () => HTMLElement | null
): ActiveRowScroll {
  /** Suppress the auto-scroll while the pointer is inside the list. */
  const pointerInList = ref(false);

  /**
   * Nearest-edge scroll inside the list's own scroller. Manual scrollTop
   * math, never scrollIntoView — that scrolls every ancestor as well.
   */
  function scrollActiveRowIntoView(): void {
    const box = scroller.value;
    if (!box) return;
    const row = resolveRow();
    if (!row) return;
    const outer = box.getBoundingClientRect();
    const inner = row.getBoundingClientRect();
    if (inner.top < outer.top) box.scrollTop += inner.top - outer.top;
    else if (inner.bottom > outer.bottom) box.scrollTop += inner.bottom - outer.bottom;
  }

  watch(source, () => {
    if (pointerInList.value) return; // invariant 1: before the flush, not inside it
    void nextTick(scrollActiveRowIntoView);
  });

  return {
    onPointerEnter: () => {
      pointerInList.value = true;
    },
    onPointerLeave: () => {
      pointerInList.value = false;
    },
  };
}
