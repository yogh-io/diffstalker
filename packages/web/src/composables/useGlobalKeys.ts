/**
 * useGlobalKeys: the app-wide keyboard layer, mounted once at the shell.
 *
 * - Ctrl/⌘+P — toggle the fuzzy finder (needs an active repo; beats the
 *   browser's print dialog only when it acts; Ctrl+Shift+P is not ours);
 * - Esc — close the open overlay (finder/help);
 * - ? — toggle the hotkeys help;
 * - 1/2/3/4 — switch to Changes/History/Compare/Explorer.
 *
 * Bare keys (digits, ?) never fire while the user is typing in an
 * input/textarea/select/contenteditable (the finder's input included)
 * or while a modifier is held; the view switch is also inert while an
 * overlay is up (overlays are modal). View-internal navigation
 * (arrows/Enter within lists) stays in the views.
 */

import { onBeforeUnmount, onMounted } from 'vue';
import { useDaemonStore } from '../stores/daemon';
import { useUiStore } from '../stores/ui';
import type { ViewName } from '../prefs';

const VIEW_KEYS: Record<string, ViewName> = {
  '1': 'changes',
  '2': 'history',
  '3': 'compare',
  '4': 'explorer',
};

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export function useGlobalKeys(): void {
  const ui = useUiStore();
  const daemon = useDaemonStore();

  function onKeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented) return;

    // ⌘/Ctrl+P (no Shift — Ctrl+Shift+P belongs to the browser/OS): the
    // finder, from anywhere — even mid-typing. Print is only suppressed
    // when the toggle actually does something; with no active repo the
    // key stays the browser's.
    if (
      (event.ctrlKey || event.metaKey) &&
      !event.altKey &&
      !event.shiftKey &&
      event.key.toLowerCase() === 'p'
    ) {
      if (ui.activeOverlay === 'finder') {
        event.preventDefault();
        ui.closeOverlay();
      } else if (daemon.activeRepoId !== null) {
        event.preventDefault();
        ui.openOverlay('finder');
      }
      return;
    }

    if (event.key === 'Escape') {
      if (ui.activeOverlay !== null) {
        event.preventDefault();
        ui.closeOverlay();
      }
      return;
    }

    // Bare keys only from here: never hijack typing or chords.
    if (isEditable(event.target) || event.ctrlKey || event.metaKey || event.altKey) return;

    if (event.key === '?') {
      event.preventDefault();
      ui.toggleOverlay('help');
      return;
    }

    if (ui.activeOverlay !== null) return; // overlays are modal

    const view = VIEW_KEYS[event.key];
    if (view !== undefined) ui.setActiveView(view);
  }

  onMounted(() => window.addEventListener('keydown', onKeydown));
  onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));
}
