<script setup lang="ts">
/**
 * StackStrip: the stack of branches between the compare trunk and HEAD,
 * one button per layer, so a stacked pull request can be reviewed one
 * layer at a time (docs/stacked-compare.md §5).
 *
 *   STACK [all]  upstream/main › feature/aer- [1 4673-jsp-to-html 2|2 4693-nginx 4|…]
 *
 * The layers are one joined control, numbered bottom to top, so the strip
 * reads as one thing apart from the base picker and toggles above it. The
 * part every layer name shares is said once, before the control
 * (utils/stackNames), so six alike-named branches fit on one line.
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

import { computed } from 'vue';
import type { CompareStack, StackLayer } from '@diffstalker/core/types/stack';
import { sharedPrefix } from '../utils/stackNames';

const props = defineProps<{
  stack: CompareStack;
  /** The picked layer's name, or null for `all`. */
  active: string | null;
  /** While a compare pull is in flight, like the base picker. */
  disabled?: boolean;
}>();

const emit = defineEmits<{ pick: [name: string | null] }>();

const prefix = computed(() => sharedPrefix(props.stack.layers.map((l) => l.name)));

/** The layer's name without the prefix the strip already showed. */
function shortName(layer: StackLayer): string {
  return layer.name.slice(prefix.value.length);
}

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
    <span class="eyebrow" aria-hidden="true">stack</span>
    <button
      type="button"
      class="chip all"
      data-testid="stack-all"
      :class="{ current: active === null }"
      :aria-pressed="active === null"
      :disabled="disabled"
      title="The whole stack: trunk…HEAD"
      @click="emit('pick', null)"
    >
      all
    </button>
    <span class="trunk" data-testid="stack-trunk" :title="`trunk: ${stack.trunk}`">{{
      stack.trunk
    }}</span>
    <span class="arrow" aria-hidden="true">›</span>
    <span
      v-if="prefix"
      class="prefix"
      data-testid="stack-prefix"
      :title="`Every layer's name starts with ${prefix}`"
      >{{ prefix }}</span
    >
    <span class="layers">
      <button
        v-for="(layer, i) in stack.layers"
        :key="layer.tip"
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
        <span class="pos" aria-hidden="true">{{ i + 1 }}</span>
        <!-- The full name is read out; the shortened one is what shows. -->
        <span class="name" aria-hidden="true">{{ shortName(layer) }}</span>
        <span class="visually-hidden">{{ layer.name }}</span>
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
    </span>
    <span v-if="stack.forkedAbove" class="note" data-testid="stack-forked"
      >forks above HEAD; only this line is shown</span
    >
  </nav>
</template>

<style scoped>
/* One line that never wraps: a long stack scrolls INSIDE the strip. The
   topbar it sits in wraps its children, so a wrapped strip would push
   the whole view down; and a page-level scroll is never allowed. The
   rule above it sets the stack apart from the picker and toggles.
   `position: relative` keeps the visually-hidden read-out text (which is
   absolutely positioned) inside this scroll box: without it, those spans
   escape to the page and widen it on a phone. */
.stack-strip {
  position: relative;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex: 1 1 100%;
  min-width: 0;
  margin-top: -0.125rem;
  padding-top: 0.5rem;
  border-top: 1px solid var(--divider);
  overflow-x: auto;
  white-space: nowrap;
  font-size: var(--fs-small);
  color: var(--text-dim);
  scrollbar-width: thin;
}

.eyebrow,
.trunk,
.arrow,
.prefix,
.note {
  flex: none;
}

.trunk {
  color: var(--text);
}

.prefix {
  margin-right: -0.25rem;
}

.note {
  font-size: var(--fs-micro);
}

/* `all` and the layers share a look: bordered, raised, and the picked one
   filled with an accent rule under it, so it reads as a selection. */
.chip,
.layer {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.125rem 0.5rem;
  border: 0;
  background: var(--surface-raised);
  color: var(--text-dim);
  font-family: inherit;
  font-size: inherit;
  cursor: pointer;
}

.chip {
  flex: none;
  border: 1px solid var(--border);
  border-radius: 4px;
}

/* One joined control: the layers are one stack, not loose words. */
.layers {
  display: inline-flex;
  flex: none;
  border: 1px solid var(--border);
  border-radius: 4px;
  overflow: hidden;
}

.layer + .layer {
  border-left: 1px solid var(--border);
}

.chip:hover,
.layer:hover {
  color: var(--text);
}

.chip.current,
.layer.current {
  background: var(--row-selected-bg);
  box-shadow: inset 0 -2px 0 var(--accent);
  color: var(--text);
}

.chip:disabled,
.layer:disabled {
  opacity: 0.5;
  cursor: default;
}

.layer .pos {
  font-size: var(--fs-micro);
  opacity: 0.7;
}

/* A long name keeps the line short; the title and the read-out text
   carry it whole. The picked one is never cut. */
.layer .name {
  max-width: 18ch;
  overflow: hidden;
  text-overflow: ellipsis;
}

.layer.current .name {
  max-width: none;
}

.layer .commits {
  font-size: var(--fs-micro);
  opacity: 0.7;
}

/* The checked-out layer: the one with the working tree on it. */
.layer .head-mark {
  color: var(--accent);
  font-size: var(--fs-micro);
}
</style>
