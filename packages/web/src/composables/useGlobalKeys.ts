/**
 * useGlobalKeys: the app-wide keyboard layer, mounted once at the shell.
 *
 * - Ctrl/⌘+P — toggle the fuzzy finder (needs an active repo; beats the
 *   browser's print dialog only when it acts; Ctrl+Shift+P is not ours);
 * - Esc — close the open overlay (finder/help);
 * - ? — toggle the hotkeys help;
 * - 1..N — switch view, derived from VIEWS so the digits always match
 *   the rail order (1=Changes, 2=Journal, 3=History, ...);
 * - a/s/d/f — the display toggles, grouped on the home row: a=auto mode
 *   (auto-select/auto-switch on changes), s=diff syntax highlighting,
 *   d=split/unified diff layout, f=follow mode. f is a no-op when the
 *   daemon has no follow target (mirrors the header button's disabled
 *   state); a/s/d/f share the CLI's a and f bindings.
 * - e — expand every diff body held back by the size gate, so browser
 *   find-in-page reaches the whole changeset;
 * - / — narrow the list the current view is showing. A bare key, not a
 *   chord: it is the vi/less/GitHub gesture, it costs nothing the browser
 *   insists on, and it reads as "narrow this list" rather than "search
 *   the world". Pressing it again returns the caret to the input.
 *
 * Ctrl+F is deliberately NOT ours and never will be: find-in-page is the
 * in-diff search, which is why windowed virtualization was rejected.
 * Ctrl+H and Ctrl+O are not ours either — they are browser History and
 * the file picker, and ⌘+H is macOS "hide application", which cannot be
 * intercepted at all.
 *
 * Bare keys (digits, ?) never fire while the user is typing in an
 * input/textarea/select/contenteditable (the finder's input included)
 * or while a modifier is held; the view switch is also inert while an
 * overlay is up (overlays are modal). View-internal navigation
 * (arrows/Enter within lists) stays in the views.
 */

import { onBeforeUnmount, onMounted } from 'vue';
import { useDaemonStore } from '../stores/daemon';
import { beginUserNav } from './useUrlSync';
import { useUiStore, VIEWS } from '../stores/ui';
import { useFilterStore } from '../stores/filter';
import type { ViewName } from '../prefs';

/** Digit -> view, derived from the rail order — never hardcoded. */
const VIEW_KEYS: Record<string, ViewName> = Object.fromEntries(
  VIEWS.map((view, index) => [String(index + 1), view.name])
);

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export function useGlobalKeys(): void {
  const ui = useUiStore();
  const daemon = useDaemonStore();
  const filter = useFilterStore();

  /**
   * The bare-key display toggles, grouped on the home row (a s d f). Kept out of
   * onKeydown so that hot path stays flat. Returns true when it claimed the key.
   */
  function handleDisplayToggle(key: string): boolean {
    switch (key) {
      case 'a':
        ui.toggleAutoMode();
        return true;
      case 's':
        ui.toggleDiffSyntax();
        return true;
      case 'd':
        ui.toggleDiffMode();
        return true;
      case 'f':
        // Follow acts only when the daemon has a hook file to follow — mirrors
        // the header button's disabled state; otherwise the key does nothing.
        if ((daemon.follow?.targetFile ?? null) !== null) daemon.toggleFollow();
        return true;
      case 'e':
        // No-op unless a stacked view is showing gated bodies; the views
        // watch the request and ignore it when nothing is withheld.
        ui.requestExpandGated();
        return true;
      default:
        return false;
    }
  }

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

    if (event.key === '/') {
      event.preventDefault();
      filter.openAndFocus();
      return;
    }

    // Display toggles on the home row (a s d f).
    if (handleDisplayToggle(event.key)) return;

    const view = VIEW_KEYS[event.key];
    if (view !== undefined) {
      beginUserNav({ view });
      ui.setActiveView(view);
    }
  }

  onMounted(() => window.addEventListener('keydown', onKeydown));
  onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));
}
