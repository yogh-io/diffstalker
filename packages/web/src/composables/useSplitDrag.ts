/**
 * useSplitDrag: the shared pointer-drag + keyboard logic behind every
 * pane resizer (extracted from ChangesView's original column resizer).
 *
 * One instance drives ONE separator element whose axis follows the
 * orientation: in portrait it drags a ROW split (fraction of the
 * container height, `clientY` against `rect.top/height`), in landscape
 * a COLUMN split (fraction of the width, `clientX` against
 * `rect.left/width`). Each axis keeps its own fraction, clamp band, and
 * prefs field; the fraction persists on drag end and on every keyboard
 * step. Views without a landscape resizer (History, Compare, Explorer)
 * pass no `column` axis and render their separator in portrait only —
 * with no column axis a landscape event is a no-op.
 */

import { computed, ref } from 'vue';
import type { ComputedRef, Ref } from 'vue';
import { loadPrefs, savePrefs } from '../prefs';
import type { SplitPrefKey } from '../prefs';

const KEYBOARD_STEP = 0.02;

export interface SplitAxis {
  /** The prefs field this axis' fraction persists under. */
  pref: SplitPrefKey;
  /** Fraction used when nothing (valid) is stored. */
  defaultRatio: number;
  min: number;
  max: number;
}

export interface UseSplitDragOptions {
  /** The grid container the fraction is measured against. */
  container: Ref<HTMLElement | null>;
  /** true → drag rows (portrait); false → drag columns (landscape). */
  isRow: Ref<boolean>;
  /** Portrait row axis (top-band height fraction). */
  row: SplitAxis;
  /** Landscape column axis; omit when the view has no landscape resizer. */
  column?: SplitAxis;
}

export interface SplitDrag {
  columnRatio: Ref<number>;
  rowRatio: Ref<number>;
  /** ARIA for the separator, per the ACTIVE axis. A separator that
   *  splits rows is horizontal; one that splits columns is vertical. */
  ariaOrientation: ComputedRef<'horizontal' | 'vertical'>;
  ariaValueNow: ComputedRef<number>;
  ariaValueMin: ComputedRef<number>;
  ariaValueMax: ComputedRef<number>;
  onPointerDown(event: PointerEvent): void;
  onPointerMove(event: PointerEvent): void;
  onPointerUp(event: PointerEvent): void;
  onPointerCancel(): void;
  onKeydown(event: KeyboardEvent): void;
}

function clamp(axis: SplitAxis, ratio: number): number {
  return Math.min(axis.max, Math.max(axis.min, ratio));
}

export function useSplitDrag(options: UseSplitDragOptions): SplitDrag {
  const { container, isRow, row, column } = options;

  const stored = loadPrefs();
  const rowRatio = ref(stored[row.pref] ?? row.defaultRatio);
  const columnRatio = ref(column ? (stored[column.pref] ?? column.defaultRatio) : 0);

  let dragging = false;

  /** The axis the separator currently drags; null in landscape when the
   *  view has no column resizer (its separator only renders in portrait). */
  function activeAxis(): SplitAxis | null {
    return isRow.value ? row : (column ?? null);
  }

  function activeRatio(): Ref<number> {
    return isRow.value ? rowRatio : columnRatio;
  }

  const ariaOrientation = computed<'horizontal' | 'vertical'>(() =>
    isRow.value ? 'horizontal' : 'vertical'
  );
  const ariaValueNow = computed(() =>
    Math.round((isRow.value ? rowRatio.value : columnRatio.value) * 100)
  );
  const ariaValueMin = computed(() => {
    const axis = isRow.value ? row : (column ?? row);
    return Math.round(axis.min * 100);
  });
  const ariaValueMax = computed(() => {
    const axis = isRow.value ? row : (column ?? row);
    return Math.round(axis.max * 100);
  });

  function persist(axis: SplitAxis, ratio: number): void {
    savePrefs({ [axis.pref]: ratio });
  }

  function onPointerDown(event: PointerEvent): void {
    if (event.button !== 0) return; // primary button only — no right-click drags
    if (activeAxis() === null) return;
    dragging = true;
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: PointerEvent): void {
    const axis = activeAxis();
    if (!dragging || !axis || !container.value) return;
    const rect = container.value.getBoundingClientRect();
    const size = isRow.value ? rect.height : rect.width;
    if (size <= 0) return;
    const offset = isRow.value ? event.clientY - rect.top : event.clientX - rect.left;
    activeRatio().value = clamp(axis, offset / size);
  }

  function endDrag(): void {
    if (!dragging) return;
    dragging = false;
    const axis = activeAxis();
    if (axis) persist(axis, activeRatio().value);
  }

  function onPointerUp(event: PointerEvent): void {
    if (!dragging) return;
    (event.target as HTMLElement).releasePointerCapture(event.pointerId);
    endDrag();
  }

  /** Touch cancel / context menu: end the drag so hover can't keep resizing. */
  function onPointerCancel(): void {
    endDrag();
  }

  function onKeydown(event: KeyboardEvent): void {
    const axis = activeAxis();
    if (!axis) return;
    let delta: number;
    if (isRow.value) {
      if (event.key === 'ArrowUp') delta = -KEYBOARD_STEP;
      else if (event.key === 'ArrowDown') delta = KEYBOARD_STEP;
      else return;
    } else {
      if (event.key === 'ArrowLeft') delta = -KEYBOARD_STEP;
      else if (event.key === 'ArrowRight') delta = KEYBOARD_STEP;
      else return;
    }
    event.preventDefault();
    const ratio = activeRatio();
    ratio.value = clamp(axis, ratio.value + delta);
    persist(axis, ratio.value);
  }

  return {
    columnRatio,
    rowRatio,
    ariaOrientation,
    ariaValueNow,
    ariaValueMin,
    ariaValueMax,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    onKeydown,
  };
}
