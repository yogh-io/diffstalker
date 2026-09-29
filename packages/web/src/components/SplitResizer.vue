<script setup lang="ts">
/**
 * SplitResizer: the draggable divider between a stacked top band and the
 * payload below it, in the portrait layout.
 *
 * Every split view renders this in portrait — the same eleven-attribute
 * separator markup and, verbatim, the same four style rules. Only the
 * aria-label differs.
 *
 * It paints BOTH of its own edges (inset top and bottom), which is why the
 * panels above and below draw none: with a panel border as well, the boundary
 * was three hairlines inside 9px.
 *
 * Scope, deliberately: this is the PORTRAIT divider only. ChangesView is the
 * one view with a landscape column drag as well, and keeps its own thin
 * `.resizer` for that axis (a different affordance: 5px, transparent until
 * hovered). Giving the other views a landscape drag would be a design
 * decision, not a consolidation.
 *
 * The height is --divider, not a spacing token. A drag target must GROW on
 * touch where a gap shrinks — the two are anti-correlated by input device, so
 * this must never be folded into the spacing scale. The views' portrait grids
 * size the divider row with the same token, so the row and the element can
 * never disagree.
 */

import type { SplitDrag } from '../composables/useSplitDrag';

defineProps<{
  /** The owning view's useSplitDrag instance — each view has its own. */
  split: SplitDrag;
  /** Accessible name, e.g. "Resize commit list". */
  label: string;
}>();
</script>

<template>
  <div
    class="row-resizer"
    role="separator"
    :aria-orientation="split.ariaOrientation.value"
    :aria-label="label"
    :aria-valuenow="split.ariaValueNow.value"
    :aria-valuemin="split.ariaValueMin.value"
    :aria-valuemax="split.ariaValueMax.value"
    tabindex="0"
    @pointerdown="split.onPointerDown"
    @pointermove="split.onPointerMove"
    @pointerup="split.onPointerUp"
    @pointercancel="split.onPointerCancel"
    @keydown="split.onKeydown"
  ></div>
</template>

<style scoped>
.row-resizer {
  height: var(--divider);
  cursor: row-resize;
  background: var(--surface-raised);
  /* Both edges, so the panels either side draw none. */
  box-shadow:
    inset 0 1px 0 var(--border),
    inset 0 -1px 0 var(--border);
  touch-action: none;
  position: relative;
}

/* The centred grab handle. */
.row-resizer::after {
  content: '';
  position: absolute;
  inset: 0;
  margin: auto;
  width: 2.25rem;
  height: 2px;
  border-radius: 1px;
  background: var(--text-dim);
  opacity: 0.5;
}

.row-resizer:hover,
.row-resizer:focus-visible {
  background: var(--selection);
}

.row-resizer:hover::after,
.row-resizer:focus-visible::after {
  background: var(--surface);
  opacity: 0.9;
}
</style>
