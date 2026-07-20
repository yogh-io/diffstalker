<script setup lang="ts">
/**
 * Explorer view: VS Code-style repo file tree (left) + read-only file
 * content (right), all data from the daemon's stateless /tree and /file
 * endpoints via the explorer store.
 *
 * Tree: the store's flattened row model renders as a flat DOM list with
 * canonical tree a11y (role=tree/treeitem, aria-level, aria-expanded)
 * and a roving tabindex. Clicking a dir expands/collapses (lazy child
 * fetch), clicking a file loads it. Keyboard: arrows move, Right/Enter
 * expand, Left collapses (or jumps to the parent), Home/End jump.
 *
 * Toolbar: dotfiles / ignored toggles (each refetches the visible tree
 * with the daemon's inverted show-flags — see the store) and the
 * changed-only client-side filter (the CLI's `g`), plus refresh.
 *
 * The content pane (FileContentPane) renders the selected file from its
 * FileForDisplay flags with syntax highlighting and line numbers.
 */

import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useRepoStore } from '../stores/repo';
import { useExplorerStore } from '../stores/explorer';
import type { ExplorerRow } from '../stores/explorer';
import { statusLetter } from '../utils/format';
import FileContentPane from '../components/FileContentPane.vue';

const repo = useRepoStore();
const explorer = useExplorerStore();
const {
  rows,
  rootLoading,
  error,
  showHidden,
  showIgnored,
  changedOnly,
  selectedPath,
  file,
  fileLoading,
  fileError,
} = storeToRefs(explorer);

const treeEl = ref<HTMLElement | null>(null);

// Local async wrappers: fire-and-forget spots below mark the promise
// with `void`, and the store actions never reject (errors collapse into
// store state) — same pattern as the other views.
async function ensureRoot(): Promise<void> {
  await explorer.ensureRoot();
}

async function toggleDir(path: string): Promise<void> {
  await explorer.toggleDir(path);
}

async function open(path: string): Promise<void> {
  await explorer.openFile(path);
}

onMounted(() => {
  void ensureRoot();
});

// Repo switch: the store's own watcher resets first (registered at store
// creation, so it runs before this one), then the root reloads here.
watch(
  () => repo.repoId,
  () => {
    void ensureRoot();
  }
);

// --- Activation ---

function activate(row: ExplorerRow): void {
  focusedPath.value = row.entry.path;
  if (row.entry.type === 'dir') {
    void toggleDir(row.entry.path);
  } else {
    void open(row.entry.path);
  }
}

// --- Keyboard navigation (roving tabindex) ---

/** The row that owns the tab stop; falls back to selection, then first. */
const focusedPath = ref<string | null>(null);

/**
 * The single row index that owns the tab stop: the focused row if it is
 * still visible, else the selected row, else the first. Computed once
 * per rows/anchor change — the template compares indices, so rendering
 * stays O(n) instead of a rows.some() scan per row.
 */
const tabStopIndex = computed<number>(() => {
  for (const anchor of [focusedPath.value, selectedPath.value]) {
    if (anchor === null) continue;
    const index = rows.value.findIndex((r) => r.entry.path === anchor);
    if (index !== -1) return index;
  }
  return 0;
});

function focusRow(index: number): void {
  const row = rows.value[index];
  if (!row) return;
  focusedPath.value = row.entry.path;
  void nextTick(() => {
    treeEl.value?.querySelectorAll<HTMLElement>('.tree-row')[index]?.focus();
  });
}

function rowIndex(row: ExplorerRow): number {
  return rows.value.findIndex((r) => r.entry.path === row.entry.path);
}

function moveFocus(row: ExplorerRow, delta: number): void {
  const current = rowIndex(row);
  if (current === -1) return;
  focusRow(Math.min(rows.value.length - 1, Math.max(0, current + delta)));
}

/** Right: expand a collapsed dir; step into an expanded one's first
 *  child; no-op on files and on an expanded dir with no children (per
 *  the ARIA tree pattern — Right never jumps to a sibling). */
function onRight(row: ExplorerRow): void {
  if (row.entry.type !== 'dir') return;
  if (!row.isExpanded) {
    void toggleDir(row.entry.path);
    return;
  }
  const current = rowIndex(row);
  if (current === -1) return;
  const next = rows.value[current + 1];
  if (next && next.depth > row.depth) focusRow(current + 1);
}

/** Left: collapse an expanded dir; otherwise jump to the parent row. */
function onLeft(row: ExplorerRow): void {
  if (row.entry.type === 'dir' && row.isExpanded) {
    explorer.collapseDir(row.entry.path);
    return;
  }
  const slash = row.entry.path.lastIndexOf('/');
  if (slash === -1) return; // root level — nowhere up to go
  const parent = row.entry.path.slice(0, slash);
  const parentIndex = rows.value.findIndex((r) => r.entry.path === parent);
  if (parentIndex !== -1) focusRow(parentIndex);
}

// Focus recovery: if a reload or filter change removes the row that
// held focus (e.g. a focused dotfile after toggling dotfiles off),
// focus would fall to <body>. Move it to the tab-stop row (selected
// row, else first) so keyboard navigation keeps working.
watch(
  () => rows.value,
  () => {
    // Default (pre) flush: the DOM still holds the old rows here.
    const hadFocus = treeEl.value?.contains(document.activeElement) ?? false;
    void nextTick(() => {
      const tree = treeEl.value;
      if (!hadFocus || !tree || tree.contains(document.activeElement)) return;
      const index = tabStopIndex.value;
      const row = rows.value[index];
      if (!row) return;
      focusedPath.value = row.entry.path;
      tree.querySelectorAll<HTMLElement>('.tree-row')[index]?.focus();
    });
  }
);

// Keep the selected row visible: a reveal (fuzzy finder, follow mode)
// can select a row far outside the current scroll position.
watch(selectedPath, () => {
  void nextTick(() => {
    treeEl.value
      ?.querySelector<HTMLElement>('.tree-row.selected')
      ?.scrollIntoView({ block: 'nearest' });
  });
});

// --- Row presentation ---

function statusClass(row: ExplorerRow): string | null {
  return row.entry.gitStatus ? `st-${row.entry.gitStatus}` : null;
}
</script>

<template>
  <div class="explorer">
    <aside class="tree-col">
      <div class="tree-toolbar" role="toolbar" aria-label="Explorer filters">
        <button
          class="tool-toggle mono"
          data-testid="toggle-hidden"
          :aria-pressed="showHidden"
          title="Show dotfiles"
          @click="explorer.setShowHidden(!showHidden)"
        >
          dotfiles
        </button>
        <button
          class="tool-toggle mono"
          data-testid="toggle-ignored"
          :aria-pressed="showIgnored"
          title="Show gitignored files"
          @click="explorer.setShowIgnored(!showIgnored)"
        >
          ignored
        </button>
        <button
          class="tool-toggle mono"
          data-testid="toggle-changed"
          :aria-pressed="changedOnly"
          title="Show only files with changes"
          @click="explorer.setChangedOnly(!changedOnly)"
        >
          changed
        </button>
        <button
          class="tool-refresh mono"
          data-testid="tree-refresh"
          title="Reload the tree"
          :disabled="rootLoading"
          @click="explorer.refresh()"
        >
          ↻
        </button>
      </div>

      <div class="tree-scroll">
        <p v-if="rootLoading && rows.length === 0" class="tree-note">Loading tree…</p>
        <p
          v-else-if="error && rows.length === 0"
          class="tree-note view-error"
          data-testid="tree-error"
        >
          {{ error }}
        </p>
        <p v-else-if="rows.length === 0" class="tree-note" data-testid="tree-empty">
          {{ changedOnly ? 'No changed files.' : 'Empty repository.' }}
        </p>

        <div v-else ref="treeEl" class="tree mono" role="tree" aria-label="Repository files">
          <template v-for="(row, index) in rows" :key="row.entry.path">
            <div
              class="tree-row"
              :class="[statusClass(row), { selected: row.entry.path === selectedPath }]"
              role="treeitem"
              :aria-level="row.depth + 1"
              :aria-expanded="row.entry.type === 'dir' ? row.isExpanded : undefined"
              :aria-selected="row.entry.path === selectedPath"
              :aria-busy="row.isLoading || undefined"
              :tabindex="index === tabStopIndex ? 0 : -1"
              :title="row.entry.path"
              @click="activate(row)"
              @keydown.down.prevent="moveFocus(row, 1)"
              @keydown.up.prevent="moveFocus(row, -1)"
              @keydown.right.prevent="onRight(row)"
              @keydown.left.prevent="onLeft(row)"
              @keydown.enter.prevent="activate(row)"
              @keydown.space.prevent="activate(row)"
              @keydown.home.prevent="focusRow(0)"
              @keydown.end.prevent="focusRow(rows.length - 1)"
            >
              <span v-for="n in row.depth" :key="n" class="guide" aria-hidden="true"></span>
              <span class="chevron" aria-hidden="true">{{
                row.entry.type === 'dir' ? (row.isExpanded ? '▾' : '▸') : ''
              }}</span>
              <span class="name" :class="{ dir: row.entry.type === 'dir' }">{{
                row.entry.name
              }}</span>
              <span
                v-if="row.entry.type === 'dir' && row.entry.hasChanges"
                class="changes-dot"
                title="Contains changes"
                >●</span
              >
              <span
                v-if="row.entry.type === 'file' && row.entry.staged"
                class="staged-dot"
                title="Staged"
                >●</span
              >
              <span
                v-if="row.entry.type === 'file' && row.entry.gitStatus"
                class="status-letter"
                data-testid="status-letter"
                >{{ statusLetter(row.entry.gitStatus) }}</span
              >
            </div>
            <div
              v-if="row.isExpanded && row.isLoading"
              class="tree-loading mono"
              role="presentation"
              data-testid="dir-loading"
              :style="{ paddingLeft: `${(row.depth + 1) * 1.25 + 1.75}ch` }"
            >
              Loading…
            </div>
          </template>
        </div>

        <p v-if="error && rows.length > 0" class="tree-note view-error" data-testid="tree-error">
          {{ error }}
        </p>
      </div>
    </aside>

    <section class="content-col">
      <FileContentPane :path="selectedPath" :file="file" :loading="fileLoading" :error="fileError" />
    </section>
  </div>
</template>

<style scoped>
.explorer {
  height: 100%;
  display: grid;
  grid-template-columns: clamp(14rem, 26%, 24rem) minmax(0, 1fr);
  background: var(--bg);
}

/* --- Tree column --- */

.tree-col {
  min-width: 0;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--border);
  background: var(--surface);
}

.tree-toolbar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.5rem 0.625rem;
  border-bottom: 1px solid var(--border);
}

.tool-toggle {
  padding: 0.125rem 0.5rem;
  border: 1px solid var(--border);
  border-radius: 3px;
  color: var(--text-dim);
  font-size: var(--fs-micro);
}

.tool-toggle:hover {
  border-color: var(--text-dim);
}

.tool-toggle[aria-pressed='true'] {
  color: var(--selection);
  border-color: var(--selection);
}

.tool-refresh {
  margin-left: auto;
  padding: 0.125rem 0.375rem;
  border: 1px solid transparent;
  border-radius: 3px;
  color: var(--text-dim);
  font-size: var(--fs-small);
}

.tool-refresh:hover:not(:disabled) {
  color: var(--text);
  border-color: var(--border);
}

.tree-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.tree-note {
  margin: 1rem;
  color: var(--text-dim);
  font-size: var(--fs-content);
}

.tree-note.view-error {
  color: var(--del);
  font-family: var(--font-mono);
  font-size: var(--fs-small);
}

.tree {
  padding: 0.375rem 0;
  width: max-content;
  min-width: 100%;
}

.tree-row {
  display: flex;
  align-items: center;
  width: max-content;
  min-width: 100%;
  padding: 0.125rem 0.625rem 0.125rem 0.5rem;
  border-left: 2px solid transparent;
  cursor: pointer;
  font-size: var(--fs-base);
  white-space: nowrap;
  color: var(--text);
}

.tree-row:hover {
  background: var(--surface-raised);
}

.tree-row.selected {
  background: var(--surface-raised);
  border-left-color: var(--selection);
}

.tree-row.selected .name {
  color: var(--selection);
}

/* Indent guides: one hairline per ancestor level. */
.guide {
  flex: none;
  width: 1.25ch;
  align-self: stretch;
  border-left: 1px solid var(--border);
  margin-left: 0.5ch;
}

.chevron {
  flex: none;
  width: 1.75ch;
  color: var(--text-dim);
  user-select: none;
}

.name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.name.dir {
  font-weight: 600;
}

/* Status-colored file names, VS Code style. */
.tree-row.st-modified .name {
  color: var(--status-modified);
}

.tree-row.st-added .name {
  color: var(--status-added);
}

.tree-row.st-deleted .name {
  color: var(--status-deleted);
  text-decoration: line-through;
}

.tree-row.st-untracked .name {
  color: var(--status-untracked);
}

.tree-row.st-renamed .name {
  color: var(--status-renamed);
}

.tree-row.st-copied .name {
  color: var(--status-copied);
}

.changes-dot {
  flex: none;
  margin-left: 0.75ch;
  color: var(--status-modified);
  font-size: var(--fs-micro);
}

.staged-dot {
  flex: none;
  margin-left: 0.75ch;
  color: var(--add);
  font-size: var(--fs-micro);
}

.status-letter {
  flex: none;
  margin-left: 0.75ch;
  width: 1.5ch;
  text-align: center;
  font-size: var(--fs-small);
}

.tree-row.st-modified .status-letter {
  color: var(--status-modified);
}

.tree-row.st-added .status-letter {
  color: var(--status-added);
}

.tree-row.st-deleted .status-letter {
  color: var(--status-deleted);
}

.tree-row.st-untracked .status-letter {
  color: var(--status-untracked);
}

.tree-row.st-renamed .status-letter {
  color: var(--status-renamed);
}

.tree-row.st-copied .status-letter {
  color: var(--status-copied);
}

.tree-loading {
  padding-top: 0.125rem;
  padding-bottom: 0.125rem;
  color: var(--text-dim);
  font-size: var(--fs-small);
}

/* --- Content column --- */

.content-col {
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

/* Narrow widths: stack — tree above, content below. */
@media (max-width: 44rem) {
  .explorer {
    grid-template-columns: 1fr;
    grid-template-rows: minmax(6rem, 40%) minmax(0, 1fr);
  }

  .tree-col {
    border-right: none;
    border-bottom: 1px solid var(--border);
  }
}
</style>
