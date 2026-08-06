<script setup lang="ts">
/**
 * SearchOverlay: repo-wide content search (Ctrl/⌘+Shift+F, or bare F).
 *
 * A different verb from the finder next door: that one locates a file by
 * NAME from a list the client already holds; this one asks the daemon to
 * walk repo content. It is the one surface in the app that reads bytes the
 * client does not have, which is why every bound is server-side.
 *
 * Matched text is UNTRUSTED REPO CONTENT. It is rendered as text, never as
 * markup — no v-html anywhere in this file, and the daemon has already
 * capped line length. Do not "improve" this with highlighted markup built
 * by string concatenation.
 *
 * Activating a hit reveals the file in the Explorer and scrolls to the
 * line, reusing the finder's reveal path plus the store's line request.
 */

import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { FINDER_DEBOUNCE_MS } from '@diffstalker/core/view/finderModel';
import type { GrepMatch, GrepResult } from '@diffstalker/core/git/grep';
import { DiffstalkerClient } from '../api/client';
import { useDaemonStore } from '../stores/daemon';
import { useExplorerStore } from '../stores/explorer';
import { beginUserNav } from '../composables/useUrlSync';
import { useUiStore } from '../stores/ui';
import { displayError } from '../stores/repo';
import { useFocusTrap } from '../composables/useFocusTrap';

/** Mirrors the daemon's GREP_MIN_QUERY: below this it will 400. */
const MIN_QUERY = 3;
/** A search costs a git process, so it waits longer than the finder does. */
const SEARCH_DEBOUNCE_MS = FINDER_DEBOUNCE_MS * 10;

const daemon = useDaemonStore();
const explorer = useExplorerStore();
const ui = useUiStore();
const client = new DiffstalkerClient();

const dialogEl = ref<HTMLElement | null>(null);
const listEl = ref<HTMLElement | null>(null);
useFocusTrap(dialogEl);

const query = ref('');
const result = shallowRef<GrepResult | null>(null);
const searchError = shallowRef<string | null>(null);
const searching = ref(false);
const selectedIndex = ref(0);

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
/** Only the newest search may write results — an older reply is dropped. */
let generation = 0;

const matches = computed<GrepMatch[]>(() => result.value?.matches ?? []);

/** Hits grouped by file, in first-hit order, for a scannable list. */
const groups = computed(() => {
  const byPath = new Map<string, GrepMatch[]>();
  for (const match of matches.value) {
    const bucket = byPath.get(match.path);
    if (bucket) bucket.push(match);
    else byPath.set(match.path, [match]);
  }
  return [...byPath.entries()].map(([path, hits]) => ({ path, hits }));
});

/** Flat index -> match, so keyboard movement crosses group boundaries. */
const flat = computed(() => matches.value);

async function run(value: string): Promise<void> {
  const id = daemon.activeRepoId;
  if (id === null) {
    searchError.value = 'No active repository.';
    return;
  }
  generation += 1;
  const mine = generation;
  searching.value = true;
  try {
    const found = await client.search(id, value);
    if (mine !== generation) return; // superseded by a newer keystroke
    result.value = found;
    searchError.value = null;
    selectedIndex.value = 0;
    if (listEl.value) listEl.value.scrollTop = 0;
  } catch (err) {
    if (mine !== generation) return;
    result.value = null;
    searchError.value = displayError(err);
  } finally {
    if (mine === generation) searching.value = false;
  }
}

watch(query, (value) => {
  if (debounceTimer !== null) clearTimeout(debounceTimer);
  const trimmed = value.trim();
  if (trimmed.length < MIN_QUERY) {
    generation += 1; // abandon any in-flight reply
    result.value = null;
    searchError.value = null;
    searching.value = false;
    return;
  }
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void run(trimmed);
  }, SEARCH_DEBOUNCE_MS);
});

onBeforeUnmount(() => {
  if (debounceTimer !== null) clearTimeout(debounceTimer);
  generation += 1;
});

// Results belong to ONE repo; a repo switch under an open overlay (follow
// mode) would leave hits pointing at files in the old repo.
watch(
  () => daemon.activeRepoId,
  () => ui.closeOverlay()
);

// --- Selection ---

function moveSelection(delta: number): void {
  const count = flat.value.length;
  if (count === 0) return;
  selectedIndex.value = Math.min(count - 1, Math.max(0, selectedIndex.value + delta));
  const row = listEl.value?.querySelectorAll<HTMLElement>('.hit-row')[selectedIndex.value];
  row?.scrollIntoView?.({ block: 'nearest' });
}

/** Flat index of a hit, for selection styling across groups. */
function indexOf(match: GrepMatch): number {
  return flat.value.indexOf(match);
}

async function reveal(path: string, line: number): Promise<void> {
  await explorer.revealFile(path, { line });
}

function choose(match: GrepMatch): void {
  ui.closeOverlay();
  beginUserNav({ view: 'explorer' });
  ui.setActiveView('explorer');
  void reveal(match.path, match.line);
}

function chooseSelected(): void {
  const match = flat.value[selectedIndex.value];
  if (match !== undefined) choose(match);
}

function onInputKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown' || (event.ctrlKey && event.key === 'j')) {
    event.preventDefault();
    moveSelection(1);
  } else if (event.key === 'ArrowUp' || (event.ctrlKey && event.key === 'k')) {
    event.preventDefault();
    moveSelection(-1);
  } else if (event.key === 'Enter') {
    event.preventDefault();
    chooseSelected();
  } else if (event.key === 'Escape') {
    event.preventDefault();
    ui.closeOverlay();
  }
}

// --- Presentation ---

const tooShort = computed(() => query.value.trim().length > 0 && query.value.trim().length < MIN_QUERY);
const empty = computed(
  () => !searching.value && result.value !== null && matches.value.length === 0
);
</script>

<template>
  <div class="overlay-scrim" data-testid="search-overlay" @click.self="ui.closeOverlay()">
    <div
      ref="dialogEl"
      class="overlay-dialog search"
      role="dialog"
      aria-modal="true"
      aria-label="Search repository content"
      tabindex="-1"
    >
      <input
        class="search-input mono"
        data-autofocus
        data-testid="search-input"
        type="text"
        role="combobox"
        :aria-expanded="matches.length > 0"
        :aria-controls="matches.length > 0 ? 'search-results' : undefined"
        autocomplete="off"
        spellcheck="false"
        placeholder="Search file contents…"
        :value="query"
        @input="query = ($event.target as HTMLInputElement).value"
        @keydown="onInputKeydown"
      />

      <p v-if="tooShort" class="search-note mono" data-testid="search-too-short">
        Type at least {{ MIN_QUERY }} characters.
      </p>
      <p v-else-if="searching" class="search-note mono">Searching…</p>
      <p v-else-if="searchError" class="search-note error mono" data-testid="search-error">
        {{ searchError }}
      </p>
      <p v-else-if="empty" class="search-note mono" data-testid="search-no-matches">
        No file contains “{{ query.trim() }}”.
      </p>

      <ul
        v-else-if="matches.length > 0"
        id="search-results"
        ref="listEl"
        class="search-results mono"
        role="listbox"
        aria-label="Matching lines"
        data-testid="search-results"
      >
        <li v-for="group in groups" :key="group.path" class="hit-group">
          <p class="hit-path" :title="group.path">
            {{ group.path }} <span class="hit-count">{{ group.hits.length }}</span>
          </p>
          <div
            v-for="hit in group.hits"
            :key="`${hit.path}:${hit.line}`"
            class="hit-row"
            role="option"
            :aria-selected="indexOf(hit) === selectedIndex"
            :class="{ selected: indexOf(hit) === selectedIndex }"
            @mousemove="selectedIndex = indexOf(hit)"
            @click="choose(hit)"
          >
            <span class="hit-line">{{ hit.line }}</span>
            <!-- Text, never markup: this is arbitrary repo content. -->
            <span class="hit-text">{{ hit.text }}<template v-if="hit.truncated">…</template></span>
          </div>
        </li>
      </ul>

      <p v-if="result?.capped" class="search-note mono" data-testid="search-capped">
        Showing the first {{ matches.length }} matches — narrow the search to see the rest.
      </p>
      <p v-else-if="result?.incomplete" class="search-note mono" data-testid="search-incomplete">
        Search stopped early on this repository. These results are partial.
      </p>

      <p class="search-hints mono" aria-hidden="true">
        <kbd>↑↓</kbd> move · <kbd>enter</kbd> open · <kbd>esc</kbd> close · literal text, not a
        pattern
      </p>
    </div>
  </div>
</template>

<style scoped>
.search {
  width: min(56rem, calc(100vw - 2rem));
  display: flex;
  flex-direction: column;
}

.search-input {
  width: 100%;
  border: none;
  border-bottom: 1px solid var(--border);
  border-radius: 0;
  background: transparent;
  padding: 0.75rem 1rem;
  font-size: var(--fs-content);
}

.search-input:focus-visible {
  outline: none;
  border-bottom-color: var(--accent);
  border-bottom-width: 2px;
  padding-bottom: calc(0.75rem - 1px);
}

.search-note {
  margin: 0;
  padding: 0.875rem 1rem;
  color: var(--text-dim);
  font-size: var(--fs-base);
}

.search-note.error {
  color: var(--del);
}

.search-results {
  margin: 0;
  padding: 0.25rem 0;
  list-style: none;
  overflow-y: auto;
  max-height: min(28rem, 60vh);
}

.hit-group {
  padding-bottom: 0.25rem;
}

.hit-path {
  margin: 0;
  padding: 0.35rem 1rem 0.15rem;
  color: var(--text-dim);
  font-size: var(--fs-micro);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.hit-count {
  opacity: 0.7;
}

.hit-row {
  display: flex;
  gap: 0.75rem;
  padding: 0.15rem 1rem 0.15rem calc(1rem - var(--row-rail));
  border-left: var(--row-rail) solid transparent;
  font-size: var(--fs-base);
  color: var(--text-dim);
  cursor: pointer;
}

.hit-row.selected {
  background: var(--row-selected-bg);
  border-left-color: var(--selection);
  color: var(--text);
}

.hit-line {
  flex: 0 0 auto;
  min-width: 3.5ch;
  text-align: right;
  opacity: 0.6;
}

.hit-text {
  flex: 1 1 auto;
  white-space: pre;
  overflow: hidden;
  text-overflow: ellipsis;
}

.search-hints {
  margin: 0;
  padding: 0.5rem 1rem;
  border-top: 1px solid var(--border);
  color: var(--text-dim);
  font-size: var(--fs-micro);
}

.search-hints kbd {
  font-family: inherit;
  padding: 0 0.25rem;
  border: 1px solid var(--border);
  border-radius: 3px;
}
</style>
