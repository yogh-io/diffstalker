<script setup lang="ts">
/**
 * The Work page's small line icons, 16-unit grid, drawn in currentColor so
 * the caller's colour (a stage, a check state) is the icon's colour.
 */

import { computed } from 'vue';

export type WorkIconName =
  | 'stack'
  | 'check'
  | 'cross'
  | 'pending'
  | 'comment'
  | 'approved'
  | 'changes'
  | 'waiting'
  | 'pencil'
  | 'compare'
  | 'chevron'
  | 'differs'
  | 'alert'
  | 'copy';

const PATHS: Record<WorkIconName, string> = {
  stack: 'M2.5 5.5 8 2.5l5.5 3L8 8.5ZM2.5 8.5 8 11.5l5.5-3M2.5 11 8 14l5.5-3',
  check: 'm3 8.5 3 3 7-7',
  cross: 'm4 4 8 8m0-8-8 8',
  pending: 'M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z',
  comment: 'M2.5 3.5h11v7.5h-6l-3 2.5V11h-2Z',
  approved: 'M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2Zm-2.75 6.25 1.75 1.75 3.75-3.75',
  changes: 'M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2ZM8 5v4.5M5.75 7.25h4.5M5.75 11h4.5',
  waiting: 'M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2Zm0 3v3.25l2 1.25',
  pencil: 'm10.5 2.5 3 3-8 8h-3v-3Z',
  compare: 'M2.5 5.5h10L10 3M13.5 10.5h-10L6 13',
  chevron: 'm6 3.5 4.5 4.5L6 12.5',
  differs: 'M3 6h10M3 10h10m-2.5-7-5 10',
  alert: 'M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2ZM8 5v3.75m0 2.25v.25',
  copy: 'M5.5 5.5h7.5v8H5.5ZM3 10.5v-8h7.5',
};

const props = defineProps<{ name: WorkIconName }>();

const path = computed(() => PATHS[props.name]);
</script>

<template>
  <svg
    class="work-icon"
    viewBox="0 0 16 16"
    width="14"
    height="14"
    aria-hidden="true"
    :data-icon="name"
  >
    <path :d="path" />
  </svg>
</template>

<style scoped>
.work-icon {
  flex: none;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-linejoin: round;
  vertical-align: -2px;
}

.work-icon[data-icon='pending'] {
  fill: currentColor;
  stroke: none;
}
</style>
