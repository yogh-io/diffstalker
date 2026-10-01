<script setup lang="ts">
/**
 * StackStrip: the stack of branches between the compare trunk and HEAD,
 * one button per layer, so a stacked pull request can be reviewed one
 * layer at a time (docs/stacked-compare.md §5).
 *
 *   all · upstream/main ← jsp-to-html ← nginx ← [nginx-image] ← no-tomcat ●
 *
 * `all` is the null pick: trunk…HEAD, the whole stack, which is what
 * Compare shows anyway. The trunk is a label, not a button — it is what
 * the base picker above already chooses. Each layer carries its commit
 * count (what that layer adds on top of the one below), and the layer at
 * HEAD's tip is marked as checked out: it is the only one whose diff can
 * fold uncommitted work in.
 *
 * A closed list built from git topology, never a ref box: the only
 * things that can be picked are the things that exist. Names only — PR
 * numbers would need the network, which a daemon a browser can reach
 * does not get to touch.
 *
 * The parent owns the pick and the request it turns into; this strip
 * only says which layer was clicked.
 */

import type { CompareStack, StackLayer } from '@diffstalker/core/types/stack';

defineProps<{
  stack: CompareStack;
  /** The picked layer's name, or null for `all`. */
  active: string | null;
  /** While a compare pull is in flight, like the base picker. */
  disabled?: boolean;
}>();

const emit = defineEmits<{ pick: [name: string | null] }>();

function commitsWord(layer: StackLayer): string {
  return layer.commits === 1 ? 'commit' : 'commits';
}

/** The refs at this tip other than the one shown, or an empty string. */
function otherRefs(layer: StackLayer): string {
  return layer.refs.slice(1).join(', ');
}

/** For the mouse; the same facts are in the button's hidden text. */
function layerTitle(layer: StackLayer): string {
  const refs = otherRefs(layer) === '' ? '' : `; also ${otherRefs(layer)}`;
  const head = layer.isHead ? ' (checked out)' : '';
  return `${layer.name}${head}: ${layer.commits} ${commitsWord(layer)} on top of the layer below${refs}`;
}
</script>

<template>
  <nav class="stack-strip mono" aria-label="Stack layers" data-testid="stack-strip">
    <button
      type="button"
      class="layer all"
      data-testid="stack-all"
      :class="{ current: active === null }"
      :aria-pressed="active === null"
      :disabled="disabled"
      title="The whole stack: trunk…HEAD"
      @click="emit('pick', null)"
    >
      all
    </button>
    <span class="sep" aria-hidden="true">·</span>
    <span class="trunk" data-testid="stack-trunk" :title="`trunk: ${stack.trunk}`">{{
      stack.trunk
    }}</span>
    <template v-for="layer in stack.layers" :key="layer.tip">
      <span class="arrow" aria-hidden="true">←</span>
      <button
        type="button"
        class="layer"
        data-testid="stack-layer"
        :data-layer="layer.name"
        :class="{ current: active === layer.name, head: layer.isHead }"
        :aria-pressed="active === layer.name"
        :disabled="disabled"
        :title="layerTitle(layer)"
        @click="emit('pick', layer.name)"
      >
        <span class="name">{{ layer.name }}</span>
        <!-- The count, the checked-out fact and the other refs at this
             tip are read out from the button itself: hover is not the
             only way to learn them. -->
        <span class="commits"
          >{{ layer.commits }}<span class="visually-hidden">{{ ` ${commitsWord(layer)}` }}</span></span
        >
        <template v-if="layer.isHead">
          <span class="head-mark" aria-hidden="true">●</span>
          <span class="visually-hidden">, checked out</span>
        </template>
        <span v-if="otherRefs(layer) !== ''" class="visually-hidden"
          >, also {{ otherRefs(layer) }}</span
        >
      </button>
    </template>
    <span v-if="stack.forkedAbove" class="note" data-testid="stack-forked"
      >— forks above HEAD; only this line is shown</span
    >
  </nav>
</template>

<style scoped>
/* One line that never wraps: a long stack scrolls INSIDE the strip. The
   topbar it sits in wraps its children, so a wrapped strip would push
   the whole view down; and a page-level scroll is never allowed. */
.stack-strip {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  flex: 1 1 100%;
  min-width: 0;
  overflow-x: auto;
  white-space: nowrap;
  font-size: var(--fs-small);
  color: var(--text-dim);
  scrollbar-width: thin;
}

.layer {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  flex: none;
  padding: 0.125rem 0.5rem;
  border: 1px solid transparent;
  border-radius: 4px;
  background: transparent;
  color: var(--text-dim);
  font-family: inherit;
  font-size: inherit;
  cursor: pointer;
}

.layer:hover {
  color: var(--text);
  border-color: var(--text-dim);
}

/* The picked layer is marked, not merely tinted: the strip reads as a
   list of what exists, and this says which of them the diff below is. */
.layer.current {
  background: var(--row-selected-bg);
  border-color: var(--selection);
  color: var(--text);
}

.layer .commits {
  padding: 0 0.3rem;
  border: 1px solid var(--border);
  border-radius: 3px;
  font-size: var(--fs-micro);
  opacity: 0.85;
}

.layer:disabled {
  opacity: 0.5;
  cursor: default;
}

/* The checked-out layer: the one with the working tree on it. */
.layer .head-mark {
  color: var(--accent);
  font-size: var(--fs-micro);
}

.trunk {
  flex: none;
  color: var(--text);
}

.sep,
.arrow {
  flex: none;
}

.note {
  flex: none;
  font-size: var(--fs-micro);
}
</style>
