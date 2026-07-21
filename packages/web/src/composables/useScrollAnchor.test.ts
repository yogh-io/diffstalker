/**
 * useScrollAnchor tests: pure anchor MATH against mocked scroller and
 * element rects — no mounting, no real layout. Covered: the anchor
 * selection picks the topmost survivor at the viewport top; the
 * fallback ladder degrades rung by rung when the anchor key is removed
 * (nearest surviving hunk above → the primary's file section → nearest
 * surviving file by offsetTop → nothing); restore applies exactly
 * newTop − oldTop to scrollTop (both signs); commits that only change
 * sections below the viewport are skipped entirely; and an in-flight
 * tween suppresses the scrollTop write (restore still reports the
 * delta, nudge stays silent).
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { ref } from 'vue';
import { useScrollAnchor } from './useScrollAnchor';
import type { AnchorCandidate, ScrollAnchor } from './useScrollAnchor';

/** A fake element with a mutable viewport top and a fixed offsetTop. */
interface FakeEl {
  top: number;
  height: number;
  offsetTop: number;
  getBoundingClientRect(): { top: number; bottom: number; height: number };
}

function makeEl(top: number, height: number, offsetTop: number): FakeEl {
  const el: FakeEl = {
    top,
    height,
    offsetTop,
    getBoundingClientRect() {
      return { top: el.top, bottom: el.top + el.height, height: el.height };
    },
  };
  return el;
}

function asEl(el: FakeEl): HTMLElement {
  return el as unknown as HTMLElement;
}

/** A fake scroller: viewport top 0, 400px tall, scrolled to 1000. */
interface FakeScroller {
  scrollTop: number;
  clientHeight: number;
  getBoundingClientRect(): { top: number };
}

function makeScroller(): FakeScroller {
  return { scrollTop: 1000, clientHeight: 400, getBoundingClientRect: () => ({ top: 0 }) };
}

/**
 * The standard stack: file A far above with three hunks (the third
 * spans the viewport top), file B below the fold. Viewport is 0..400.
 */
interface World {
  scroller: FakeScroller;
  els: Record<string, FakeEl>;
  candidates: AnchorCandidate[];
  anchor: ScrollAnchor;
  tweenActive: boolean;
}

function makeWorld(): World {
  const els = {
    fileA: makeEl(-620, 700, 0),
    hunkA1: makeEl(-600, 300, 20),
    hunkA2: makeEl(-300, 280, 320),
    hunkA3: makeEl(-20, 260, 600), // spans the viewport top
    fileB: makeEl(700, 500, 1320),
    hunkB1: makeEl(720, 400, 1340),
    fileC: makeEl(1300, 300, 5000),
  };
  const candidates: AnchorCandidate[] = [
    { key: 'fileA', kind: 'file', fileKey: 'fileA', el: asEl(els.fileA) },
    { key: 'hunkA1', kind: 'hunk', fileKey: 'fileA', el: asEl(els.hunkA1) },
    { key: 'hunkA2', kind: 'hunk', fileKey: 'fileA', el: asEl(els.hunkA2) },
    { key: 'hunkA3', kind: 'hunk', fileKey: 'fileA', el: asEl(els.hunkA3) },
    { key: 'fileB', kind: 'file', fileKey: 'fileB', el: asEl(els.fileB) },
    { key: 'hunkB1', kind: 'hunk', fileKey: 'fileB', el: asEl(els.hunkB1) },
    { key: 'fileC', kind: 'file', fileKey: 'fileC', el: asEl(els.fileC) },
  ];
  const scroller = makeScroller();
  const world: World = { scroller, els, candidates, tweenActive: false, anchor: null! };
  world.anchor = useScrollAnchor(ref(scroller as unknown as HTMLElement), {
    candidates: () => world.candidates,
    resolve: (key) => {
      const el = world.els[key as keyof typeof world.els];
      return el ? asEl(el) : null;
    },
    isTweenActive: () => world.tweenActive,
  });
  return world;
}

function allKeys(world: World): Set<string> {
  return new Set(world.candidates.map((c) => c.key));
}

/** A commit with one unmeasurable change: never below-viewport-skipped. */
function someChange(): { survivingKeys: Set<string>; changedEls: (HTMLElement | null)[] } {
  return { survivingKeys: new Set(), changedEls: [null] };
}

let world: World;

beforeEach(() => {
  world = makeWorld();
});

describe('anchor selection', () => {
  test('picks the topmost candidate at the viewport top when its key survives', () => {
    world.anchor.prepare({ survivingKeys: allKeys(world), changedEls: [null] });
    // Everything above hunkA3 grows by 50: only hunkA3's re-measured
    // position feeds the delta.
    world.els.hunkA3.top += 50;
    world.els.hunkA2.top += 999; // decoys: must not be consulted
    world.els.fileA.top += 999;
    expect(world.anchor.restore()).toBe(50);
    expect(world.scroller.scrollTop).toBe(1050);
  });

  test('scrolled to the very top, the first candidate anchors', () => {
    // Shift the whole stack below the viewport top (scrollTop 0 case).
    for (const el of Object.values(world.els)) el.top += 700;
    world.anchor.prepare({ survivingKeys: allKeys(world), changedEls: [null] });
    world.els.fileA.top += 30;
    expect(world.anchor.restore()).toBe(30);
    expect(world.scroller.scrollTop).toBe(1030);
  });

  test('applies negative deltas when content above shrinks', () => {
    world.anchor.prepare({ survivingKeys: allKeys(world), changedEls: [null] });
    world.els.hunkA3.top -= 70;
    expect(world.anchor.restore()).toBe(-70);
    expect(world.scroller.scrollTop).toBe(930);
  });

  test('a no-shift commit writes nothing', () => {
    world.anchor.prepare({ survivingKeys: allKeys(world), changedEls: [null] });
    expect(world.anchor.restore()).toBe(0);
    expect(world.scroller.scrollTop).toBe(1000);
  });
});

describe('fallback ladder', () => {
  test('anchor key removed: falls back to the nearest surviving hunk above', () => {
    const surviving = allKeys(world);
    surviving.delete('hunkA3');
    world.anchor.prepare({ survivingKeys: surviving, changedEls: [null] });
    world.els.hunkA2.top += 40;
    world.els.hunkA3.top += 999; // removed — must not be consulted
    expect(world.anchor.restore()).toBe(40);
    expect(world.scroller.scrollTop).toBe(1040);
  });

  test('no surviving hunk above: falls back to the primary’s file section', () => {
    const surviving = allKeys(world);
    surviving.delete('hunkA3');
    surviving.delete('hunkA2');
    surviving.delete('hunkA1');
    world.anchor.prepare({ survivingKeys: surviving, changedEls: [null] });
    world.els.fileA.top -= 25;
    expect(world.anchor.restore()).toBe(-25);
    expect(world.scroller.scrollTop).toBe(975);
  });

  test('whole file removed: falls back to the nearest surviving file by offsetTop', () => {
    const surviving = new Set(['fileB', 'hunkB1', 'fileC']);
    world.anchor.prepare({ survivingKeys: surviving, changedEls: [null] });
    // Nearest to the primary (hunkA3, offsetTop 600) is fileB (1320),
    // not fileC (5000).
    world.els.fileB.top -= 120;
    world.els.fileC.top += 999;
    expect(world.anchor.restore()).toBe(-120);
    expect(world.scroller.scrollTop).toBe(880);
  });

  test('nothing survives: no anchor, no write', () => {
    world.anchor.prepare(someChange());
    world.els.hunkA3.top += 50;
    expect(world.anchor.restore()).toBe(0);
    expect(world.scroller.scrollTop).toBe(1000);
  });

  test('anchor unresolvable after the patch: bails without writing', () => {
    world.anchor.prepare({ survivingKeys: allKeys(world), changedEls: [null] });
    delete (world.els as Record<string, FakeEl>).hunkA3; // resolve() → null
    expect(world.anchor.restore()).toBe(0);
    expect(world.scroller.scrollTop).toBe(1000);
  });
});

describe('below-viewport skip', () => {
  test('changes entirely below the viewport are skipped', () => {
    // fileB starts at 700; the viewport ends at 400.
    world.anchor.prepare({
      survivingKeys: allKeys(world),
      changedEls: [asEl(world.els.fileB)],
    });
    world.els.hunkA3.top += 50; // would be a 50px delta if not skipped
    expect(world.anchor.restore()).toBe(0);
    expect(world.scroller.scrollTop).toBe(1000);
  });

  test('an empty change set is skipped (nothing to compensate)', () => {
    world.anchor.prepare({ survivingKeys: allKeys(world), changedEls: [] });
    world.els.hunkA3.top += 50;
    expect(world.anchor.restore()).toBe(0);
    expect(world.scroller.scrollTop).toBe(1000);
  });

  test('an unmeasurable (entering) change disables the skip', () => {
    world.anchor.prepare({
      survivingKeys: allKeys(world),
      changedEls: [asEl(world.els.fileB), null],
    });
    world.els.hunkA3.top += 50;
    expect(world.anchor.restore()).toBe(50);
    expect(world.scroller.scrollTop).toBe(1050);
  });

  test('a change intersecting the viewport compensates', () => {
    // fileA spans the viewport top — its rect top is above viewBottom.
    world.anchor.prepare({
      survivingKeys: allKeys(world),
      changedEls: [asEl(world.els.fileA)],
    });
    world.els.hunkA3.top += 15;
    expect(world.anchor.restore()).toBe(15);
    expect(world.scroller.scrollTop).toBe(1015);
  });
});

describe('tween handoff', () => {
  test('restore reports the delta but never writes while a tween is in flight', () => {
    world.anchor.prepare({ survivingKeys: allKeys(world), changedEls: [null] });
    world.els.hunkA3.top += 50;
    world.tweenActive = true;
    expect(world.anchor.restore()).toBe(50);
    expect(world.scroller.scrollTop).toBe(1000); // the tween absorbs it
  });

  test('nudge applies when idle and is suppressed mid-tween', () => {
    world.anchor.nudge(12);
    expect(world.scroller.scrollTop).toBe(1012);
    world.tweenActive = true;
    world.anchor.nudge(12);
    expect(world.scroller.scrollTop).toBe(1012);
  });
});

describe('lifecycle', () => {
  test('restore without prepare is a no-op', () => {
    expect(world.anchor.restore()).toBe(0);
    expect(world.scroller.scrollTop).toBe(1000);
  });

  test('the pending anchor is consumed by restore', () => {
    world.anchor.prepare({ survivingKeys: allKeys(world), changedEls: [null] });
    world.els.hunkA3.top += 50;
    expect(world.anchor.restore()).toBe(50);
    world.els.hunkA3.top += 50;
    expect(world.anchor.restore()).toBe(0); // second restore: nothing pending
    expect(world.scroller.scrollTop).toBe(1050);
  });
});
