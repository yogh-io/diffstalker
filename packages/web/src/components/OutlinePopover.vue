<script setup lang="ts">
/**
 * OutlinePopover: the symbols in the open file (bare `o`).
 *
 * A dismissable popover on the z-20 layer, NOT a modal overlay. Two
 * reasons, both deliberate: it must not take the single overlay slot the
 * finder and search share, and it must not scrim the file it describes —
 * you pick a symbol by looking at the code beside it.
 *
 * Every "nothing to show" state comes from `outlineStatus`, which keeps
 * seven distinct states distinct. This component renders what it is told
 * and never decides; that is what stops two states collapsing into one
 * string during a template edit.
 *
 * Symbol names are repo content. They are rendered as text.
 */

import { computed, nextTick, ref, watch } from 'vue';
import { outlineStatus } from '@diffstalker/core/view/outlineModel';
import type { FileSymbol } from '@diffstalker/core/symbols/types';
import { createFinderIndex, clampMove } from '@diffstalker/core/view/finderModel';
import { useExplorerStore } from '../stores/explorer';
import { useDismissable } from '../composables/useDismissable';

const explorer = useExplorerStore();
// `open` and `rootEl` must keep these exact names — the composable binds
// them, and ref="rootEl" is what an outside click is measured against.
const { open, rootEl } = useDismissable();
const inputEl = ref<HTMLInputElement | null>(null);
const query = ref('');
const selectedIndex = ref(0);

/** Opened by the host on `o`; closes itself on Escape or an outside click. */
function openPopover(): void {
  query.value = '';
  selectedIndex.value = 0;
  open.value = true;
  void nextTick(() => inputEl.value?.focus());
}

defineExpose({ openPopover });

const status = computed(() =>
  explorer.file === null || explorer.selectedPath === null
    ? { kind: 'note' as const, note: 'No file open.' }
    : outlineStatus(
        {
          path: explorer.selectedPath,
          binary: explorer.file.binary,
          tooLarge: explorer.file.tooLarge,
          truncated: explorer.file.truncated,
          totalLines: explorer.file.totalLines,
        },
        explorer.fileSymbols
      )
);

const allSymbols = computed<FileSymbol[]>(() =>
  status.value.kind === 'symbols' ? status.value.symbols : []
);

/** Filtered by name, in declaration order — see useTextFilter's reasoning. */
const shown = computed<FileSymbol[]>(() => {
  const q = query.value.trim();
  if (q === '') return allSymbols.value;
  const names = allSymbols.value.map((s) => s.name);
  const matched = new Set(
    createFinderIndex(names, names.length)
      .find(q)
      .map((m) => m.text)
  );
  return allSymbols.value.filter((s) => matched.has(s.name));
});

watch(shown, () => {
  selectedIndex.value = 0;
});

// A different file is a different outline; never leave a stale one up.
watch(
  () => explorer.selectedPath,
  () => {
    open.value = false;
  }
);

function choose(symbol: FileSymbol): void {
  explorer.requestLine(symbol.startLine);
  open.value = false;
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown' || (event.ctrlKey && event.key === 'j')) {
    event.preventDefault();
    selectedIndex.value = clampMove(selectedIndex.value, 1, shown.value.length);
  } else if (event.key === 'ArrowUp' || (event.ctrlKey && event.key === 'k')) {
    event.preventDefault();
    selectedIndex.value = clampMove(selectedIndex.value, -1, shown.value.length);
  } else if (event.key === 'Enter') {
    event.preventDefault();
    const symbol = shown.value[selectedIndex.value];
    if (symbol !== undefined) choose(symbol);
  } else if (event.key === 'Escape') {
    event.preventDefault();
    open.value = false;
  }
}
</script>

<template>
  <div v-if="open" ref="rootEl" class="outline mono" data-testid="outline-popover">
    <input
      ref="inputEl"
      class="outline-input mono"
      data-testid="outline-input"
      type="text"
      autocomplete="off"
      spellcheck="false"
      placeholder="filter symbols"
      aria-label="Filter symbols"
      :value="query"
      @input="query = ($event.target as HTMLInputElement).value"
      @keydown="onKeydown"
    />

    <p v-if="status.kind === 'note'" class="outline-note" data-testid="outline-note">
      {{ status.note }}
    </p>

    <template v-else>
      <p v-if="status.note" class="outline-note" data-testid="outline-partial">
        {{ status.note }}
      </p>
      <p v-if="shown.length === 0" class="outline-note" data-testid="outline-no-match">
        No symbol matches “{{ query.trim() }}”.
      </p>
      <ul v-else class="outline-list" role="listbox" aria-label="Symbols">
        <li
          v-for="(symbol, index) in shown"
          :key="`${symbol.name}:${symbol.startLine}`"
          class="outline-row"
          role="option"
          :aria-selected="index === selectedIndex"
          :class="{ selected: index === selectedIndex }"
          @mousemove="selectedIndex = index"
          @click="choose(symbol)"
        >
          <span class="outline-kind">{{ symbol.kind }}</span>
          <span class="outline-name">{{ symbol.name }}</span>
          <span v-if="symbol.parent" class="outline-parent">in {{ symbol.parent }}</span>
          <span class="outline-line">{{ symbol.startLine }}</span>
        </li>
      </ul>
    </template>
  </div>
</template>

<style scoped>
.outline {
  position: absolute;
  z-index: 20;
  right: 0.5rem;
  top: 2.25rem;
  width: min(26rem, calc(100vw - 2rem));
  display: flex;
  flex-direction: column;
  background: var(--surface-raised);
  border: 1px solid var(--border);
  border-radius: 4px;
  box-shadow: 0 6px 24px rgb(0 0 0 / 35%);
}

.outline-input {
  border: none;
  border-bottom: 1px solid var(--border);
  border-radius: 0;
  background: transparent;
  padding: 0.4rem 0.6rem;
  font-size: var(--fs-base);
  color: var(--text);
}

.outline-input:focus-visible {
  outline: none;
  border-bottom-color: var(--accent);
}

.outline-note {
  margin: 0;
  padding: 0.6rem;
  color: var(--text-dim);
  font-size: var(--fs-base);
}

.outline-list {
  margin: 0;
  padding: 0.2rem 0;
  list-style: none;
  overflow-y: auto;
  max-height: min(24rem, 55vh);
}

.outline-row {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  padding: 0.2rem 0.6rem 0.2rem calc(0.6rem - var(--row-rail));
  border-left: var(--row-rail) solid transparent;
  font-size: var(--fs-base);
  color: var(--text-dim);
  cursor: pointer;
}

.outline-row.selected {
  background: var(--row-selected-bg);
  border-left-color: var(--selection);
  color: var(--text);
}

.outline-kind {
  flex: 0 0 auto;
  min-width: 5.5ch;
  font-size: var(--fs-micro);
  opacity: 0.7;
}

.outline-name {
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.outline-parent {
  flex: 0 0 auto;
  font-size: var(--fs-micro);
  opacity: 0.6;
}

.outline-line {
  flex: 0 0 auto;
  opacity: 0.6;
}
</style>
