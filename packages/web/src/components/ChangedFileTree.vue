<script lang="ts">
import { buildFileTree, flattenTree } from '@diffstalker/core/view/fileTree';

/**
 * Every file in TREE order: the same order, and the same directory
 * grouping, the tree shows. The daemon returns files in git's flat path
 * sort, which differs from the tree the moment a directory holds both
 * sub-directories and loose files (the tree puts `src/bootstrap/…` before
 * `src/app.ts`; a flat sort interleaves them). A diff stack built in this
 * order reads like walking the tree.
 *
 * Built from ALL rows, not the visible ones: collapsing a directory is a
 * navigation affordance for the tree, and must never reorder the diffs or
 * drop a file's diff out of the stack.
 */
export function inTreeOrder<T extends { path: string }>(files: T[]): T[] {
  return flattenTree(buildFileTree(files)).flatMap((row) => {
    if (row.type !== 'file' || row.fileIndex === undefined) return [];
    const file = files[row.fileIndex];
    return file ? [file] : [];
  });
}
</script>

<script setup lang="ts">
/**
 * ChangedFileTree: the collapsing tree of changed files beside a diff
 * stack. Compare lists a branch's files in it; History lists one commit's.
 *
 * Owns only tree-local state: which directories are collapsed, keyboard
 * movement between visible rows, and keeping the selected row in view.
 * Selection itself belongs to the parent, as an index into `files`:
 *
 * - `activate` — a row clicked or confirmed (Enter/Space), the deliberate
 *   landing;
 * - `select` — arrow keys (or j/k in the portrait band) moved onto a row.
 *
 * Arrow movement never lands on a file hidden under a collapsed directory.
 */
import { computed, nextTick, reactive, ref, toRef } from 'vue';
import type { TreeRowItem } from '@diffstalker/core/view/fileTree';
import type { CompareFileDiff } from '@diffstalker/core/git/diff';
import { statusLetter } from '../utils/format';
import { nextIndex } from '../utils/listNav';
import { makeBandKeyHandler } from '../composables/usePortraitKeys';
import { useActiveRowScroll } from '../composables/useActiveRowScroll';
import type { UncommittedSide } from '@diffstalker/core/types/compare';

const props = defineProps<{
  files: CompareFileDiff[];
  selectedIndex: number | null;
  /** Stacked layout: j/k move the selection like the arrow keys. */
  portrait: boolean;
}>();

const emit = defineEmits<{
  activate: [index: number];
  select: [index: number];
}>();

const rootEl = ref<HTMLElement | null>(null);

/** Directory + file rows from core's collapsing tree builder. */
const treeRows = computed(() => flattenTree(buildFileTree(props.files)));

/**
 * Per-folder collapse, keyed by the dir row's fullPath (for collapsed
 * single-child chains that is the deepest segment, which is exactly what
 * the row carries). A stale path after the file set changes just matches
 * nothing — no reset bookkeeping.
 */
const collapsedDirs = reactive(new Set<string>());

function setDirCollapsed(fullPath: string, collapsed: boolean): void {
  if (collapsed) collapsedDirs.add(fullPath);
  else collapsedDirs.delete(fullPath);
}

function toggleDir(fullPath: string): void {
  setDirCollapsed(fullPath, !collapsedDirs.has(fullPath));
}

/**
 * treeRows minus everything inside a collapsed directory. flattenTree
 * is DFS: a dir is immediately followed by its descendants at greater
 * depth, so a collapsed dir at depth D hides all subsequent rows with
 * depth > D until the next row at depth <= D.
 */
const visibleRows = computed(() => {
  const rows: TreeRowItem[] = [];
  let hideDeeperThan: number | null = null;
  for (const row of treeRows.value) {
    if (hideDeeperThan !== null) {
      if (row.depth > hideDeeperThan) continue;
      hideDeeperThan = null;
    }
    rows.push(row);
    if (row.type === 'directory' && collapsedDirs.has(row.fullPath)) {
      hideDeeperThan = row.depth;
    }
  }
  return rows;
});

/** A visible tree row, with each file row's file resolved once so the
 *  template never indexes files[] (and needs no non-null assertions). */
type RenderRow =
  | (TreeRowItem & { type: 'directory' })
  | (TreeRowItem & { type: 'file'; fileIndex: number; file: CompareFileDiff });

const renderRows = computed<RenderRow[]>(() => {
  const rows: RenderRow[] = [];
  for (const row of visibleRows.value) {
    if (row.type === 'directory') {
      rows.push({ ...row, type: 'directory' });
      continue;
    }
    if (row.fileIndex === undefined) continue;
    const file = props.files[row.fileIndex];
    if (file) rows.push({ ...row, type: 'file', fileIndex: row.fileIndex, file });
  }
  return rows;
});

/** fileIndexes of VISIBLE file rows in tree order, for keyboard movement. */
const visibleOrder = computed(() =>
  renderRows.value.flatMap((row) => (row.type === 'file' ? [row.fileIndex] : []))
);

/**
 * The tag an uncommitted row carries (Compare only). It names the SIDE,
 * not just the fact of being uncommitted: with the categories controlled
 * separately, "which of these three is this row" is the question the tag
 * has to answer. `both` is staged and unstaged read together as one diff.
 */
function sideTag(side: UncommittedSide): string {
  return side === 'both' ? '[uncommitted]' : `[${side}]`;
}

/**
 * The file row holding tabindex 0: the selected one, else the first. One
 * membership scan per change, not one per row — the template compares
 * indices, so the tree renders in O(n), not O(n²).
 */
const tabStopIndex = computed<number | null>(() => {
  const order = visibleOrder.value;
  const selected = props.selectedIndex;
  if (selected !== null && order.includes(selected)) return selected;
  return order[0] ?? null;
});

function fileRowEl(index: number): HTMLElement | null {
  return rootEl.value?.querySelector<HTMLElement>(`.file-row[data-file-index="${index}"]`) ?? null;
}

function move(delta: number): void {
  const order = visibleOrder.value;
  const selected = props.selectedIndex;
  const current = selected !== null ? order.indexOf(selected) : -1;
  const next = nextIndex(current, delta, order.length);
  if (next === -1) return;
  emit('select', order[next]);
  void nextTick(() => fileRowEl(order[next])?.focus());
}

const onBandKeydown = makeBandKeyHandler(toRef(props, 'portrait'), move);

/** Keep the selected row visible (see useActiveRowScroll). */
const { onPointerEnter, onPointerLeave } = useActiveRowScroll(
  rootEl,
  () => props.selectedIndex,
  () => (props.selectedIndex === null ? null : fileRowEl(props.selectedIndex))
);
</script>

<template>
  <aside
    ref="rootEl"
    class="files-col"
    role="listbox"
    aria-label="Changed files"
    @pointerenter="onPointerEnter"
    @pointerleave="onPointerLeave"
  >
    <!-- fileIndex is in the key: two rows can carry the same fullPath (a
         Compare file both committed and uncommitted). -->
    <template v-for="row in renderRows" :key="`${row.type}:${row.fullPath}:${row.fileIndex}`">
      <!-- role=presentation: only file rows are listbox options. The whole
           row toggles; the button is the a11y surface (aria-expanded +
           native Enter/Space activation). -->
      <div
        v-if="row.type === 'directory'"
        class="dir-row mono"
        role="presentation"
        :style="{ '--depth': row.depth }"
        @click="toggleDir(row.fullPath)"
      >
        <button
          class="dir-collapse-btn"
          :aria-expanded="!collapsedDirs.has(row.fullPath)"
          :aria-label="`${collapsedDirs.has(row.fullPath) ? 'Expand' : 'Collapse'} ${row.fullPath}`"
          @click.stop="toggleDir(row.fullPath)"
          @keydown.enter.prevent="toggleDir(row.fullPath)"
          @keydown.space.prevent="toggleDir(row.fullPath)"
          @keydown.left.prevent="setDirCollapsed(row.fullPath, true)"
          @keydown.right.prevent="setDirCollapsed(row.fullPath, false)"
        >
          {{ collapsedDirs.has(row.fullPath) ? '▸' : '▾' }}
        </button>
        <span class="dir-name" :title="row.fullPath">{{ row.name }}/</span>
      </div>
      <div
        v-else
        class="file-row mono list-row"
        :class="{
          selected: selectedIndex === row.fileIndex,
          uncommitted: row.file.uncommitted !== undefined,
        }"
        :style="{ '--depth': row.depth }"
        :data-file-index="row.fileIndex"
        role="option"
        :aria-selected="selectedIndex === row.fileIndex"
        :tabindex="row.fileIndex === tabStopIndex ? 0 : -1"
        :title="row.file.path"
        @click="emit('activate', row.fileIndex)"
        @keydown.down.prevent="move(1)"
        @keydown.up.prevent="move(-1)"
        @keydown.enter.prevent="emit('activate', row.fileIndex)"
        @keydown.space.prevent="emit('activate', row.fileIndex)"
        @keydown="onBandKeydown"
      >
        <span class="letter" :data-status="row.file.status">{{
          statusLetter(row.file.status)
        }}</span>
        <span class="name">{{ row.name }}</span>
        <span v-if="row.file.uncommitted" class="uncommitted-tag" data-testid="uncommitted-tag">{{
          sideTag(row.file.uncommitted)
        }}</span>
        <span class="row-stats">
          <span v-if="row.file.additions" class="count-add">+{{ row.file.additions }}</span>
          <span v-if="row.file.deletions" class="count-del">&minus;{{ row.file.deletions }}</span>
        </span>
      </div>
    </template>
  </aside>
</template>

<style scoped>
/* Shared panel surface lives in style.css; only the block padding is local. */
.files-col {
  padding: 0.375rem 0;
}

.dir-row {
  display: flex;
  align-items: baseline;
  padding: 0.1875rem 0.75rem;
  padding-left: calc(0.75rem + var(--depth, 0) * 0.875rem);
  color: var(--text-dim);
  font-size: var(--fs-base);
  cursor: pointer;
}

.dir-row:hover {
  color: var(--text);
}

/* Explorer-chevron styling: mono, muted, fixed 1-glyph slot. */
.dir-collapse-btn {
  flex: none;
  width: 1.75ch;
  font-family: var(--font-mono);
  font-size: var(--fs-base);
  color: var(--text-dim);
  text-align: left;
  user-select: none;
}

.dir-row:hover .dir-collapse-btn,
.dir-collapse-btn:hover {
  color: var(--text);
}

.dir-name {
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.file-row {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  padding: 0.1875rem 0.75rem;
  padding-left: calc(0.75rem + var(--depth, 0) * 0.875rem);
  font-size: var(--fs-base);
}

.file-row .name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
}

.file-row.selected .name {
  color: var(--selection);
}

.file-row.uncommitted .name {
  color: var(--uncommitted);
}
</style>
