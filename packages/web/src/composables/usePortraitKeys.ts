/**
 * Portrait keyboard model, shared by the four views:
 *
 * - j/k on a top-band row moves the selection (the band's arrow keys
 *   keep working as before);
 * - the payload pane (diff / content) is focusable in portrait
 *   (tabindex 0, so Tab jumps band → payload) and j/k scroll it;
 * - Enter on a band row selects AND hands focus to the payload (wired
 *   per view).
 *
 * Every handler is inert in landscape — no landscape key changes.
 */

import type { Ref } from 'vue';

const SCROLL_STEP = 48;

/** j/k → move(±1) for a portrait band list; inert in landscape. */
export function makeBandKeyHandler(
  isPortrait: Ref<boolean>,
  move: (delta: number) => void
): (event: KeyboardEvent) => void {
  return (event: KeyboardEvent): void => {
    if (!isPortrait.value) return;
    if (event.key === 'j') {
      event.preventDefault();
      move(1);
    } else if (event.key === 'k') {
      event.preventDefault();
      move(-1);
    }
  };
}

/** j/k → scroll the focused payload pane; inert in landscape.
 *  `self: true` scrolls the pane element itself (Compare's diffs column
 *  is its own scroller); otherwise the DiffView/content scroller inside
 *  the pane is the target. */
export function makePayloadKeyHandler(
  isPortrait: Ref<boolean>,
  payloadEl: Ref<HTMLElement | null>,
  options?: { self?: boolean }
): (event: KeyboardEvent) => void {
  return (event: KeyboardEvent): void => {
    if (!isPortrait.value) return;
    if (event.key !== 'j' && event.key !== 'k') return;
    event.preventDefault();
    const root = payloadEl.value;
    if (!root) return;
    const scroller = options?.self
      ? root
      : (root.querySelector<HTMLElement>('.diff-scroll, .code-scroll') ?? root);
    scroller.scrollTop += event.key === 'j' ? SCROLL_STEP : -SCROLL_STEP;
  };
}
