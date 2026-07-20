<script setup lang="ts">
/**
 * Changes view: the source-control panel — files | diff | commit, with
 * a draggable split between files and diff.
 *
 * Files column: shared.status.files grouped by core's fileCategories
 * into Modified / Untracked / Staged, each row a status letter, the
 * (shortened) path, +/− stats, and the hunk-count indicator from
 * shared.hunkCounts. Clicking (or arrow-keying) a row hands the EXACT
 * FileEntry object to repo.selectFile — the store's stale-guard is
 * identity-based, so rows never clone entries.
 *
 * Staging: every row carries its side's actions (unstaged → stage +
 * discard-behind-a-confirm, staged → unstage), section headers carry
 * stage all / unstage all. Actions stop propagation so they never
 * double as a row select, and each disables while its own mutation is
 * in flight — the applied envelope refreshes the list. Failures land
 * in shared.error (header), never here.
 *
 * Diff column: the shared DiffView over repo.selection.diff. In this
 * view it gets the hunk-staging gutter: an unstaged-side file's hunks
 * stage, a staged-side file's hunks unstage. Untracked files have no
 * stageable hunks (git can only add the whole file) — no gutter.
 *
 * Commit column: CommitPanel (message, amend, commit). All state reads
 * are synchronous store state; nothing here awaits for rendering.
 */

import { computed, nextTick, ref, shallowRef, watch } from 'vue';
import { useRepoStore } from '../stores/repo';
import { categorizeFiles } from '@diffstalker/core/view/fileCategories';
import { shortenPath } from '@diffstalker/core/view/formatPath';
import type { FileEntry } from '@diffstalker/core/git/status';
import { statusLetter } from '../utils/format';
import { loadPrefs, savePrefs, CHANGES_SPLIT_MIN, CHANGES_SPLIT_MAX } from '../prefs';
import DiffView from '../components/DiffView.vue';
import CommitPanel from '../components/CommitPanel.vue';
import DiscardConfirm from '../components/DiscardConfirm.vue';

const repo = useRepoStore();

const status = computed(() => repo.shared.status);
const categories = computed(() => categorizeFiles(status.value?.files ?? []));

/** The three sections, in the app-wide order; empty ones are hidden. */
const sections = computed(() =>
  (
    [
      { name: 'Modified', files: categories.value.modified, action: 'stage-all' },
      { name: 'Untracked', files: categories.value.untracked, action: 'stage-all' },
      { name: 'Staged', files: categories.value.staged, action: 'unstage-all' },
    ] as const
  ).filter((section) => section.files.length > 0)
);

const selectedFile = computed(() => repo.selection.file);

/**
 * Direction of the diff column's hunk buttons: the selected file's side
 * decides — an unstaged-side file's hunks stage, a staged-side file's
 * hunks unstage. Untracked files have no stageable hunks: null hides
 * the gutter (stage the whole file from its row instead — CLI parity).
 */
const hunkStaging = computed<'stage' | 'unstage' | null>(() => {
  const file = selectedFile.value;
  if (!file || file.status === 'untracked') return null;
  return file.staged ? 'unstage' : 'stage';
});

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

// --- Staging operations (per-op pending flags; errors land in shared.error) ---

/**
 * Keys of mutations currently in flight ("stage:u:path", "stage-all",
 * …). Each button disables on its OWN key only; the applied response
 * envelope refreshes the list, so flags are short-lived.
 */
const pendingOps = ref(new Set<string>());

function fileOpKey(op: string, file: FileEntry): string {
  return `${op}:${rowKey(file)}`;
}

function isPending(key: string): boolean {
  return pendingOps.value.has(key);
}

async function runOp(key: string, fn: () => Promise<void>): Promise<void> {
  if (pendingOps.value.has(key)) return;
  pendingOps.value.add(key);
  try {
    await fn();
  } finally {
    pendingOps.value.delete(key);
  }
}

async function stageFile(file: FileEntry): Promise<void> {
  await runOp(fileOpKey('stage', file), () => repo.stage(file));
}

async function unstageFile(file: FileEntry): Promise<void> {
  await runOp(fileOpKey('unstage', file), () => repo.unstage(file));
}

async function runSectionAction(action: 'stage-all' | 'unstage-all'): Promise<void> {
  await runOp(action, () => (action === 'stage-all' ? repo.stageAll() : repo.unstageAll()));
}

// --- Discard (destructive → confirm dialog first) ---

/**
 * The unstaged-side file a discard was requested for; null = no dialog.
 * shallowRef: a deep ref would proxy the FileEntry, and the store must
 * receive the EXACT status entry (identity discipline, like selectFile).
 */
const discardTarget = shallowRef<FileEntry | null>(null);

function askDiscard(file: FileEntry): void {
  discardTarget.value = file;
}

async function confirmDiscard(): Promise<void> {
  const file = discardTarget.value;
  discardTarget.value = null;
  if (!file) return;
  await runOp(fileOpKey('discard', file), () => repo.discard(file));
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
          <div class="section-head">
            <h3 :id="`files-section-${section.name.toLowerCase()}`" class="section-header">
              {{ section.name }} <span class="section-count">{{ section.files.length }}</span>
            </h3>
            <button
              class="action-btn section-action"
              :class="section.action === 'stage-all' ? 'act-stage' : 'act-unstage'"
              :data-testid="section.action"
              :disabled="isPending(section.action)"
              :title="
                section.action === 'stage-all' ? 'Stage all changes' : 'Unstage all changes'
              "
              @click.stop="runSectionAction(section.action)"
            >
              {{ section.action === 'stage-all' ? 'stage all' : 'unstage all' }}
            </button>
          </div>
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
            <span class="row-actions">
              <template v-if="!file.staged">
                <button
                  class="action-btn act-stage"
                  data-testid="stage-file"
                  :disabled="isPending(fileOpKey('stage', file))"
                  :aria-label="`Stage ${file.path}`"
                  :title="`Stage ${file.path}`"
                  @click.stop="stageFile(file)"
                  @keydown.enter.stop
                  @keydown.space.stop
                >
                  stage
                </button>
                <button
                  class="action-btn act-discard"
                  data-testid="discard-file"
                  :disabled="isPending(fileOpKey('discard', file))"
                  :aria-label="
                    file.status === 'untracked' ? `Delete ${file.path}` : `Discard ${file.path}`
                  "
                  :title="
                    file.status === 'untracked'
                      ? `Delete ${file.path} (untracked)`
                      : `Discard changes to ${file.path}`
                  "
                  @click.stop="askDiscard(file)"
                  @keydown.enter.stop
                  @keydown.space.stop
                >
                  {{ file.status === 'untracked' ? 'delete' : 'discard' }}
                </button>
              </template>
              <button
                v-else
                class="action-btn act-unstage"
                data-testid="unstage-file"
                :disabled="isPending(fileOpKey('unstage', file))"
                :aria-label="`Unstage ${file.path}`"
                :title="`Unstage ${file.path}`"
                @click.stop="unstageFile(file)"
                @keydown.enter.stop
                @keydown.space.stop
              >
                unstage
              </button>
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
          <DiffView
            v-else
            :diff="repo.selection.diff"
            :file-path="selectedFile.path"
            :hunk-staging="hunkStaging"
          />
        </div>
      </template>
      <p v-else class="col-empty diff-prompt" data-testid="diff-prompt">
        Select a file to view its diff
      </p>
    </section>

    <aside class="commit-col" data-testid="commit-col">
      <CommitPanel />
    </aside>

    <DiscardConfirm
      v-if="discardTarget"
      :file="discardTarget"
      @confirm="confirmDiscard"
      @cancel="discardTarget = null"
    />
  </div>
</template>

<style scoped>
.changes {
  height: 100%;
  display: grid;
  /* files | resizer | diff | commit */
  grid-template-columns:
    clamp(12rem, var(--files-col, 32%), 65%) auto minmax(0, 1fr)
    clamp(14rem, 22%, 20rem);
  grid-template-rows: minmax(0, 1fr);
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

.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding-right: 0.75rem;
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

/* --- Staging action buttons (rows + section headers) --- */

.action-btn {
  flex: none;
  padding: 0 0.4375rem;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  line-height: 1.6;
  color: var(--text-dim);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 3px;
}

.action-btn:hover:not(:disabled) {
  border-color: currentcolor;
}

.action-btn:disabled {
  opacity: 0.5;
}

.act-stage:hover:not(:disabled),
.act-stage:focus-visible {
  color: var(--add);
}

.act-unstage:hover:not(:disabled),
.act-unstage:focus-visible {
  color: var(--del);
}

.act-discard:hover:not(:disabled),
.act-discard:focus-visible {
  color: var(--del);
}

/* Row actions sit at the far right; quiet until the row is hovered,
   focused into, or selected — but always in the DOM (and tab order). */
.row-actions {
  flex: none;
  display: inline-flex;
  gap: 0.25rem;
  opacity: 0;
}

.file-row:hover .row-actions,
.file-row:focus-within .row-actions,
.file-row.selected .row-actions {
  opacity: 1;
}

@media (prefers-reduced-motion: no-preference) {
  .row-actions {
    transition: opacity 80ms ease-out;
  }
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

/* --- Commit column --- */

.commit-col {
  min-width: 0;
  overflow: hidden;
  border-left: 1px solid var(--border);
  background: var(--surface);
}

/* Middling widths: the commit panel moves below the diff; files keep
   their full-height column and the resizer keeps working. */
@media (max-width: 64rem) {
  .changes {
    grid-template-columns: clamp(12rem, var(--files-col, 32%), 65%) auto minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr) auto;
  }

  .files-col,
  .resizer {
    grid-row: 1 / -1;
  }

  .commit-col {
    grid-column: 3;
    border-left: none;
    border-top: 1px solid var(--border);
  }
}

/* Narrow widths: full stack — files, diff, commit. The diff row keeps
   a usable minimum and the commit panel is height-capped with its own
   internal scroll, so a tall commit panel cannot squeeze the diff to
   nothing on a short viewport. */
@media (max-width: 44rem) {
  .changes {
    grid-template-columns: 1fr;
    grid-template-rows: minmax(6rem, 35%) minmax(8rem, 1fr) auto;
  }

  .files-col {
    grid-row: auto;
    border-right: none;
    border-bottom: 1px solid var(--border);
  }

  .resizer {
    display: none;
  }

  .commit-col {
    grid-column: 1;
    /* Cap the auto row; CommitPanel scrolls internally past this. */
    max-height: min(16rem, 40vh);
    overflow-y: auto;
  }

  /* Touch-first width: hover is unreliable, keep actions visible. */
  .row-actions {
    opacity: 1;
  }
}
</style>
