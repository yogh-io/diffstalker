/**
 * useStackScroll tests: pure scroll-engine MATH against a fake scroller
 * and fake section geometry — no mounting, no real layout, rAF driven
 * by hand. Covered: the binary-search scroll-spy (probe at scrollTop +
 * stickyOffset + 1, boundary hysteresis in both directions, suppression
 * while tweening and inside the post-jump window), the offset cache
 * (stale until invalidated), and the tween (optimistic active set,
 * eased frames, PER-FRAME retargeting when content shifts mid-glide,
 * distance-clamped duration, long-jump snap, reduced-motion and
 * smooth:false degrades, user-input cancellation + lastUserScrollAt).
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { ref } from 'vue';
import { useStackScroll, HYSTERESIS_PX, SPY_SUPPRESS_MS } from './useStackScroll';
import type { StackScroll, StackSection } from './useStackScroll';
import { stubMatchMedia } from '../testing/portrait';

// --- Fakes ---

interface FakeSectionEl {
  offsetTop: number;
}

interface FakeScroller {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
  scrollTo(o: { top: number }): void;
  addEventListener(name: string, fn: () => void): void;
  removeEventListener(name: string, fn: () => void): void;
  dispatch(name: string): void;
}

function makeScroller(): FakeScroller {
  const listeners = new Map<string, (() => void)[]>();
  const scroller: FakeScroller = {
    scrollTop: 0,
    clientHeight: 400,
    // Tall enough that the bottom clamp never fires unless a test
    // shrinks it on purpose.
    scrollHeight: 10000,
    scrollTo(o) {
      scroller.scrollTop = Math.max(0, o.top);
    },
    addEventListener(name, fn) {
      listeners.set(name, [...(listeners.get(name) ?? []), fn]);
    },
    removeEventListener(name, fn) {
      listeners.set(
        name,
        (listeners.get(name) ?? []).filter((l) => l !== fn)
      );
    },
    dispatch(name) {
      for (const fn of listeners.get(name) ?? []) fn();
    },
  };
  return scroller;
}

// Hand-driven rAF: callbacks queue until runFrame(ts) flushes them.
const rafCallbacks = new Map<number, FrameRequestCallback>();
let nextRafId = 1;

function runFrame(ts: number): void {
  const pending = [...rafCallbacks.values()];
  rafCallbacks.clear();
  for (const cb of pending) cb(ts);
}

/** The standard stack: A at 0, B at 1000, C at 2500. */
interface World {
  scroller: FakeScroller;
  els: Record<'A' | 'B' | 'C', FakeSectionEl>;
  scroll: StackScroll;
  activations: string[];
}

function makeWorld(stickyOffset = 0): World {
  const scroller = makeScroller();
  const els = { A: { offsetTop: 0 }, B: { offsetTop: 1000 }, C: { offsetTop: 2500 } };
  const activations: string[] = [];
  const sections = (): StackSection[] =>
    (['A', 'B', 'C'] as const).map((key) => ({
      key,
      el: els[key] as unknown as HTMLElement,
    }));
  const scroll = useStackScroll(ref(scroller as unknown as HTMLElement), {
    sections,
    stickyOffset,
    onActiveKey: (key) => activations.push(key),
  });
  return { scroller, els, scroll, activations };
}

/** Scroll to a position and run the spy's throttling frame. */
function spyAt(world: World, scrollTop: number): void {
  world.scroller.scrollTop = scrollTop;
  world.scroller.dispatch('scroll');
  runFrame(performance.now());
}

beforeEach(() => {
  vi.useFakeTimers();
  rafCallbacks.clear();
  nextRafId = 1;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    const id = nextRafId++;
    rafCallbacks.set(id, cb);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    rafCallbacks.delete(id);
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('scroll-spy', () => {
  test('binary-searches the section spanning scrollTop + 1px', () => {
    const world = makeWorld();
    spyAt(world, 1200);
    expect(world.scroll.activeKey.value).toBe('B');
    spyAt(world, 2600);
    expect(world.scroll.activeKey.value).toBe('C');
    spyAt(world, 0);
    expect(world.scroll.activeKey.value).toBe('A');
  });

  test('honors the sticky offset in the probe', () => {
    const world = makeWorld(40);
    // scrollTop 970: probe = 970 + 40 + 1 = 1011 -> already inside B.
    spyAt(world, 970);
    expect(world.scroll.activeKey.value).toBe('B');
  });

  test('scrolled above the first section, the first section anchors', () => {
    const world = makeWorld();
    world.els.A.offsetTop = 100; // nothing spans probe 1
    spyAt(world, 0);
    expect(world.scroll.activeKey.value).toBe('A');
  });

  test('hysteresis: a boundary cross inside the dead zone does not flap', () => {
    const world = makeWorld();
    spyAt(world, 1200);
    expect(world.scroll.activeKey.value).toBe('B');

    // Up across B's start, but within the dead zone: stays B.
    spyAt(world, 1000 - HYSTERESIS_PX);
    expect(world.scroll.activeKey.value).toBe('B');
    // Clear of the zone: switches to A.
    spyAt(world, 1000 - HYSTERESIS_PX - 2);
    expect(world.scroll.activeKey.value).toBe('A');

    // Down into B, but within the zone: stays A.
    spyAt(world, 1000 + HYSTERESIS_PX - 2);
    expect(world.scroll.activeKey.value).toBe('A');
    // Clear of the zone: switches to B.
    spyAt(world, 1000 + HYSTERESIS_PX);
    expect(world.scroll.activeKey.value).toBe('B');
  });

  test('spy writes are suppressed right after a programmatic jump', () => {
    const world = makeWorld();
    world.scroll.scrollToKey('C', { smooth: false });
    expect(world.scroll.activeKey.value).toBe('C');

    // A scroll event inside the suppression window (e.g. the jump's own
    // trailing event) must not override the optimistic key.
    spyAt(world, 0);
    expect(world.scroll.activeKey.value).toBe('C');

    // Past the window the spy resumes.
    vi.advanceTimersByTime(SPY_SUPPRESS_MS + 10);
    spyAt(world, 0);
    expect(world.scroll.activeKey.value).toBe('A');
  });

  test('spy writes are suppressed while the tween flies', () => {
    const world = makeWorld();
    spyAt(world, 0);
    expect(world.scroll.activeKey.value).toBe('A');

    world.scroll.scrollToKey('C'); // smooth: tween in flight
    expect(world.scroll.isTweening()).toBe(true);
    spyAt(world, 1200); // mid-glide event pointing at B
    expect(world.scroll.activeKey.value).toBe('C'); // optimistic key holds
  });

  test('bottom clamp: pinned to the scroll floor, the LAST section is active', () => {
    const world = makeWorld();
    // C spans 2500-2700: shorter than the 400px viewport, so the probe
    // (maxScroll 2300 + 1) can never reach C's start without the clamp.
    world.scroller.scrollHeight = 2700;
    spyAt(world, 2295); // within the dead zone of the 2300 floor
    expect(world.scroll.activeKey.value).toBe('C');

    // Back above the dead zone the normal spy takes over again.
    spyAt(world, 2200);
    expect(world.scroll.activeKey.value).toBe('B');
  });

  test('an unscrollable stack never bottom-clamps to the last section', () => {
    const world = makeWorld();
    world.scroller.scrollHeight = 400; // content fits: maxScroll 0
    spyAt(world, 0);
    expect(world.scroll.activeKey.value).toBe('A');
  });

  test('the offset cache is stale until invalidateOffsets', () => {
    const world = makeWorld();
    spyAt(world, 100);
    expect(world.scroll.activeKey.value).toBe('A');

    // B moved up to 200 — cache still says 1000, so 500 reads as A.
    world.els.B.offsetTop = 200;
    spyAt(world, 500);
    expect(world.scroll.activeKey.value).toBe('A');

    world.scroll.invalidateOffsets();
    spyAt(world, 500);
    expect(world.scroll.activeKey.value).toBe('B');
  });
});

describe('scrollToKey', () => {
  test('sets the active key optimistically and reports it', () => {
    const world = makeWorld();
    world.scroll.scrollToKey('B', { smooth: false });
    expect(world.scroll.activeKey.value).toBe('B');
    expect(world.activations).toEqual(['B']);
  });

  test('smooth:false jumps instantly to offsetTop minus the sticky offset', () => {
    const world = makeWorld(40);
    world.scroll.scrollToKey('B', { smooth: false });
    expect(world.scroller.scrollTop).toBe(960);
    expect(world.scroll.isTweening()).toBe(false);
  });

  test('prefers-reduced-motion degrades a smooth jump to an instant one', () => {
    stubMatchMedia(true); // every query matches, incl. reduced motion
    const world = makeWorld();
    world.scroll.scrollToKey('B');
    expect(world.scroller.scrollTop).toBe(1000);
    expect(world.scroll.isTweening()).toBe(false);
  });

  test('an unknown key scrolls nowhere and keeps the previous position', () => {
    const world = makeWorld();
    world.scroller.scrollTop = 123;
    world.scroll.scrollToKey('missing');
    expect(world.scroller.scrollTop).toBe(123);
    expect(world.scroll.isTweening()).toBe(false);
  });
});

describe('tween', () => {
  test('eases toward the target and lands exactly on it', () => {
    const world = makeWorld();
    world.scroll.scrollToKey('B'); // distance 1000 -> duration clamps to 450
    expect(world.scroll.isTweening()).toBe(true);

    runFrame(0); // first frame stamps startTs; eased(0) = start
    expect(world.scroller.scrollTop).toBe(0);

    runFrame(225); // t = 0.5, easeOutCubic = 0.875
    expect(world.scroller.scrollTop).toBeCloseTo(875, 5);

    runFrame(450);
    expect(world.scroller.scrollTop).toBe(1000);
    expect(world.scroll.isTweening()).toBe(false);
  });

  test('RE-READS the live target every frame: a mid-glide shift self-corrects', () => {
    const world = makeWorld();
    world.scroll.scrollToKey('B');
    runFrame(0);

    // Content above grows mid-glide: B moves from 1000 to 1400.
    world.els.B.offsetTop = 1400;
    runFrame(225); // t = 0.5 -> 0.875 of the NEW distance
    expect(world.scroller.scrollTop).toBeCloseTo(1225, 5);

    runFrame(450);
    expect(world.scroller.scrollTop).toBe(1400); // lands on the LIVE target
    expect(world.scroll.isTweening()).toBe(false);
  });

  test('a vanished target cancels the tween where it is', () => {
    const world = makeWorld();
    let alive = true;
    world.scroll.scrollToTarget(() => (alive ? 1000 : null), { smooth: true });
    runFrame(0);
    runFrame(225);
    const mid = world.scroller.scrollTop;
    alive = false;
    runFrame(300);
    expect(world.scroller.scrollTop).toBe(mid);
    expect(world.scroll.isTweening()).toBe(false);
  });

  test('duration scales with distance inside the clamp band', () => {
    const world = makeWorld();
    // Distance 500 -> 500 * 0.6 = 300ms (between the 200/450 clamps).
    world.els.B.offsetTop = 500;
    world.scroll.scrollToKey('B');
    runFrame(0);
    runFrame(299);
    expect(world.scroller.scrollTop).toBeLessThan(500);
    runFrame(300);
    expect(world.scroller.scrollTop).toBe(500);
    expect(world.scroll.isTweening()).toBe(false);
  });

  test('long jumps snap to 1.5 viewports short, then ease the rest', () => {
    const world = makeWorld();
    // Distance 2500 > 3 * 400: snap to 2500 - 1.5 * 400 = 1900 first.
    world.scroll.scrollToKey('C');
    expect(world.scroller.scrollTop).toBe(1900);
    expect(world.scroll.isTweening()).toBe(true);

    // Remaining 600px -> duration 360ms.
    runFrame(0);
    runFrame(360);
    expect(world.scroller.scrollTop).toBe(2500);
    expect(world.scroll.isTweening()).toBe(false);
  });

  test('user wheel input cancels the tween and stamps lastUserScrollAt', () => {
    const world = makeWorld();
    expect(world.scroll.lastUserScrollAt()).toBe(0);

    world.scroll.scrollToKey('C');
    runFrame(0);
    runFrame(100);
    const mid = world.scroller.scrollTop;

    world.scroller.dispatch('wheel');
    expect(world.scroll.isTweening()).toBe(false);
    expect(world.scroll.lastUserScrollAt()).toBe(Date.now());

    // No further frames move the scroller.
    runFrame(450);
    expect(world.scroller.scrollTop).toBe(mid);
  });

  test('user input also lifts the post-jump spy suppression', () => {
    const world = makeWorld();
    world.scroll.scrollToKey('C', { smooth: false }); // suppression armed
    world.scroller.dispatch('keydown'); // user takes over
    spyAt(world, 1200);
    expect(world.scroll.activeKey.value).toBe('B'); // spy runs immediately
  });

  test('a second scrollToKey retargets: the first tween is cancelled', () => {
    const world = makeWorld();
    world.scroll.scrollToKey('C');
    runFrame(0);
    world.scroll.scrollToKey('B');
    expect(world.scroll.activeKey.value).toBe('B');

    runFrame(1000); // only the second tween's frames remain
    runFrame(2000);
    expect(world.scroller.scrollTop).toBe(1000);
    expect(world.scroll.isTweening()).toBe(false);
  });
});
