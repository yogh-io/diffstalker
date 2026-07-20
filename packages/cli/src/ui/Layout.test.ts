import { describe, it, expect } from 'bun:test';
import { calculateLayout } from './Layout.js';

// A normal-height terminal used across the app's docs and tests.
const H = 44;
const W = 100;

describe('calculateLayout split ratio', () => {
  it('overhead is header + 3 separators + footer', () => {
    const dims = calculateLayout(H, W, 0.4);
    expect(dims.topPaneHeight + dims.bottomPaneHeight).toBe(H - 5);
  });

  it('the default 0.4 split gives a top pane tall enough for all three sections', () => {
    // File list at its fullest: Modified (header + >=1 file), a spacer,
    // Untracked (header + >=1), a spacer, Staged (header + >=1) = 8 rows.
    // The default split must not clip the Staged section off the bottom.
    const dims = calculateLayout(H, W, 0.4);
    expect(dims.topPaneHeight).toBe(Math.floor((H - 5) * 0.4)); // 15
    expect(dims.topPaneHeight).toBeGreaterThanOrEqual(8);
  });

  it('honours a persisted small ratio (0.15) — a short top pane is config, not a bug', () => {
    // A persisted splitRatio of 0.15 (the floor, reached by shrinking the
    // top pane) legitimately produces a ~5-row top pane. This is the user's
    // saved choice, not a layout regression: the same terminal with the
    // default ratio shows everything.
    const small = calculateLayout(H, W, 0.15);
    expect(small.topPaneHeight).toBe(Math.floor((H - 5) * 0.15)); // 5
    const dflt = calculateLayout(H, W, 0.4);
    expect(dflt.topPaneHeight).toBeGreaterThan(small.topPaneHeight);
  });

  it('footer sits on the last terminal row', () => {
    expect(calculateLayout(H, W, 0.4).footerRow).toBe(H - 1);
  });
});
