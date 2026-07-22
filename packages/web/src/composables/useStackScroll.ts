/**
 * useStackScroll: the DiffStack's scroll engine — one composable owning
 * programmatic scrolling (a retargeting rAF tween) and the scroll-spy
 * that keeps the active section key honest (sections 4 + 5 of
 * docs/web-diff-stream-architecture.md).
 *
 * Offset cache: each section key's scroller-relative top, built lazily
 * and invalidated by a ResizeObserver on the scroller, window resize,
 * and the owner's explicit invalidateOffsets() after content commits.
 * The spy binary-searches it — exact, O(log n), ~free per scroll event.
 *
 * The rebuild is ARITHMETIC when the owner supplies a section height
 * model (`sectionHeights`): cumulative tops derived from the exact
 * per-section heights, ZERO DOM reads. That matters because the
 * invalidators fire on every content commit and body resize — if the
 * rebuild read `offsetTop` per section, each scroll frame under churn
 * would force a full-stack synchronous layout (seconds on a tall,
 * un-contained stack: the historic scroll freeze). Only when the model
 * is unavailable (no probe yet, an unmeasurable section) does the
 * rebuild fall back to one DOM pass over the sections' offsetTops.
 *
 * Scroll-spy: a passive, rAF-throttled scroll listener finds the
 * section spanning `scrollTop + stickyOffset + 1px`. Hysteresis: the
 * active key only changes once the probe is HYSTERESIS_PX past the
 * boundary (down: into the candidate; up: above the current section's
 * start), so it never flaps at a boundary. At the scroll floor the LAST
 * section is forced active (a short final section can never span the
 * probe). Writes are suppressed while
 * a tween flies and briefly after any programmatic jump, so an
 * optimistic click-set isn't immediately overridden by the glide's own
 * scroll events.
 *
 * Tween: a custom rAF tween easing scrollTop toward a target RE-READ
 * every frame — an SSE update shifting content mid-glide self-corrects,
 * no land-measure-correct loop. Never native `behavior: 'smooth'` (no
 * completion signal, no retargeting). Duration is distance-scaled and
 * clamped; jumps beyond LONG_JUMP_VIEWPORTS snap to within
 * SNAP_SHORT_VIEWPORTS of the target first, then ease the rest.
 * `prefers-reduced-motion` or `smooth: false` degrade to one instant
 * write. Any user wheel/touch/pointer/key input on the scroller
 * cancels the tween instantly — never fight the user — and stamps
 * lastUserScrollAt() (auto mode's manual-scroll deferral guard).
 */

import { getCurrentScope, onScopeDispose, ref, watch } from 'vue';
import type { Ref } from 'vue';
import { useMediaQuery } from './useMediaQuery';

/** One scrollable section of the stack, in document order. */
export interface StackSection {
  key: string;
  el: HTMLElement;
}

/**
 * The owner's exact height model: enough to derive every section's
 * scroller-relative top arithmetically (see the offset-cache doc above).
 */
export interface SectionHeightModel {
  /** Scroller-relative top of the FIRST section, px. */
  start: number;
  /** Vertical gap between adjacent sections, px. */
  gap: number;
  /**
   * Outer height (header + visible body) of the section with this key;
   * null = not computable for this section, which makes the whole
   * rebuild fall back to the DOM pass (a partial model would put every
   * later section at the wrong top).
   */
  heightFor(key: string): number | null;
}

export interface UseStackScrollOptions {
  /** The stack's sections in document order (offsetTops non-decreasing). */
  sections: () => StackSection[];
  /**
   * Exact height model for the arithmetic offset rebuild; return null
   * when unavailable (probe not measured yet). Optional — without it
   * every rebuild reads the DOM.
   */
  sectionHeights?: () => SectionHeightModel | null;
  /** Sticky chrome above the landing position, in px. Default 0. */
  stickyOffset?: number;
  /** Called whenever the active key changes (spy or programmatic). */
  onActiveKey?: (key: string) => void;
}

export interface ScrollToOptions {
  /** Default true; false (or prefers-reduced-motion) jumps instantly. */
  smooth?: boolean;
}

export interface StackScroll {
  /** The section the user is looking at (spy) or jumping to (optimistic). */
  activeKey: Ref<string | null>;
  /** Tween (or jump) to a section's top, minus the sticky offset. */
  scrollToKey(key: string, opts?: ScrollToOptions): void;
  /**
   * Tween (or jump) toward an arbitrary per-frame target (hunk
   * positions). getTop is re-read every frame; null cancels the tween
   * (target vanished). `activeKey` optimistically marks a section.
   */
  scrollToTarget(getTop: () => number | null, opts?: ScrollToOptions & { activeKey?: string }): void;
  /** True while the smooth tween is animating (anchor-sandwich handoff). */
  isTweening(): boolean;
  /** Drop the offset cache (content committed, load-expand, …). */
  invalidateOffsets(): void;
  /** Epoch ms of the user's last manual input on the scroller (0 = never). */
  lastUserScrollAt(): number;
}

/** Boundary dead zone: the probe must clear it before the spy switches. */
export const HYSTERESIS_PX = 8;

/** Spy suppression window after a programmatic jump lands. */
export const SPY_SUPPRESS_MS = 150;

/** Tween duration: clamp(min, distance-scaled, max). */
const TWEEN_MIN_MS = 200;
const TWEEN_MAX_MS = 450;
const TWEEN_MS_PER_PX = 0.6;

/** Jumps beyond this many viewports snap near the target first… */
const LONG_JUMP_VIEWPORTS = 3;
/** …to within this many viewports, then ease the rest. */
const SNAP_SHORT_VIEWPORTS = 1.5;

/** User inputs on the scroller that cancel a tween and stamp the guard. */
const USER_INPUT_EVENTS = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;

interface CachedOffset {
  key: string;
  top: number;
}

interface Tween {
  getTop: () => number | null;
  start: number;
  startTs: number | null;
  duration: number;
  raf: number;
}

/** Last index whose top is at or above the probe; 0 when all are below. */
function indexAt(offsets: CachedOffset[], probe: number): number {
  let lo = 0;
  let hi = offsets.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid].top <= probe) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found === -1 ? 0 : found;
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

export function useStackScroll(
  scroller: Ref<HTMLElement | null>,
  opts: UseStackScrollOptions
): StackScroll {
  const stickyOffset = opts.stickyOffset ?? 0;
  const activeKey = ref<string | null>(null);
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');

  let offsets: CachedOffset[] | null = null;
  let tween: Tween | null = null;
  let suppressUntil = 0;
  let lastUserScroll = 0;
  let spyRaf: number | null = null;

  function setActive(key: string): void {
    if (key === activeKey.value) return;
    activeKey.value = key;
    opts.onActiveKey?.(key);
  }

  function invalidateOffsets(): void {
    offsets = null;
  }

  /**
   * Arithmetic rebuild: cumulative tops from the owner's exact height
   * model — zero DOM reads, so it stays cheap no matter how often the
   * invalidators fire. Null when the model can't cover every section.
   */
  function buildModelOffsets(sections: StackSection[]): CachedOffset[] | null {
    const model = opts.sectionHeights?.() ?? null;
    if (model === null) return null;
    const out: CachedOffset[] = [];
    let top = model.start;
    for (const { key } of sections) {
      const height = model.heightFor(key);
      if (height === null) return null;
      out.push({ key, top });
      top += height + model.gap;
    }
    return out; // cumulative construction: already in top order
  }

  function ensureOffsets(): CachedOffset[] {
    if (offsets === null) {
      const sections = opts.sections();
      offsets = buildModelOffsets(sections);
      if (offsets === null) {
        // Model unavailable: ONE forced-layout pass over the DOM.
        offsets = sections.map(({ key, el }) => ({ key, top: el.offsetTop }));
        // Document order should already be top order; sorting is cheap
        // insurance against a transiently mid-patch DOM.
        offsets.sort((a, b) => a.top - b.top);
      }
    }
    return offsets;
  }

  // --- Scroll-spy ---

  function runSpy(): void {
    const el = scroller.value;
    if (!el) return;
    // Programmatic motion: the optimistic key must not be overridden by
    // the glide's own scroll events (or the landing's trailing events).
    if (tween !== null || Date.now() < suppressUntil) return;
    const cached = ensureOffsets();
    if (cached.length === 0) return;

    // Bottom clamp: pinned to (or within the dead zone of) the scroll
    // floor, the LAST section is active — a final section shorter than
    // the viewport could otherwise never span the probe. Skipped when
    // the content barely scrolls at all.
    const maxScroll = el.scrollHeight - el.clientHeight;
    if (maxScroll > HYSTERESIS_PX && el.scrollTop >= maxScroll - HYSTERESIS_PX) {
      setActive(cached[cached.length - 1].key);
      return;
    }

    const probe = el.scrollTop + stickyOffset + 1;
    const idx = indexAt(cached, probe);
    const current =
      activeKey.value === null ? -1 : cached.findIndex((o) => o.key === activeKey.value);
    if (current === -1) {
      setActive(cached[idx].key);
      return;
    }
    if (idx === current) return;
    // Hysteresis: only switch once the probe clears the boundary's dead
    // zone — down into the candidate, up past the current section's start.
    const clears =
      idx > current
        ? probe - cached[idx].top >= HYSTERESIS_PX
        : cached[current].top - probe >= HYSTERESIS_PX;
    if (clears) setActive(cached[idx].key);
  }

  function onScroll(): void {
    if (spyRaf !== null) return;
    spyRaf = requestAnimationFrame(() => {
      spyRaf = null;
      runSpy();
    });
  }

  // --- Tween ---

  function isTweening(): boolean {
    return tween !== null;
  }

  function cancelTween(): void {
    if (tween === null) return;
    cancelAnimationFrame(tween.raf);
    tween = null;
  }

  function step(ts: number): void {
    const t = tween;
    const el = scroller.value;
    if (t === null) return;
    if (el === null) {
      tween = null;
      return;
    }
    t.startTs ??= ts;
    const progress = Math.min(1, (ts - t.startTs) / t.duration);
    // Re-read the live target: content shifting above mid-glide (an SSE
    // burst the anchor sandwich deliberately does NOT compensate while
    // we fly) self-corrects here.
    const target = t.getTop();
    if (target === null) {
      tween = null; // target vanished — stop where we are
      return;
    }
    el.scrollTop = Math.max(0, t.start + (target - t.start) * easeOutCubic(progress));
    if (progress >= 1) {
      tween = null;
      suppressUntil = Date.now() + SPY_SUPPRESS_MS;
    } else {
      t.raf = requestAnimationFrame(step);
    }
  }

  function scrollToTarget(
    getTop: () => number | null,
    o?: ScrollToOptions & { activeKey?: string }
  ): void {
    const el = scroller.value;
    if (!el) return;
    // Optimistic: the jump's destination is the active section NOW; the
    // suppression window keeps the spy from flashing through the glide.
    if (o?.activeKey !== undefined) setActive(o.activeKey);
    const target = getTop();
    if (target === null) return;
    cancelTween();

    const from = el.scrollTop;
    const smooth = (o?.smooth ?? true) && !reducedMotion.value;
    if (!smooth || Math.abs(target - from) < 1) {
      el.scrollTo({ top: Math.max(0, target) });
      suppressUntil = Date.now() + SPY_SUPPRESS_MS;
      return;
    }

    // Long-jump snap: bound animation time (and c-v realization churn)
    // by starting the ease within SNAP_SHORT_VIEWPORTS of the target.
    let start = from;
    const viewport = el.clientHeight;
    if (viewport > 0 && Math.abs(target - from) > LONG_JUMP_VIEWPORTS * viewport) {
      start = target - Math.sign(target - from) * SNAP_SHORT_VIEWPORTS * viewport;
      el.scrollTo({ top: Math.max(0, start) });
      start = el.scrollTop;
    }
    const duration = Math.min(
      TWEEN_MAX_MS,
      Math.max(TWEEN_MIN_MS, Math.abs(target - start) * TWEEN_MS_PER_PX)
    );
    const t: Tween = { getTop, start, startTs: null, duration, raf: 0 };
    tween = t;
    t.raf = requestAnimationFrame(step);
  }

  function scrollToKey(key: string, o?: ScrollToOptions): void {
    scrollToTarget(
      () => {
        const section = opts.sections().find((s) => s.key === key);
        return section ? section.el.offsetTop - stickyOffset : null;
      },
      { ...o, activeKey: key }
    );
  }

  // --- User input: never fight the user ---

  function onUserInput(): void {
    lastUserScroll = Date.now();
    suppressUntil = 0;
    cancelTween();
  }

  // --- Binding ---

  const containerRo =
    typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => invalidateOffsets()) : null;

  let bound: HTMLElement | null = null;

  function bind(el: HTMLElement): void {
    bound = el;
    el.addEventListener('scroll', onScroll, { passive: true });
    for (const name of USER_INPUT_EVENTS) {
      el.addEventListener(name, onUserInput, { passive: true });
    }
    // instanceof guard: unit tests hand in a plain fake scroller.
    if (containerRo && el instanceof HTMLElement) containerRo.observe(el);
  }

  function unbind(): void {
    const el = bound;
    if (!el) return;
    bound = null;
    el.removeEventListener('scroll', onScroll);
    for (const name of USER_INPUT_EVENTS) {
      el.removeEventListener(name, onUserInput);
    }
    if (containerRo && el instanceof HTMLElement) containerRo.unobserve(el);
    cancelTween();
    invalidateOffsets();
  }

  watch(
    scroller,
    (el) => {
      unbind();
      if (el) bind(el);
    },
    { immediate: true }
  );

  if (typeof window !== 'undefined') {
    window.addEventListener('resize', invalidateOffsets);
  }

  // Only inside a component/effect scope (tests call this bare — then
  // listeners simply live for the window's lifetime, like useMediaQuery).
  if (getCurrentScope()) {
    onScopeDispose(() => {
      unbind();
      containerRo?.disconnect();
      if (spyRaf !== null) cancelAnimationFrame(spyRaf);
      window.removeEventListener('resize', invalidateOffsets);
    });
  }

  return {
    activeKey,
    scrollToKey,
    scrollToTarget,
    isTweening,
    invalidateOffsets,
    lastUserScrollAt: () => lastUserScroll,
  };
}
