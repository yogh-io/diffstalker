<script setup lang="ts">
/**
 * FinderOverlay: the global fuzzy file finder (⌘/Ctrl+P) — the web
 * analog of the CLI's FileFinder modal, same fzf library, same
 * smart-case matching.
 *
 * The repo's full file list is fetched once per open (GET …/files);
 * input is debounced ~15ms into the fzf query; matched characters are
 * highlighted. Up/Down or Ctrl+j/k move, Tab/Shift+Tab cycle, Enter
 * reveals the file in the Explorer view (explorer.revealFile), Esc
 * closes. Focus is trapped in the dialog and returns on close.
 *
 * The query is seeded from and written back to `ui.overlayQuery`, so
 * switching to content search mid-word keeps what you typed. See
 * SearchModes.vue for the strip that makes the switch visible.
 */

import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import {
  clampMove,
  createFinderIndex,
  cycleMove,
  toSegments,
  FINDER_DEBOUNCE_MS,
  type FinderIndex,
  type FinderMatch,
} from '@diffstalker/core/view/finderModel';
import { DiffstalkerClient } from '../api/client';
import { useDaemonStore } from '../stores/daemon';
import { useExplorerStore } from '../stores/explorer';
import { beginUserNav } from '../composables/useUrlSync';
import { useUiStore } from '../stores/ui';
import { displayError } from '../stores/repo';
import { useFocusTrap } from '../composables/useFocusTrap';
import SearchModes from './SearchModes.vue';

/** More than the CLI's 15 — the list scrolls; still bounded for paint cost. */
const MAX_RESULTS = 50;

const daemon = useDaemonStore();
const explorer = useExplorerStore();
const ui = useUiStore();
const client = new DiffstalkerClient();

const dialogEl = ref<HTMLElement | null>(null);
const listEl = ref<HTMLElement | null>(null);
useFocusTrap(dialogEl);

const paths = shallowRef<string[] | null>(null);
const loadError = shallowRef<string | null>(null);
/** Seeded from the sibling overlay when you switched corpus mid-query. */
const query = ref(ui.overlayQuery);
const results = shallowRef<FinderMatch[]>([]);
const selectedIndex = ref(0);

let finderIndex: FinderIndex | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
/** The query the current results answer (debounce may lag the input). */
let appliedQuery = '';

function updateResults(): void {
  results.value = finderIndex?.find(appliedQuery) ?? [];
  selectedIndex.value = 0;
  // New results select row 0 — make that visible, not an old scroll pos.
  if (listEl.value) listEl.value.scrollTop = 0;
}

const loadErrorMessage = displayError;

onMounted(async () => {
  const id = daemon.activeRepoId;
  if (id === null) {
    loadError.value = 'No active repository.';
    return;
  }
  try {
    const list = await client.files(id);
    paths.value = list;
    finderIndex = createFinderIndex(list, MAX_RESULTS);
    appliedQuery = query.value;
    updateResults();
  } catch (err) {
    loadError.value = loadErrorMessage(err);
  }
});

watch(query, (value) => {
  ui.setOverlayQuery(value);
  if (debounceTimer !== null) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    if (value === appliedQuery) return;
    appliedQuery = value;
    updateResults();
  }, FINDER_DEBOUNCE_MS);
});

onBeforeUnmount(() => {
  if (debounceTimer !== null) clearTimeout(debounceTimer);
});

// The list was captured for ONE repo at mount; a repo switch while the
// finder is open (follow mode) would leave stale paths — close instead.
watch(
  () => daemon.activeRepoId,
  () => ui.closeOverlay()
);

// --- Presentation ---

const loading = computed(() => paths.value === null && loadError.value === null);

/** Group a path's characters into matched/unmatched runs. */
function segments(match: FinderMatch): ReturnType<typeof toSegments> {
  return toSegments(match.text, match.positions);
}

// --- Selection ---

function moveSelection(delta: number): void {
  const count = results.value.length;
  if (count === 0) return;
  selectedIndex.value = clampMove(selectedIndex.value, delta, count);
  scrollSelectionIntoView();
}

function cycleSelection(delta: number): void {
  const count = results.value.length;
  if (count === 0) return;
  selectedIndex.value = cycleMove(selectedIndex.value, delta, count);
  scrollSelectionIntoView();
}

function scrollSelectionIntoView(): void {
  const option = listEl.value?.querySelectorAll<HTMLElement>('.finder-option')[selectedIndex.value];
  option?.scrollIntoView?.({ block: 'nearest' });
}

// Local async wrapper: the fire-and-forget below marks the promise with
// `void`; the store action never rejects (same pattern as the views).
async function reveal(path: string): Promise<void> {
  await explorer.revealFile(path);
}

/** Reveal the chosen file: Explorer view + tree reveal, then close. */
function choose(path: string): void {
  ui.closeOverlay();
  beginUserNav({ view: 'explorer' });
  ui.setActiveView('explorer');
  void reveal(path);
}

function chooseSelected(): void {
  const selected = results.value[selectedIndex.value];
  if (selected !== undefined) choose(selected.text);
}

function onInputKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown' || (event.ctrlKey && event.key === 'j')) {
    event.preventDefault();
    moveSelection(1);
  } else if (event.key === 'ArrowUp' || (event.ctrlKey && event.key === 'k')) {
    event.preventDefault();
    moveSelection(-1);
  } else if (event.key === 'Tab') {
    event.preventDefault();
    cycleSelection(event.shiftKey ? -1 : 1);
  } else if (event.key === 'Enter') {
    event.preventDefault();
    chooseSelected();
  } else if (event.key === 'Escape') {
    event.preventDefault();
    ui.closeOverlay();
  }
}
</script>

<template>
  <div class="overlay-scrim" data-testid="finder-overlay" @click.self="ui.closeOverlay()">
    <div
      ref="dialogEl"
      class="overlay-dialog finder"
      role="dialog"
      aria-modal="true"
      aria-label="Find file"
      tabindex="-1"
    >
      <SearchModes current="files" />

      <input
        class="finder-input mono"
        data-autofocus
        data-testid="finder-input"
        type="text"
        role="combobox"
        :aria-expanded="results.length > 0"
        :aria-controls="results.length > 0 ? 'finder-results' : undefined"
        :aria-activedescendant="results.length > 0 ? `finder-option-${selectedIndex}` : undefined"
        autocomplete="off"
        spellcheck="false"
        placeholder="Find a file…"
        :value="query"
        @input="query = ($event.target as HTMLInputElement).value"
        @keydown="onInputKeydown"
      />

      <p v-if="loading" class="finder-note mono">Loading file list…</p>
      <p v-else-if="loadError" class="finder-note error mono" data-testid="finder-error">
        {{ loadError }}
      </p>
      <p
        v-else-if="results.length === 0"
        class="finder-note mono"
        data-testid="finder-no-matches"
      >
        <template v-if="query === ''">This repository has no files.</template>
        <template v-else>No files match “{{ query }}”.</template>
      </p>

      <ul
        v-else
        id="finder-results"
        ref="listEl"
        class="finder-results mono"
        role="listbox"
        aria-label="Matching files"
        data-testid="finder-results"
      >
        <li
          v-for="(match, index) in results"
          :id="`finder-option-${index}`"
          :key="match.text"
          class="finder-option"
          role="option"
          :aria-selected="index === selectedIndex"
          :class="{ selected: index === selectedIndex }"
          :title="match.text"
          @mousemove="selectedIndex = index"
          @click="choose(match.text)"
        >
          <template v-for="(segment, si) in segments(match)" :key="si">
            <span v-if="segment.hit" class="hit">{{ segment.text }}</span>
            <template v-else>{{ segment.text }}</template>
          </template>
        </li>
      </ul>

      <p class="finder-hints mono" aria-hidden="true">
        <kbd>↑↓</kbd> / <kbd>ctrl j·k</kbd> move · <kbd>enter</kbd> reveal · <kbd>esc</kbd> close
      </p>
    </div>
  </div>
</template>

<style scoped>
.finder {
  width: min(40rem, calc(100vw - 2rem));
  display: flex;
  flex-direction: column;
}

.finder-input {
  width: 100%;
  border: none;
  border-bottom: 1px solid var(--border);
  border-radius: 0;
  background: transparent;
  padding: 0.75rem 1rem;
  font-size: var(--fs-content);
}

/* Keyboard focus reads as an accent underline (matching the input's own
   bottom-border language), rather than nothing. */
.finder-input:focus-visible {
  outline: none;
  border-bottom-color: var(--accent);
  border-bottom-width: 2px;
  padding-bottom: calc(0.75rem - 1px);
}

.finder-note {
  margin: 0;
  padding: 0.875rem 1rem;
  color: var(--text-dim);
  font-size: var(--fs-base);
}

.finder-note.error {
  color: var(--del);
}

.finder-results {
  margin: 0;
  padding: 0.25rem 0;
  list-style: none;
  overflow-y: auto;
  max-height: min(24rem, 55vh);
}

.finder-option {
  /* Subtracts the rail so the text lines up with unselected rows. Takes the
     token, not .list-row: hover IS selection here (@mousemove sets it), so a
     hover background would show under a row the keyboard has moved away from. */
  padding: 0.25rem 1rem 0.25rem calc(1rem - var(--row-rail));
  border-left: var(--row-rail) solid transparent;
  font-size: var(--fs-base);
  color: var(--text-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
}

.finder-option.selected {
  background: var(--row-selected-bg);
  border-left-color: var(--selection);
  color: var(--text);
}

.finder-option .hit {
  color: var(--warn);
  font-weight: 600;
}

.finder-hints {
  margin: 0;
  padding: 0.5rem 1rem;
  border-top: 1px solid var(--border);
  color: var(--text-dim);
  font-size: var(--fs-micro);
}

.finder-hints kbd {
  font-family: inherit;
  padding: 0 0.25rem;
  border: 1px solid var(--border);
  border-radius: 3px;
}
</style>
