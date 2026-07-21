/**
 * Portrait test helpers. jsdom/happy-dom can't actually match the
 * orientation media query, so portrait tests stub window.matchMedia to
 * report a match — usePortrait() then flips every portrait branch on.
 * Restore with vi.unstubAllGlobals().
 */

import { vi } from 'vitest';

/** Stub matchMedia so every query reports `matches` (listener-capable). */
export function stubMatchMedia(matches: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }))
  );
}

/** Append the ActivityRail's Teleport target (portrait toolbar slot). */
export function addToolbarSlot(): HTMLElement {
  const slot = document.createElement('div');
  slot.id = 'view-toolbar-slot';
  document.body.appendChild(slot);
  return slot;
}
