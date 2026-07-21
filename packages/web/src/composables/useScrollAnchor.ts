/**
 * useScrollAnchor: the scroll-anchoring "sandwich" around a model commit
 * (docs/web-diff-stream-architecture.md, section 6). Native scroll
 * anchoring is out — Safari has none, sticky headers suppress it, and it
 * would double-correct against us — so the scroller carries
 * `overflow-anchor: none` and this composable is the ONE compensation
 * path.
 *
 * The sandwich:
 * 1. prepare() — called from a `{ flush: 'pre' }` watcher on the incoming
 *    files, DOM still old. Picks the anchor: the anchorable element at
 *    the viewport top whose stable key survives into the next model, and
 *    records its getBoundingClientRect().top. Fallback ladder when that
 *    element's key is removed: nearest surviving hunk above → the
 *    element's own file section → the nearest surviving file section by
 *    offsetTop. Worst case the anchor is off by one header — never a
 *    screenful.
 * 2. Vue patches the DOM.
 * 3. restore() — called from a `{ flush: 'post' }` watcher: same task,
 *    after the DOM mutation, BEFORE the browser paints. Re-finds the
 *    anchor by key, re-measures, and writes `scrollTop += newTop − oldTop`
 *    in one instant assignment. Measured and corrected inside one frame ⇒
 *    zero visible movement. Never requestAnimationFrame here — rAF would
 *    let the uncorrected frame paint first; that IS the flicker.
 *
 * Skips: when every changed section sits entirely below the viewport,
 * prepare() records no anchor — below-fold size changes never move the
 * viewport, so there is nothing to compensate (and no layout to force).
 *
 * Tween handoff: while `isTweenActive()` reports true, neither restore()
 * nor nudge() writes scrollTop — the smooth tween (phase 1's
 * useStackScroll) re-reads its target offset every frame and absorbs the
 * shift itself; a compensation write here would fight it.
 */

import type { Ref } from 'vue';

export type AnchorKind = 'file' | 'hunk';

/** One anchorable element in the CURRENT (pre-patch) DOM. */
export interface AnchorCandidate {
  /** Stable key; hunk keys are composed by the caller so they can never
   *  collide with file keys. */
  key: string;
  kind: AnchorKind;
  /** Key of the file section this candidate belongs to (=== key for
   *  kind 'file') — the second rung of the fallback ladder. */
  fileKey: string;
  el: HTMLElement;
}

/** What the caller knows about the commit that is about to patch the DOM. */
export interface AnchorCommit {
  /** Every anchor key (file + hunk) present in the NEXT model. */
  survivingKeys: ReadonlySet<string>;
  /**
   * Current-DOM section elements whose content changes in this commit
   * (diff replaced, collapsed toggled, section removed). `null` stands
   * for a section entering the model — it has no old element to measure,
   * which disables the below-viewport skip (compensation still runs and
   * measures a real 0 when the insert lands below the fold).
   */
  changedEls: readonly (HTMLElement | null)[];
}

export interface UseScrollAnchorOptions {
  /**
   * Anchorable elements of the CURRENT DOM in document order (rect tops
   * non-decreasing: each file section element, then its hunk group
   * elements). Called by prepare(); only O(log n) of them are measured.
   * Use the non-sticky group elements (section / hunk), never the sticky
   * headers themselves — a stuck header's rect does not move with its
   * content.
   */
  candidates: () => AnchorCandidate[];
  /** Key → element in the CURRENT DOM; called by restore() post-patch. */
  resolve: (key: string) => HTMLElement | null;
  /** True while a smooth scroll tween is animating (see tween handoff). */
  isTweenActive?: () => boolean;
}

export interface ScrollAnchor {
  /** Pre-flush step: pick and measure the anchor for the coming commit. */
  prepare(commit: AnchorCommit): void;
  /**
   * Post-flush step: re-measure the anchor and compensate scrollTop.
   * Returns the measured delta (0 when skipped/none) — the write itself
   * is withheld while a tween is in flight.
   */
  restore(): number;
  /**
   * Out-of-band scrollTop-only compensation (the ResizeObserver safety
   * net): applies `delta` unless a tween is in flight.
   */
  nudge(delta: number): void;
}

/** Sub-pixel slack when deciding "at the viewport top". */
const TOP_EPSILON = 1;

/**
 * Index of the candidate at the viewport top: the LAST candidate whose
 * rect top is at or above `viewTop` (binary search — candidate tops are
 * non-decreasing in document order; note a file section's top coincides
 * with its first hunk's region, which keeps tops monotonic even though
 * bottoms are not). Scrolled to the very top, that is candidate 0.
 */
function anchorIndexAt(candidates: AnchorCandidate[], viewTop: number): number {
  let lo = 0;
  let hi = candidates.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candidates[mid].el.getBoundingClientRect().top <= viewTop + TOP_EPSILON) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found === -1 ? 0 : found;
}

/**
 * The fallback ladder. Primary: the candidate at the viewport top, when
 * its key survives. Then: nearest surviving hunk above it → the
 * primary's own file section → the nearest surviving file section by
 * offsetTop. Null when nothing at all survives (full replacement) —
 * there is no anchor to hold, so the commit lands uncompensated.
 */
function pickAnchor(
  candidates: AnchorCandidate[],
  index: number,
  surviving: ReadonlySet<string>
): AnchorCandidate | null {
  const primary = candidates[index];
  if (surviving.has(primary.key)) return primary;

  for (let i = index - 1; i >= 0; i--) {
    const c = candidates[i];
    if (c.kind === 'hunk' && surviving.has(c.key)) return c;
  }

  const ownFile = candidates.find((c) => c.kind === 'file' && c.key === primary.fileKey);
  if (ownFile && surviving.has(ownFile.key)) return ownFile;

  const primaryTop = primary.el.offsetTop;
  let best: AnchorCandidate | null = null;
  let bestDistance = Infinity;
  for (const c of candidates) {
    if (c.kind !== 'file' || !surviving.has(c.key)) continue;
    const distance = Math.abs(c.el.offsetTop - primaryTop);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = c;
    }
  }
  return best;
}

/** True when every changed section provably sits below the viewport. */
function allChangesBelow(
  changedEls: readonly (HTMLElement | null)[],
  viewBottom: number
): boolean {
  return changedEls.every((el) => el !== null && el.getBoundingClientRect().top >= viewBottom);
}

export function useScrollAnchor(
  scroller: Ref<HTMLElement | null>,
  opts: UseScrollAnchorOptions
): ScrollAnchor {
  /** The anchor picked by prepare(), consumed by the next restore(). */
  let pending: { key: string; top: number } | null = null;

  function prepare(commit: AnchorCommit): void {
    pending = null;
    const scrollerEl = scroller.value;
    if (!scrollerEl) return;

    const viewTop = scrollerEl.getBoundingClientRect().top;
    const viewBottom = viewTop + scrollerEl.clientHeight;
    // Nothing changed, or everything changed below the fold: the
    // viewport cannot move — skip (also avoids forcing layout on the
    // whole candidate list).
    if (allChangesBelow(commit.changedEls, viewBottom)) return;

    const candidates = opts.candidates();
    if (candidates.length === 0) return;

    const anchor = pickAnchor(candidates, anchorIndexAt(candidates, viewTop), commit.survivingKeys);
    if (!anchor) return;
    pending = { key: anchor.key, top: anchor.el.getBoundingClientRect().top };
  }

  function restore(): number {
    const anchor = pending;
    pending = null;
    if (!anchor) return 0;
    const scrollerEl = scroller.value;
    if (!scrollerEl) return 0;

    const el = opts.resolve(anchor.key);
    if (!el) return 0; // survived-key promise broken — bail, never guess

    const delta = el.getBoundingClientRect().top - anchor.top;
    if (delta === 0) return 0;
    if (opts.isTweenActive?.()) return delta; // tween absorbs it per frame
    scrollerEl.scrollTop += delta;
    return delta;
  }

  function nudge(delta: number): void {
    const scrollerEl = scroller.value;
    if (!scrollerEl || delta === 0) return;
    if (opts.isTweenActive?.()) return;
    scrollerEl.scrollTop += delta;
  }

  return { prepare, restore, nudge };
}
