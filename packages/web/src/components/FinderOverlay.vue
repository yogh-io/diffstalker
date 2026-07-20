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
 */

import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { Fzf } from 'fzf';
import { DiffstalkerClient } from '../api/client';
import { isConnectionError } from '../api/errors';
import { useDaemonStore } from '../stores/daemon';
import { useExplorerStore } from '../stores/explorer';
import { useUiStore } from '../stores/ui';
import { CONNECTION_LOST_MESSAGE } from '../stores/repo';
import { useFocusTrap } from '../composables/useFocusTrap';

/** More than the CLI's 15 — the list scrolls; still bounded for paint cost. */
const MAX_RESULTS = 50;
const DEBOUNCE_MS = 15;

interface FinderMatch {
  path: string;
  /** Indices (into path) of the matched characters. */
  positions: Set<number>;
}

/** A path split into runs for match highlighting. */
interface PathSegment {
  text: string;
  hit: boolean;
}

const daemon = useDaemonStore();
const explorer = useExplorerStore();
const ui = useUiStore();
const client = new DiffstalkerClient();

const dialogEl = ref<HTMLElement | null>(null);
const listEl = ref<HTMLElement | null>(null);
useFocusTrap(dialogEl);

const paths = shallowRef<string[] | null>(null);
const loadError = shallowRef<string | null>(null);
const query = ref('');
const results = shallowRef<FinderMatch[]>([]);
const selectedIndex = ref(0);

let fzf: Fzf<string[]> | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
/** The query the current results answer (debounce may lag the input). */
let appliedQuery = '';

const EMPTY_POSITIONS = new Set<number>();

function updateResults(): void {
  const all = paths.value ?? [];
  if (appliedQuery === '') {
    results.value = all
      .slice(0, MAX_RESULTS)
      .map((path) => ({ path, positions: EMPTY_POSITIONS }));
  } else {
    results.value =
      fzf?.find(appliedQuery).map((entry) => ({ path: entry.item, positions: entry.positions })) ??
      [];
  }
  selectedIndex.value = 0;
  // New results select row 0 — make that visible, not an old scroll pos.
  if (listEl.value) listEl.value.scrollTop = 0;
}

function loadErrorMessage(err: unknown): string {
  if (isConnectionError(err)) return CONNECTION_LOST_MESSAGE;
  return err instanceof Error ? err.message : String(err);
}

onMounted(async () => {
  const id = daemon.activeRepoId;
  if (id === null) {
    loadError.value = 'No active repository.';
    return;
  }
  try {
    const list = await client.files(id);
    paths.value = list;
    fzf = new Fzf(list, { limit: MAX_RESULTS, casing: 'smart-case' });
    appliedQuery = query.value;
    updateResults();
  } catch (err) {
    loadError.value = loadErrorMessage(err);
  }
});

watch(query, (value) => {
  if (debounceTimer !== null) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    if (value === appliedQuery) return;
    appliedQuery = value;
    updateResults();
  }, DEBOUNCE_MS);
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
function segments(match: FinderMatch): PathSegment[] {
  const out: PathSegment[] = [];
  for (let i = 0; i < match.path.length; i++) {
    const hit = match.positions.has(i);
    const last = out[out.length - 1];
    if (last !== undefined && last.hit === hit) last.text += match.path[i];
    else out.push({ text: match.path[i], hit });
  }
  return out;
}

// --- Selection ---

function moveSelection(delta: number): void {
  const count = results.value.length;
  if (count === 0) return;
  selectedIndex.value = Math.min(count - 1, Math.max(0, selectedIndex.value + delta));
  scrollSelectionIntoView();
}

function cycleSelection(delta: number): void {
  const count = results.value.length;
  if (count === 0) return;
  selectedIndex.value = (selectedIndex.value + delta + count) % count;
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
  ui.setActiveView('explorer');
  void reveal(path);
}

function chooseSelected(): void {
  const selected = results.value[selectedIndex.value];
  if (selected !== undefined) choose(selected.path);
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
          :key="match.path"
          class="finder-option"
          role="option"
          :aria-selected="index === selectedIndex"
          :class="{ selected: index === selectedIndex }"
          :title="match.path"
          @mousemove="selectedIndex = index"
          @click="choose(match.path)"
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

.finder-input:focus,
.finder-input:focus-visible {
  outline: none;
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
  padding: 0.25rem 1rem 0.25rem calc(1rem - 2px);
  border-left: 2px solid transparent;
  font-size: var(--fs-base);
  color: var(--text-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
}

.finder-option.selected {
  background: var(--surface-raised);
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
