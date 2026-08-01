/**
 * useMediaQuery: a reactive matchMedia wrapper. Returns a ref that
 * tracks whether the query matches, updating on change events and
 * cleaning the listener up when the owning component unmounts.
 *
 * SSR/test-safe: without a window (or matchMedia) it stays false — the
 * landscape/default path.
 */

import { getCurrentInstance, onBeforeUnmount, ref, watchEffect } from 'vue';
import type { Ref } from 'vue';

/**
 * The "stacked view" trigger, mirrored by every portrait CSS block: every
 * side-by-side view (file list | diff) rotates to top/bottom, and the
 * active view lifts its toolbar into the tab band. It fires on window
 * SHAPE (portrait or squarer than 1:1) OR on width — at 1400px wide or
 * less, list-beside-diff is too cramped, so a narrow LANDSCAPE window
 * stacks too, not just a portrait monitor. (Name kept `PORTRAIT_QUERY`
 * for its call sites.)
 *
 * This is ONLY the view-split trigger now. The nav rail is a top tab band
 * at every width (see ActivityRail.vue / App.vue) — it no longer reflows,
 * so it never eats horizontal room from the diff.
 */
export const PORTRAIT_QUERY =
  '(orientation: portrait), (max-aspect-ratio: 1/1), (max-width: 1400px)';

export function useMediaQuery(query: string): Ref<boolean> {
  const matches = ref(false);
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return matches;
  }
  const mql = window.matchMedia(query);
  matches.value = mql.matches;
  // Some test stubs (and ancient WebKit) hand back a bare object without
  // addEventListener — then the value is a one-shot read, never live.
  if (typeof mql.addEventListener === 'function') {
    const onChange = (event: MediaQueryListEvent): void => {
      matches.value = event.matches;
    };
    mql.addEventListener('change', onChange);
    // Only register cleanup inside a component setup; a bare call (tests)
    // simply keeps the listener for the window's lifetime.
    if (getCurrentInstance()) {
      onBeforeUnmount(() => mql.removeEventListener('change', onChange));
    }
  }
  return matches;
}

/** Shared shorthand: is the app in the portrait/vertical layout? */
export function usePortrait(): Ref<boolean> {
  return useMediaQuery(PORTRAIT_QUERY);
}

/**
 * The layout mode, published as `data-split="stacked" | "split"` on the root
 * element so CSS can state the breakpoint ONCE.
 *
 * PORTRAIT_QUERY used to be copy-pasted into five `@media` blocks as well as
 * being the JS query — six places to keep in step, with nothing to catch a
 * miss. CSS has no way to name a media query, so the standard fix is to let JS
 * own the single definition and expose the answer as an attribute; the CSS
 * blocks become `:root[data-split='stacked'] …`.
 *
 * Call this ONCE, from App setup — the same place the theme attribute is
 * stamped, and for the same reason: components with portrait styles do not
 * all call usePortrait (ViewToolbarStrip has the styles and never calls it),
 * so the attribute cannot depend on which view happens to be mounted.
 */
export function useSplitMode(): Ref<boolean> {
  const isPortrait = usePortrait();
  if (typeof document !== 'undefined') {
    watchEffect(() => {
      document.documentElement.dataset.split = isPortrait.value ? 'stacked' : 'split';
    });
  }
  return isPortrait;
}
