<script setup lang="ts">
/**
 * Changes view: the read-only source-control panel — files | diff on a
 * draggable split. The commit column (Phase 5b) slots in as a third
 * grid column; the layout leaves that seam open.
 *
 * Files column: shared.status.files grouped by core's fileCategories
 * into Modified / Untracked / Staged, each row a status letter, the
 * (shortened) path, +/− stats, and the hunk-count indicator from
 * shared.hunkCounts. Clicking (or arrow-keying) a row hands the EXACT
 * FileEntry object to repo.selectFile — the store's stale-guard is
 * identity-based, so rows never clone entries.
 *
 * Diff column: the shared DiffView over repo.selection.diff. All state
 * reads are synchronous store state; nothing here awaits.
 */

import { computed, nextTick, ref, watch } from 'vue';
import { useRepoStore } from '../stores/repo';
import { categorizeFiles } from '@diffstalker/core/view/fileCategories';
import { shortenPath } from '@diffstalker/core/view/formatPath';
import type { FileEntry } from '@diffstalker/core/git/status';
import { statusLetter } from '../utils/format';
import { loadPrefs, savePrefs, CHANGES_SPLIT_MIN, CHANGES_SPLIT_MAX } from '../prefs';
import DiffView from '../components/DiffView.vue';

const repo = useRepoStore();

const status = computed(() => repo.shared.status);
const categories = computed(() => categorizeFiles(status.value?.files ?? []));

/** The three sections, in the app-wide order; empty ones are hidden. */
const sections = computed(() =>
  (
    [
      { name: 'Modified', files: categories.value.modified },
      { name: 'Untracked', files: categories.value.untracked },
      { name: 'Staged', files: categories.value.staged },
    ] as const
  ).filter((section) => section.files.length > 0)
);

const selectedFile = computed(() => repo.selection.file);

function isSelected(file: FileEntry): boolean {
  return repo.selection.file === file;
}

function rowKey(file: FileEntry): string {
  return `${file.staged ? 's' : 'u'}:${file.path}`;
}

/** Shortened path split into a dimmed dir prefix and emphasized basename. */
function splitPath(path: string): { dir: string; base: string } {
  const shortened = shortenPath(path, 56);
  const idx = shortened.lastIndexOf('/');
  if (idx === -1) return { dir: '', base: shortened };
  return { dir: shortened.slice(0, idx + 1), base: shortened.slice(idx + 1) };
}

/**
 * Hunk-count indicator, CLI semantics (FileList.formatHunkIndicator):
 * "●total" when every hunk is on this row's side, else "●n/total".
 */
function hunkIndicator(file: FileEntry): string {
  const counts = repo.shared.hunkCounts;
  if (!counts || file.status === 'untracked') return '';
  const staged = counts.staged[file.path] ?? 0;
  const unstaged = counts.unstaged[file.path] ?? 0;
  const total = staged + unstaged;
  if (total === 0) return '';
  const thisCount = file.staged ? staged : unstaged;
  return thisCount === total ? `●${total}` : `●${thisCount}/${total}`;
}

// --- Keyboard selection (roving tabindex over the flat ordered list) ---

const listEl = ref<HTMLElement | null>(null);

/** The row that holds tabindex 0: the selected one, else the first. */
function isTabStop(file: FileEntry): boolean {
  const ordered = categories.value.ordered;
  const selected = repo.selection.file;
  if (selected && ordered.includes(selected)) return file === selected;
  return file === ordered[0];
}

function moveSelection(delta: number): void {
  const ordered = categories.value.ordered;
  if (ordered.length === 0) return;
  const current = selectedFile.value ? ordered.indexOf(selectedFile.value) : -1;
  let next: number;
  if (current === -1) {
    next = delta > 0 ? 0 : ordered.length - 1;
  } else {
    next = Math.min(ordered.length - 1, Math.max(0, current + delta));
  }
  const file = ordered[next];
  repo.selectFile(file);
  void nextTick(() => {
    listEl.value?.querySelectorAll<HTMLElement>('.file-row')[next]?.focus();
  });
}

// Focus recovery: if a state-change removes the row that held focus
// (re-anchor dropped its file), focus would fall to <body>. Move it to
// the selected row instead so keyboard navigation keeps working.
watch(
  () => categories.value.ordered,
  () => {
    // Default (pre) flush: the DOM still holds the old rows here.
    const hadFocus = listEl.value?.contains(document.activeElement) ?? false;
    void nextTick(() => {
      const list = listEl.value;
      if (!hadFocus || !list || list.contains(document.activeElement)) return;
      const ordered = categories.value.ordered;
      const selected = repo.selection.file;
      const idx = selected ? ordered.indexOf(selected) : -1;
      const rows = list.querySelectorAll<HTMLElement>('.file-row');
      (idx >= 0 ? rows[idx] : rows[0])?.focus();
    });
  }
);

// --- Resizable split (persisted as a fraction of the container width) ---

const DEFAULT_SPLIT = 0.32;
const KEYBOARD_STEP = 0.02;

const containerEl = ref<HTMLElement | null>(null);
const splitRatio = ref(loadPrefs().changesSplit ?? DEFAULT_SPLIT);
let dragging = false;

function clampRatio(ratio: number): number {
  return Math.min(CHANGES_SPLIT_MAX, Math.max(CHANGES_SPLIT_MIN, ratio));
}

function onResizerPointerDown(event: PointerEvent): void {
  if (event.button !== 0) return; // primary button only — no right-click drags
  dragging = true;
  (event.target as HTMLElement).setPointerCapture(event.pointerId);
}

function onResizerPointerMove(event: PointerEvent): void {
  if (!dragging || !containerEl.value) return;
  const rect = containerEl.value.getBoundingClientRect();
  if (rect.width <= 0) return;
  splitRatio.value = clampRatio((event.clientX - rect.left) / rect.width);
}

function endDrag(): void {
  if (!dragging) return;
  dragging = false;
  savePrefs({ changesSplit: splitRatio.value });
}

function onResizerPointerUp(event: PointerEvent): void {
  if (!dragging) return;
  (event.target as HTMLElement).releasePointerCapture(event.pointerId);
  endDrag();
}

/** Touch cancel / context menu: end the drag so hover can't keep resizing. */
function onResizerPointerCancel(): void {
  endDrag();
}

function onResizerKeydown(event: KeyboardEvent): void {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  const delta = event.key === 'ArrowLeft' ? -KEYBOARD_STEP : KEYBOARD_STEP;
  event.preventDefault();
  splitRatio.value = clampRatio(splitRatio.value + delta);
  savePrefs({ changesSplit: splitRatio.value });
}
</script>

<template>
  <div
    ref="containerEl"
    class="changes"
    :style="{ '--files-col': `${(splitRatio * 100).toFixed(2)}%` }"
  >
    <aside class="files-col" aria-label="Changed files">
      <p v-if="repo.shared.isLoading" class="col-empty">Loading status…</p>
      <p v-else-if="!status" class="col-empty">No status yet.</p>
      <p v-else-if="status.files.length === 0" class="col-empty" data-testid="clean-tree">
        No changes — working tree clean.
      </p>

      <div
        v-else
        ref="listEl"
        class="file-list"
        data-testid="file-list"
        role="listbox"
        aria-label="Changed files"
      >
        <section
          v-for="section in sections"
          :key="section.name"
          class="file-section"
          role="group"
          :aria-labelledby="`files-section-${section.name.toLowerCase()}`"
          :data-testid="`section-${section.name.toLowerCase()}`"
        >
          <h3 :id="`files-section-${section.name.toLowerCase()}`" class="section-header">
            {{ section.name }} <span class="section-count">{{ section.files.length }}</span>
          </h3>
          <div
            v-for="file in section.files"
            :key="rowKey(file)"
            class="file-row mono"
            :class="{ selected: isSelected(file) }"
            role="option"
            :aria-selected="isSelected(file)"
            :tabindex="isTabStop(file) ? 0 : -1"
            :title="file.path"
            @click="repo.selectFile(file)"
            @keydown.down.prevent="moveSelection(1)"
            @keydown.up.prevent="moveSelection(-1)"
            @keydown.enter.prevent="repo.selectFile(file)"
            @keydown.space.prevent="repo.selectFile(file)"
          >
            <span class="letter" :data-status="file.status">{{ statusLetter(file.status) }}</span>
            <span class="path"
              ><span class="dir">{{ splitPath(file.path).dir }}</span
              ><span class="base">{{ splitPath(file.path).base }}</span></span
            >
            <span v-if="hunkIndicator(file)" class="hunks">{{ hunkIndicator(file) }}</span>
            <span class="stats">
              <span v-if="file.insertions" class="count-add">+{{ file.insertions }}</span>
              <span v-if="file.deletions" class="count-del">&minus;{{ file.deletions }}</span>
            </span>
          </div>
        </section>
      </div>
    </aside>

    <div
      class="resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize file list"
      :aria-valuenow="Math.round(splitRatio * 100)"
      aria-valuemin="15"
      aria-valuemax="65"
      tabindex="0"
      @pointerdown="onResizerPointerDown"
      @pointermove="onResizerPointerMove"
      @pointerup="onResizerPointerUp"
      @pointercancel="onResizerPointerCancel"
      @keydown="onResizerKeydown"
    ></div>

    <section class="diff-col" data-testid="diff-col">
      <template v-if="selectedFile">
        <header class="diff-file-header">
          <span class="letter mono" :data-status="selectedFile.status">{{
            statusLetter(selectedFile.status)
          }}</span>
          <span class="diff-path mono">{{ selectedFile.path }}</span>
          <span v-if="selectedFile.staged" class="staged-tag">staged</span>
          <span class="stats mono">
            <span v-if="selectedFile.insertions" class="count-add"
              >+{{ selectedFile.insertions }}</span
            >
            <span v-if="selectedFile.deletions" class="count-del"
              >&minus;{{ selectedFile.deletions }}</span
            >
          </span>
        </header>
        <div class="diff-body">
          <p v-if="!repo.selection.diff" class="col-empty">Loading diff…</p>
          <DiffView v-else :diff="repo.selection.diff" :file-path="selectedFile.path" />
        </div>
      </template>
      <p v-else class="col-empty diff-prompt" data-testid="diff-prompt">
        Select a file to view its diff
      </p>
    </section>
  </div>
</template>

<style scoped>
.changes {
  height: 100%;
  display: grid;
  /* Room for the Phase 5b commit column: it becomes a fourth track. */
  grid-template-columns: clamp(12rem, var(--files-col, 32%), 65%) auto minmax(0, 1fr);
  background: var(--bg);
}

/* --- Files column --- */

.files-col {
  min-width: 0;
  overflow-y: auto;
  border-right: 1px solid var(--border);
  background: var(--surface);
}

.col-empty {
  margin: 1rem;
  color: var(--text-dim);
  font-size: var(--fs-content);
}

.file-list {
  padding: 0.375rem 0;
}

.file-section + .file-section {
  margin-top: 0.5rem;
}

.section-header {
  margin: 0;
  padding: 0.25rem 0.75rem;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  font-weight: 500;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--text-dim);
}

.section-count {
  color: var(--text-dim);
  opacity: 0.8;
}

.file-row {
  display: flex;
  align-items: baseline;
  gap: 0.625rem;
  width: 100%;
  padding: 0.2188rem 0.75rem;
  font-size: var(--fs-base);
  text-align: left;
  border-left: 2px solid transparent;
  cursor: pointer; /* was a <button>; the option div keeps the affordance */
}

.file-row:hover {
  background: var(--surface-raised);
}

.file-row.selected {
  background: var(--surface-raised);
  border-left-color: var(--selection);
}

.file-row.selected .base {
  color: var(--selection);
}

.letter {
  flex: none;
  width: 1ch;
  font-weight: 700;
}

.letter[data-status='modified'] {
  color: var(--status-modified);
}

.letter[data-status='added'] {
  color: var(--status-added);
}

.letter[data-status='deleted'] {
  color: var(--status-deleted);
}

.letter[data-status='untracked'] {
  color: var(--status-untracked);
}

.letter[data-status='renamed'] {
  color: var(--status-renamed);
}

.letter[data-status='copied'] {
  color: var(--status-copied);
}

.path {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dir {
  color: var(--text-dim);
}

.base {
  color: var(--text);
  font-weight: 600;
}

.hunks {
  flex: none;
  margin-left: auto;
  font-size: var(--fs-small);
  color: var(--selection);
}

.stats {
  flex: none;
  display: inline-flex;
  gap: 0.375rem;
  font-size: var(--fs-small);
}

.file-row .stats {
  margin-left: auto;
}

.file-row .hunks + .stats {
  margin-left: 0;
}

/* --- Resizer --- */

.resizer {
  width: 5px;
  cursor: col-resize;
  background: transparent;
  touch-action: none;
}

.resizer:hover,
.resizer:focus-visible {
  background: var(--selection);
  opacity: 0.5;
}

/* --- Diff column --- */

.diff-col {
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.diff-file-header {
  flex: none;
  display: flex;
  align-items: baseline;
  gap: 0.625rem;
  padding: 0.375rem 0.75rem;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
  font-size: var(--fs-base);
}

.diff-path {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
}

.diff-file-header .stats {
  margin-left: auto;
}

.staged-tag {
  flex: none;
  font-size: var(--fs-micro);
  color: var(--add);
  border: 1px solid var(--add);
  border-radius: 3px;
  padding: 0 0.25rem;
}

.diff-body {
  flex: 1;
  min-height: 0;
}

.diff-prompt {
  align-self: center;
  margin: auto;
}

/* Narrow widths: stack — files above, diff below. */
@media (max-width: 44rem) {
  .changes {
    grid-template-columns: 1fr;
    grid-template-rows: minmax(6rem, 35%) minmax(0, 1fr);
  }

  .files-col {
    border-right: none;
    border-bottom: 1px solid var(--border);
  }

  .resizer {
    display: none;
  }
}
</style>
