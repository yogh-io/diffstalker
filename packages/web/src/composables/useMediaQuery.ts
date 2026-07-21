/**
 * useMediaQuery: a reactive matchMedia wrapper. Returns a ref that
 * tracks whether the query matches, updating on change events and
 * cleaning the listener up when the owning component unmounts.
 *
 * SSR/test-safe: without a window (or matchMedia) it stays false — the
 * landscape/default path.
 */

import { getCurrentInstance, onBeforeUnmount, ref } from 'vue';
import type { Ref } from 'vue';

/**
 * The ONE portrait trigger, mirrored by every portrait CSS block: it
 * fires on window SHAPE, not width, so a 1080px-wide portrait monitor
 * (above the narrow-width breakpoints) still gets the rotated layout.
 */
export const PORTRAIT_QUERY = '(orientation: portrait), (max-aspect-ratio: 1/1)';

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
