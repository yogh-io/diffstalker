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

/**
 * Ensure the portrait toolbar Teleport target exists (idempotent).
 * In the app the slot is a static element in index.html (adopted into
 * the tab band by ActivityRail); tests that mount a view without the
 * rail create it here. Test afterEach hooks clear document.body, so
 * each test starts without one.
 */
export function addToolbarSlot(): HTMLElement {
  const existing = document.getElementById('view-toolbar-slot');
  if (existing) return existing;
  const slot = document.createElement('div');
  slot.id = 'view-toolbar-slot';
  document.body.appendChild(slot);
  return slot;
}
