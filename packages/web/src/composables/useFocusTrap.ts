/**
 * useFocusTrap: dialog focus management for the overlays.
 *
 * On mount: remembers the previously focused element and moves focus
 * into the container ([data-autofocus] target if present, else the
 * container itself — give it tabindex="-1"). While mounted: Tab and
 * Shift+Tab cycle within the container's focusable elements instead of
 * escaping to the page. On unmount: focus returns to where it was —
 * unless that element can no longer take it (gone from the DOM, or
 * disabled by the very action that closed the dialog, e.g. a confirm
 * that flips an in-progress flag); then the caller's `fallback` target
 * gets focus instead of letting it drop to <body>.
 *
 * A container keydown handler that already claimed Tab (the finder's
 * result cycling) wins — the trap skips defaultPrevented events.
 */

import { onBeforeUnmount, onMounted } from 'vue';
import type { Ref } from 'vue';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), ' +
  'textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface FocusTrapOptions {
  /** Focus target when the remembered element cannot be restored to. */
  fallback?: () => HTMLElement | null;
}

/** Can focus return here? Not when it left the DOM or got disabled. */
function canRestore(el: HTMLElement | null): el is HTMLElement {
  if (el === null || !el.isConnected) return false;
  if ('disabled' in el && (el as HTMLElement & { disabled?: boolean }).disabled === true) {
    return false;
  }
  return true;
}

export function useFocusTrap(
  container: Ref<HTMLElement | null>,
  options: FocusTrapOptions = {}
): void {
  let previous: HTMLElement | null = null;

  function onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Tab' || event.defaultPrevented) return;
    const root = container.value;
    if (!root) return;
    const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (items.length === 0) {
      event.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    // "Outside" means: not one of the trap's focusable items. That
    // includes the dialog root itself (tabindex="-1" — e.g. after a
    // click on dialog padding): letting the browser handle Shift+Tab
    // from there would walk out to the page behind the scrim.
    const outside = !(active instanceof HTMLElement) || !items.includes(active);
    if (outside) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  onMounted(() => {
    previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = container.value;
    root?.addEventListener('keydown', onKeydown);
    (root?.querySelector<HTMLElement>('[data-autofocus]') ?? root)?.focus();
  });

  onBeforeUnmount(() => {
    container.value?.removeEventListener('keydown', onKeydown);
    if (canRestore(previous)) {
      previous.focus();
    } else {
      options.fallback?.()?.focus();
    }
  });
}
