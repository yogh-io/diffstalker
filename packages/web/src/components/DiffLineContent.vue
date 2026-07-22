<script setup lang="ts">
/**
 * The inner content of one diff line: syntax-highlight pieces when given
 * (each a colored, optionally word-hl'd span), else the row's word-diff
 * segments, else plain text. A fragment component — no wrapper element —
 * so DiffView's unified rows and BOTH sides of its split rows render
 * byte-identical content markup from one place.
 */
import type { DiffContentRow } from '../utils/diffRows';
import type { DiffPiece } from '../utils/diffHighlight';

defineProps<{
  row: DiffContentRow;
  /** Syntax pieces when highlighting applies, else null (plain path). */
  pieces: DiffPiece[] | null;
}>();
</script>

<template>
  <template v-if="pieces"
    ><span v-for="(p, i) in pieces" :key="i" :class="[p.cls, { 'word-hl': p.changed }]">{{
      p.text
    }}</span></template
  ><template v-else-if="row.segments"
    ><span
      v-for="(seg, i) in row.segments"
      :key="i"
      :class="{ 'word-hl': seg.type === 'changed' }"
      >{{ seg.text }}</span
    ></template
  ><template v-else>{{ row.content }}</template>
</template>
