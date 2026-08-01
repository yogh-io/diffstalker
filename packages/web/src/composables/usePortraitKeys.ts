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

import { computed } from 'vue';
import type { ComputedRef, Ref } from 'vue';

const SCROLL_STEP = 48;

/** j/k → move(±1) for a portrait band list; inert in landscape. */
export function makeBandKeyHandler<T = void>(
  isPortrait: Ref<boolean>,
  move: (delta: number, row: T) => void
): (event: KeyboardEvent, row: T) => void {
  return (event: KeyboardEvent, row: T): void => {
    if (!isPortrait.value) return;
    if (event.key === 'j') {
      event.preventDefault();
      move(1, row);
    } else if (event.key === 'k') {
      event.preventDefault();
      move(-1, row);
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

/**
 * The four attributes a portrait payload region needs, as one bindable object.
 * Every split view spelled these out identically — tabindex, role, aria-label,
 * and the j/k handler — and usePortraitKeys already owned the handler half.
 *
 * Two details that bite if changed:
 *  - The key must be the kebab 'aria-label'. Vue calls setAttribute(key, value)
 *    verbatim, so an `ariaLabel` key emits `arialabel` and silently drops the
 *    accessible name.
 *  - Do NOT leave a separate @keydown beside v-bind of this object: Vue merges
 *    duplicate listeners into an array and fires the handler twice.
 *
 * The handler is built ONCE outside the computed so its bound identity is
 * stable across re-renders.
 */
export function portraitPayloadAttrs(
  isPortrait: Ref<boolean>,
  payloadEl: Ref<HTMLElement | null>,
  label: string,
  options?: { self?: boolean }
): ComputedRef<{
  tabindex?: number;
  role?: string;
  'aria-label'?: string;
  onKeydown: (event: KeyboardEvent) => void;
}> {
  const onKeydown = makePayloadKeyHandler(isPortrait, payloadEl, options);
  return computed(() =>
    isPortrait.value
      ? { tabindex: 0, role: 'region', 'aria-label': label, onKeydown }
      : { onKeydown }
  );
}
