<script setup lang="ts">
/**
 * FilterChip: the "narrow this list" input, shown in a view's header.
 *
 * Not an overlay. It is not modal, it does not scrim the thing it
 * narrows, and it stays put while the user works through the rows it
 * left behind — which is the whole difference between a filter and a
 * finder.
 *
 * The count always names its corpus ("4 of 214 changed files"), because
 * "no match" and "nothing loaded" must never read the same.
 */

import { nextTick, ref, watch } from 'vue';
import { useFilterStore } from '../stores/filter';

const props = defineProps<{
  /** How many rows survive the filter. */
  shown: number;
  /** How many there were. */
  total: number;
  /** Plural noun for the corpus, e.g. "changed files", "commits loaded". */
  corpus: string;
}>();

const filter = useFilterStore();
const inputEl = ref<HTMLInputElement | null>(null);

// `/` pressed again while the chip is open: return the caret to it.
watch(
  () => filter.focusRequest,
  () => {
    void nextTick(() => {
      inputEl.value?.focus();
      inputEl.value?.select();
    });
  },
  { immediate: true }
);

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    // Esc clears and closes; the list comes back whole.
    filter.close();
  }
}
</script>

<template>
  <div class="filter-chip mono" data-testid="filter-chip">
    <span class="filter-slash" aria-hidden="true">/</span>
    <input
      ref="inputEl"
      class="filter-input mono"
      data-testid="filter-input"
      type="text"
      autocomplete="off"
      spellcheck="false"
      placeholder="filter"
      :aria-label="`Filter ${props.corpus}`"
      :value="filter.query"
      @input="filter.setQuery(($event.target as HTMLInputElement).value)"
      @keydown="onKeydown"
    />
    <span class="filter-count" data-testid="filter-count">
      <template v-if="filter.query === ''">{{ props.total }} {{ props.corpus }}</template>
      <template v-else>{{ props.shown }} of {{ props.total }} {{ props.corpus }}</template>
    </span>
    <button
      class="filter-clear"
      type="button"
      aria-label="Clear filter"
      data-testid="filter-clear"
      @click="filter.close()"
    >
      x
    </button>
  </div>
</template>

<style scoped>
.filter-chip {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
  padding: 0.15rem 0.4rem;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--surface);
  font-size: var(--fs-micro);
}

.filter-slash {
  color: var(--text-dim);
}

.filter-input {
  flex: 1 1 8rem;
  min-width: 4rem;
  border: none;
  background: transparent;
  padding: 0;
  color: var(--text);
  font-size: var(--fs-micro);
}

.filter-input:focus-visible {
  outline: none;
}

.filter-chip:focus-within {
  border-color: var(--accent);
}

.filter-count {
  color: var(--text-dim);
  white-space: nowrap;
}

.filter-clear {
  border: none;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
  padding: 0 0.2rem;
  font: inherit;
}

.filter-clear:hover {
  color: var(--text);
}
</style>
