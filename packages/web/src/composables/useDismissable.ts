/**
 * useDismissable: the open/closed state of a click-outside-or-Escape popover,
 * with its two document listeners and their teardown.
 *
 * Both header switchers (repo, worktree) carried a byte-identical copy of this
 * — the same two handlers, the same mount/unmount pair, the same `open` and
 * `rootEl` refs. WorktreeSwitcher's own header comment says it deliberately
 * "mirrors RepoSwitcher's custom button+panel", so the duplication was known
 * and maintained by hand.
 *
 * Four behaviours preserved deliberately, each of which is a real trap:
 *
 * 1. Listeners go on `document`, NOT `window`. useGlobalKeys listens on window,
 *    and document handlers fire first in the bubble path; neither switcher
 *    calls preventDefault, so useGlobalKeys still sees Escape and no-ops (its
 *    branch requires an active overlay). Moving to window reorders that.
 * 2. Registration happens at mount, not while open. WorktreeSwitcher's root is
 *    behind v-if="hasMultiple" but the component still mounts, so the listeners
 *    are live-but-inert in that state. That is existing behaviour, not a bug to
 *    fix during a move.
 * 3. The caller MUST destructure as `const { open, rootEl } = useDismissable()`.
 *    Vue binds `ref="rootEl"` by matching the setup variable NAME, so renaming
 *    on destructure breaks outside-click detection silently — no error, the
 *    panel just stops closing.
 * 4. Escape closes only when open, so a shared Escape does not get swallowed.
 */

import { onBeforeUnmount, onMounted, ref } from 'vue';
import type { Ref } from 'vue';

export interface Dismissable {
  /** Whether the popover is open. Callers toggle this. */
  open: Ref<boolean>;
  /** Bind with `ref="rootEl"` — the element an outside click is measured against. */
  rootEl: Ref<HTMLElement | null>;
}

export function useDismissable(): Dismissable {
  const open = ref(false);
  const rootEl = ref<HTMLElement | null>(null);

  function onDocumentPointerDown(event: MouseEvent): void {
    if (open.value && rootEl.value && !rootEl.value.contains(event.target as Node)) {
      open.value = false;
    }
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && open.value) open.value = false;
  }

  onMounted(() => {
    document.addEventListener('mousedown', onDocumentPointerDown);
    document.addEventListener('keydown', onKeydown);
  });

  onBeforeUnmount(() => {
    document.removeEventListener('mousedown', onDocumentPointerDown);
    document.removeEventListener('keydown', onKeydown);
  });

  return { open, rootEl };
}
