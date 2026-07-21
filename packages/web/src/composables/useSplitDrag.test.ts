/**
 * useSplitDrag tests: the shared resizer logic, driven directly with a
 * fake orientation ref (no matchMedia involved) — axis selection
 * (column reads clientX/width, row reads clientY/height), clamping to
 * each axis' band, keyboard steps per orientation, prefs persistence
 * under the right key, and the no-column-axis landscape no-op.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { ref } from 'vue';
import { useSplitDrag } from './useSplitDrag';
import type { UseSplitDragOptions } from './useSplitDrag';
import { loadPrefs, PREFS_KEY, CHANGES_SPLIT_MIN, CHANGES_SPLIT_MAX, TOP_MIN, TOP_MAX } from '../prefs';

const COLUMN = {
  pref: 'changesSplit',
  defaultRatio: 0.32,
  min: CHANGES_SPLIT_MIN,
  max: CHANGES_SPLIT_MAX,
} as const;
const ROW = { pref: 'changesTop', defaultRatio: 0.3, min: TOP_MIN, max: TOP_MAX } as const;

/** A container whose rect is 800x400 at (0, 100). */
function makeContainer(): HTMLElement {
  const el = document.createElement('div');
  el.getBoundingClientRect = () =>
    ({ left: 0, top: 100, width: 800, height: 400 }) as DOMRect;
  return el;
}

function makeSplit(isRow: boolean, options: Partial<UseSplitDragOptions> = {}) {
  const isRowRef = ref(isRow);
  const container = ref<HTMLElement | null>(makeContainer());
  const split = useSplitDrag({ container, isRow: isRowRef, row: ROW, column: COLUMN, ...options });
  return { split, isRowRef, container };
}

/** A pointer event double — enough for the composable's handlers. */
function pointerEvent(coords: { clientX?: number; clientY?: number }): PointerEvent {
  return {
    button: 0,
    pointerId: 1,
    clientX: coords.clientX ?? 0,
    clientY: coords.clientY ?? 0,
    target: { setPointerCapture: () => {}, releasePointerCapture: () => {} },
    preventDefault: () => {},
  } as unknown as PointerEvent;
}

function keyEvent(key: string): KeyboardEvent {
  return { key, preventDefault: () => {} } as KeyboardEvent;
}

beforeEach(() => {
  localStorage.clear();
});

describe('column axis (landscape)', () => {
  test('drag reads clientX against the container width', () => {
    const { split } = makeSplit(false);
    split.onPointerDown(pointerEvent({ clientX: 256 }));
    split.onPointerMove(pointerEvent({ clientX: 400 }));
    expect(split.columnRatio.value).toBeCloseTo(0.5); // 400 / 800
    split.onPointerUp(pointerEvent({ clientX: 400 }));
    expect(loadPrefs().changesSplit).toBeCloseTo(0.5);
    expect(loadPrefs().changesTop).toBeNull(); // row axis untouched
  });

  test('drag clamps to the column band', () => {
    const { split } = makeSplit(false);
    split.onPointerDown(pointerEvent({ clientX: 0 }));
    split.onPointerMove(pointerEvent({ clientX: 790 }));
    expect(split.columnRatio.value).toBe(CHANGES_SPLIT_MAX);
    split.onPointerMove(pointerEvent({ clientX: 10 }));
    expect(split.columnRatio.value).toBe(CHANGES_SPLIT_MIN);
  });

  test('ArrowRight/ArrowLeft step and persist; Up/Down are ignored', () => {
    const { split } = makeSplit(false);
    split.onKeydown(keyEvent('ArrowRight'));
    expect(split.columnRatio.value).toBeCloseTo(0.34);
    expect(loadPrefs().changesSplit).toBeCloseTo(0.34);
    split.onKeydown(keyEvent('ArrowDown'));
    expect(split.columnRatio.value).toBeCloseTo(0.34); // row key: no-op
    expect(split.rowRatio.value).toBeCloseTo(0.3);
  });

  test('aria reflects the vertical separator and column band', () => {
    const { split } = makeSplit(false);
    expect(split.ariaOrientation.value).toBe('vertical');
    expect(split.ariaValueNow.value).toBe(32);
    expect(split.ariaValueMin.value).toBe(15);
    expect(split.ariaValueMax.value).toBe(65);
  });
});

describe('row axis (portrait)', () => {
  test('drag reads clientY against the container height', () => {
    const { split } = makeSplit(true);
    split.onPointerDown(pointerEvent({ clientY: 220 }));
    split.onPointerMove(pointerEvent({ clientY: 300 }));
    expect(split.rowRatio.value).toBeCloseTo(0.5); // (300 - 100) / 400
    split.onPointerUp(pointerEvent({ clientY: 300 }));
    expect(loadPrefs().changesTop).toBeCloseTo(0.5);
    expect(loadPrefs().changesSplit).toBeNull(); // column axis untouched
  });

  test('drag clamps to the row band', () => {
    const { split } = makeSplit(true);
    split.onPointerDown(pointerEvent({ clientY: 200 }));
    split.onPointerMove(pointerEvent({ clientY: 500 })); // fraction 1.0
    expect(split.rowRatio.value).toBe(TOP_MAX);
    split.onPointerMove(pointerEvent({ clientY: 100 })); // fraction 0.0
    expect(split.rowRatio.value).toBe(TOP_MIN);
  });

  test('ArrowDown/ArrowUp step and persist; Left/Right are ignored', () => {
    const { split } = makeSplit(true);
    split.onKeydown(keyEvent('ArrowDown'));
    expect(split.rowRatio.value).toBeCloseTo(0.32);
    expect(loadPrefs().changesTop).toBeCloseTo(0.32);
    split.onKeydown(keyEvent('ArrowLeft'));
    expect(split.rowRatio.value).toBeCloseTo(0.32); // column key: no-op
    expect(split.columnRatio.value).toBeCloseTo(0.32); // untouched default
  });

  test('keyboard clamps at the band edges', () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ changesTop: 0.59 }));
    const { split } = makeSplit(true);
    split.onKeydown(keyEvent('ArrowDown'));
    split.onKeydown(keyEvent('ArrowDown'));
    expect(split.rowRatio.value).toBe(TOP_MAX);
    expect(loadPrefs().changesTop).toBe(TOP_MAX);
  });

  test('aria reflects the horizontal separator and row band', () => {
    const { split } = makeSplit(true);
    expect(split.ariaOrientation.value).toBe('horizontal');
    expect(split.ariaValueNow.value).toBe(30);
    expect(split.ariaValueMin.value).toBe(10);
    expect(split.ariaValueMax.value).toBe(60);
  });
});

describe('axis switching and initialization', () => {
  test('flipping the orientation ref mid-life switches the drag axis', () => {
    const { split, isRowRef } = makeSplit(false);
    split.onPointerDown(pointerEvent({ clientX: 100 }));
    split.onPointerMove(pointerEvent({ clientX: 400 }));
    expect(split.columnRatio.value).toBeCloseTo(0.5);
    split.onPointerUp(pointerEvent({}));

    isRowRef.value = true;
    split.onPointerDown(pointerEvent({ clientY: 200 }));
    split.onPointerMove(pointerEvent({ clientY: 180 }));
    expect(split.rowRatio.value).toBeCloseTo(0.2); // (180 - 100) / 400
    expect(split.columnRatio.value).toBeCloseTo(0.5); // column keeps its value
  });

  test('stored prefs seed the initial ratios', () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ changesSplit: 0.4, changesTop: 0.5 }));
    const { split } = makeSplit(false);
    expect(split.columnRatio.value).toBe(0.4);
    expect(split.rowRatio.value).toBe(0.5);
  });

  test('without a column axis, landscape input is a no-op', () => {
    const isRowRef = ref(false);
    const container = ref<HTMLElement | null>(makeContainer());
    const split = useSplitDrag({ container, isRow: isRowRef, row: ROW });
    split.onPointerDown(pointerEvent({ clientX: 100 }));
    split.onPointerMove(pointerEvent({ clientX: 400 }));
    split.onKeydown(keyEvent('ArrowRight'));
    expect(split.rowRatio.value).toBeCloseTo(0.3);
    expect(localStorage.getItem(PREFS_KEY)).toBeNull();

    // Portrait works as usual.
    isRowRef.value = true;
    split.onKeydown(keyEvent('ArrowDown'));
    expect(split.rowRatio.value).toBeCloseTo(0.32);
    expect(loadPrefs().changesTop).toBeCloseTo(0.32);
  });
});
