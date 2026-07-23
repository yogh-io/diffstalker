<script setup lang="ts">
/**
 * Compare view: a read-only, GitHub-PR-shaped review of the current
 * branch against a base branch.
 *
 * - Top bar (persistent): base-branch selector (candidates pulled once
 *   per activation; changing it re-reads the compare with ?base=… —
 *   nothing is persisted daemon-side), the include-uncommitted toggle,
 *   and the diff-colored stats line.
 * - Commits section: collapsible, collapsed by default.
 * - PR body: file tree (left, core/view/fileTree — same collapsing tree
 *   the CLI renders) and stacked per-file diffs (right, the shared
 *   DiffStack — sticky headers, per-file collapse). Clicking a file
 *   selects it in the store (selectCompareFile) and jumps the stack to
 *   its diff via scrollToFile (the stack's own scroller — never
 *   scrollIntoView, which scrolls every ancestor and ignores the
 *   sticky header).
 *
 * Unified diffs only; side-by-side is later polish. Everything renders
 * from synchronous store state — nothing here hands the template a
 * promise.
 */

import { computed, nextTick, onMounted, reactive, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { useRepoStore } from '../stores/repo';
import { useUiStore } from '../stores/ui';
import { buildFileTree, flattenTree, type TreeRowItem } from '@diffstalker/core/view/fileTree';
import { formatRelativeTime } from '@diffstalker/core/view/formatDate';
import type { CommitInfo } from '@diffstalker/core/git/status';
import type { CompareFileDiff } from '@diffstalker/core/git/diff';
import { statusLetter } from '../utils/format';
import { TOP_MIN, TOP_MAX } from '../prefs';
import { usePortrait } from '../composables/useMediaQuery';
import { useSplitDrag } from '../composables/useSplitDrag';
import { makeBandKeyHandler, makePayloadKeyHandler } from '../composables/usePortraitKeys';
import DiffStack, { type StackFile } from '../components/DiffStack.vue';

const repo = useRepoStore();
const ui = useUiStore();
const { compare } = storeToRefs(repo);

// Seeded from the store so the choice survives a tab switch (the ref
// itself is component-local and would otherwise reset to false).
const includeUncommitted = ref(repo.getLastIncludeUncommitted());
const candidates = ref<string[]>([]);
const commitsOpen = ref(false);
const collapsedFiles = reactive(new Set<string>());
const filesEl = ref<HTMLElement | null>(null);
const stackEl = ref<InstanceType<typeof DiffStack> | null>(null);
/** The stack's scroll container — the portrait j/k payload target. */
const diffsEl = computed(() => stackEl.value?.scrollerEl ?? null);

onMounted(() => {
  void refreshNow();
  void loadCandidates();
});

async function refreshNow(): Promise<void> {
  await repo.refreshCompare(includeUncommitted.value);
}

async function loadCandidates(): Promise<void> {
  try {
    candidates.value = await repo.getCandidateBaseBranches();
  } catch {
    // The compare pull against the same daemon surfaces the failure; a
    // failed candidates pull just leaves the selector with the current
    // base as its only option.
    candidates.value = [];
  }
}

const compareDiff = computed(() => compare.value.compareDiff);
const files = computed(() => compareDiff.value?.files ?? []);

/** Selector options: the candidates, plus the current base if absent. */
const baseOptions = computed(() => {
  const base = compare.value.baseBranch;
  if (base !== null && !candidates.value.includes(base)) {
    return [base, ...candidates.value];
  }
  return candidates.value;
});

async function onBaseChange(event: Event): Promise<void> {
  const branch = (event.target as HTMLSelectElement).value;
  if (!branch || branch === compare.value.baseBranch) return;
  // Read-only: the pick rides the next GET /compare as ?base=… —
  // nothing is persisted daemon-side.
  await repo.setSelectedCompareBase(branch, includeUncommitted.value);
}

/**
 * Explicit :checked/@change instead of v-model: with v-model the extra
 * @change listener can run before the model updates and re-query with
 * the stale flag.
 */
async function onUncommittedToggle(event: Event): Promise<void> {
  includeUncommitted.value = (event.target as HTMLInputElement).checked;
  await repo.refreshCompare(includeUncommitted.value);
}

function relTime(commit: CommitInfo): string {
  return formatRelativeTime(commit.date.getTime());
}

// --- File tree (left) ---

/** Directory + file rows from core's collapsing tree builder. */
const treeRows = computed(() => flattenTree(buildFileTree(files.value)));

/**
 * Per-folder collapse: tree-only view state keyed by the dir row's
 * fullPath (for collapsed single-child chains that is the deepest
 * segment, which is exactly what the row carries). A stale path after
 * the file set changes just matches nothing — no reset bookkeeping.
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
    const file = files.value[row.fileIndex];
    if (file) rows.push({ ...row, type: 'file', fileIndex: row.fileIndex, file });
  }
  return rows;
});

/** fileIndexes of VISIBLE file rows in tree order, for keyboard
 *  navigation — arrow-nav must never land on a file hidden under a
 *  collapsed directory. */
const treeFileOrder = computed(() =>
  renderRows.value.flatMap((row) => (row.type === 'file' ? [row.fileIndex] : []))
);

const selectedFileIndex = computed(() =>
  compare.value.selection.type === 'file' ? compare.value.selection.index : null
);

function selectFile(index: number): void {
  repo.selectCompareFile(index);
  const file = files.value[index];
  if (!file) return;
  collapsedFiles.delete(file.path); // selecting always reveals
  void nextTick(() => stackEl.value?.scrollToFile(file.path));
}

/** The file row holding tabindex 0: the selected one, else the first. */
function isTabStop(fileIndex: number): boolean {
  const order = treeFileOrder.value;
  const selected = selectedFileIndex.value;
  if (selected !== null && order.includes(selected)) return fileIndex === selected;
  return fileIndex === order[0];
}

function moveFileSelection(delta: number): void {
  const order = treeFileOrder.value;
  if (order.length === 0) return;
  const selected = selectedFileIndex.value;
  const current = selected !== null ? order.indexOf(selected) : -1;
  let next: number;
  if (current === -1) {
    next = delta > 0 ? 0 : order.length - 1;
  } else {
    next = Math.min(order.length - 1, Math.max(0, current + delta));
  }
  selectFile(order[next]);
  void nextTick(() => {
    filesEl.value
      ?.querySelector<HTMLElement>(`.file-row[data-file-index="${order[next]}"]`)
      ?.focus();
  });
}

// --- Per-file diff sections (right, DiffStack) ---

function toggleFileCollapsed(path: string): void {
  if (collapsedFiles.has(path)) collapsedFiles.delete(path);
  else collapsedFiles.add(path);
}

/** Compare files mapped onto the stack's shape; keyed by path (unique
 *  within a compare — no staged/unstaged split here). Diffs are
 *  pre-embedded, so the stack's placeholder branch never triggers. */
const stackFiles = computed<StackFile[]>(() =>
  files.value.map((file) => ({
    key: file.path,
    path: file.path,
    status: file.status,
    uncommitted: file.isUncommitted,
    stats: { insertions: file.additions, deletions: file.deletions },
    diff: file.diff,
    collapsed: collapsedFiles.has(file.path),
  }))
);

const activeStackKey = computed(() => {
  const index = selectedFileIndex.value;
  return index !== null ? (files.value[index]?.path ?? null) : null;
});

// --- Portrait: rotate the PR body (file band above, diffs below) ---
//
// The top file band acts as a JUMP-INDEX: clicking a file anchor-scrolls
// the stacked diffs to its sticky header (selectFile above — same code
// path as landscape; it never filters to one file).

const isPortrait = usePortrait();
const prBodyEl = ref<HTMLElement | null>(null);
const split = useSplitDrag({
  container: prBodyEl,
  isRow: isPortrait,
  row: { pref: 'compareTop', defaultRatio: 0.22, min: TOP_MIN, max: TOP_MAX },
});

const onRowBandKeydown = makeBandKeyHandler(isPortrait, moveFileSelection);
// The stack's root is the diffs scroller — scroll it, not a nested DiffView.
const onPayloadKeydown = makePayloadKeyHandler(isPortrait, diffsEl, { self: true });
</script>

<template>
  <div
    class="compare"
    :class="{ portrait: isPortrait }"
    :style="isPortrait ? { '--compare-top': `${(split.rowRatio.value * 100).toFixed(2)}%` } : undefined"
  >
    <!-- Top bar: base selector + uncommitted toggle + stats. Persistent
         so a bad/missing base can always be corrected here. In portrait
         the base picker lifts into the tab band's toolbar slot. defer:
         resolve the target after the render tick, so a mount that races
         the slot cannot strand the children (crash-class: later patches
         would run against null els). -->
    <header class="topbar" data-testid="compare-topbar">
      <Teleport defer to="#view-toolbar-slot" :disabled="!isPortrait">
        <label class="base-select">
          <span class="label">base</span>
          <select
            class="mono"
            data-testid="base-select"
            aria-label="Base branch"
            :value="compare.baseBranch ?? ''"
            @change="onBaseChange"
          >
            <option v-if="compare.baseBranch === null" value="" disabled>pick a base…</option>
            <option v-for="branch in baseOptions" :key="branch" :value="branch">
              {{ branch }}
            </option>
          </select>
        </label>
      </Teleport>

      <label class="uncommitted-toggle">
        <input
          type="checkbox"
          data-testid="uncommitted-toggle"
          :checked="includeUncommitted"
          @change="onUncommittedToggle"
        />
        <span>include uncommitted</span>
      </label>

      <p v-if="compareDiff" class="stats mono" data-testid="compare-stats">
        <span class="files-changed"
          >{{ compareDiff.stats.filesChanged }}
          {{ compareDiff.stats.filesChanged === 1 ? 'file' : 'files' }} changed</span
        >
        <span class="count-add">+{{ compareDiff.stats.additions }}</span>
        <span class="count-del">&minus;{{ compareDiff.stats.deletions }}</span>
      </p>
    </header>

    <!-- A transient refresh error must not blank a loaded compare: the
         store keeps compareDiff, so keep rendering it under a banner. -->
    <p
      v-if="compare.error && compareDiff"
      class="state-line view-error error-banner"
      data-testid="compare-error-banner"
    >
      {{ compare.error }}
    </p>

    <!-- Body states -->
    <p v-if="compare.error && !compareDiff" class="state-line view-error" data-testid="compare-error">
      {{ compare.error }}
    </p>
    <div v-else-if="compare.noBaseBranch" class="state-block" data-testid="no-base-branch">
      <p class="state-title">No base branch detected.</p>
      <p class="state-hint">
        Base detection uses remote refs (like origin/main) — this repo has none that qualify.
        Pick a base branch above to compare against.
      </p>
    </div>
    <p v-else-if="compare.loading && !compareDiff" class="state-line" data-testid="compare-loading">
      Loading compare…
    </p>
    <p
      v-else-if="compareDiff && files.length === 0"
      class="state-line"
      data-testid="compare-clean"
    >
      No changes compared to {{ compareDiff.baseBranch }}.
    </p>

    <template v-else-if="compareDiff">
      <!-- Commits section: collapsible, collapsed by default. In
           portrait the toggle lifts into the tab band's toolbar slot;
           the list itself stays here when open. -->
      <section v-if="compareDiff.commits.length > 0" class="commits-section">
        <Teleport defer to="#view-toolbar-slot" :disabled="!isPortrait">
          <button
            class="commits-toggle mono"
            data-testid="commits-toggle"
            :aria-expanded="commitsOpen"
            @click="commitsOpen = !commitsOpen"
          >
            <span class="chevron">{{ commitsOpen ? '▾' : '▸' }}</span>
            Commits <span class="commits-count">{{ compareDiff.commits.length }}</span>
          </button>
        </Teleport>
        <ul v-if="commitsOpen" class="commit-list mono" data-testid="compare-commits">
          <li v-for="commit in compareDiff.commits" :key="commit.hash" class="commit-row">
            <span class="hash">{{ commit.shortHash }}</span>
            <span class="message" :title="commit.message">{{ commit.message }}</span>
            <span class="meta"
              ><span class="author">{{ commit.author }}</span>
              <span class="date">{{ relTime(commit) }}</span></span
            >
          </li>
        </ul>
      </section>

      <!-- PR body: file tree | stacked per-file diffs (portrait: file
           band above as a jump-index, full-width diffs below). -->
      <div ref="prBodyEl" class="pr-body">
        <aside
          ref="filesEl"
          class="files-col"
          role="listbox"
          aria-label="Changed files"
          data-testid="compare-files"
        >
          <template v-for="row in renderRows" :key="`${row.type}:${row.fullPath}`">
            <!-- role=presentation: only file rows are listbox options.
                 The whole row toggles; the button is the a11y surface
                 (aria-expanded + native Enter/Space activation). -->
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
              class="file-row mono"
              :class="{
                selected: selectedFileIndex === row.fileIndex,
                uncommitted: row.file.isUncommitted,
              }"
              :style="{ '--depth': row.depth }"
              :data-file-index="row.fileIndex"
              role="option"
              :aria-selected="selectedFileIndex === row.fileIndex"
              :tabindex="isTabStop(row.fileIndex) ? 0 : -1"
              :title="row.file.path"
              @click="selectFile(row.fileIndex)"
              @keydown.down.prevent="moveFileSelection(1)"
              @keydown.up.prevent="moveFileSelection(-1)"
              @keydown.enter.prevent="selectFile(row.fileIndex)"
              @keydown.space.prevent="selectFile(row.fileIndex)"
              @keydown="onRowBandKeydown"
            >
              <span class="letter" :data-status="row.file.status">{{
                statusLetter(row.file.status)
              }}</span>
              <span class="name">{{ row.name }}</span>
              <span
                v-if="row.file.isUncommitted"
                class="uncommitted-tag"
                data-testid="uncommitted-tag"
                >[uncommitted]</span
              >
              <span class="stats">
                <span v-if="row.file.additions" class="count-add"
                  >+{{ row.file.additions }}</span
                >
                <span v-if="row.file.deletions" class="count-del"
                  >&minus;{{ row.file.deletions }}</span
                >
              </span>
            </div>
          </template>
        </aside>

        <div
          v-if="isPortrait"
          class="row-resizer"
          role="separator"
          :aria-orientation="split.ariaOrientation.value"
          aria-label="Resize file list"
          :aria-valuenow="split.ariaValueNow.value"
          :aria-valuemin="split.ariaValueMin.value"
          :aria-valuemax="split.ariaValueMax.value"
          tabindex="0"
          @pointerdown="split.onPointerDown"
          @pointermove="split.onPointerMove"
          @pointerup="split.onPointerUp"
          @pointercancel="split.onPointerCancel"
          @keydown="split.onKeydown"
        ></div>

        <DiffStack
          ref="stackEl"
          class="diffs-col"
          data-testid="compare-diffs"
          :files="stackFiles"
          :active-key="activeStackKey"
          :syntax="ui.diffSyntaxEnabled"
          :mode="ui.diffMode"
          :tabindex="isPortrait ? 0 : undefined"
          :role="isPortrait ? 'region' : undefined"
          :aria-label="isPortrait ? 'File diffs' : undefined"
          @toggle-collapse="toggleFileCollapsed"
          @keydown="onPayloadKeydown"
        />
      </div>
    </template>
  </div>
</template>

<style scoped>
.compare {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg);
}

/* --- Top bar --- */

.topbar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 1.25rem;
  padding: 0.5rem 0.75rem;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
  flex-wrap: wrap;
}

.base-select {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
}

.base-select .label {
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--text-dim);
}

.base-select select {
  font-size: var(--fs-base);
  color: var(--text);
  background: var(--surface-raised);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0.25rem 0.375rem;
}

.uncommitted-toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  font-size: var(--fs-small);
  color: var(--text-dim);
  cursor: pointer;
}

.uncommitted-toggle input {
  accent-color: var(--selection);
}

.topbar .stats {
  display: inline-flex;
  gap: 0.625rem;
  margin: 0 0 0 auto;
  font-size: var(--fs-small);
}

.files-changed {
  color: var(--text);
}

/* --- Body states --- */

.state-line {
  margin: 1rem;
  color: var(--text-dim);
  font-size: var(--fs-content);
}

/* Defined after .state-line so its margin/padding overrides win. */
.error-banner {
  flex: none;
  margin: 0;
  padding: 0.375rem 0.75rem;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
}

.state-block {
  margin: 2.5rem auto;
  max-width: 34rem;
  padding: 0 1rem;
  text-align: center;
}

.state-title {
  margin: 0 0 0.375rem;
  font-size: var(--fs-title);
  font-weight: 600;
}

.state-hint {
  margin: 0;
  color: var(--text-dim);
  font-size: var(--fs-content);
}

/* --- Commits section --- */

.commits-section {
  flex: none;
  border-bottom: 1px solid var(--border);
  max-height: 40%;
  overflow-y: auto;
  background: var(--surface);
}

.commits-toggle {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  width: 100%;
  padding: 0.375rem 0.75rem;
  font-size: var(--fs-micro);
  font-weight: 500;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--text-dim);
  text-align: left;
}

.commits-toggle:hover {
  color: var(--text);
}

.chevron {
  width: 1ch;
}

.commits-count {
  opacity: 0.8;
}

.commit-list {
  list-style: none;
  margin: 0;
  padding: 0 0 0.375rem;
  font-size: var(--fs-base);
}

.commit-row {
  display: flex;
  align-items: baseline;
  gap: 0.625rem;
  min-width: 0;
  padding: 0.1875rem 0.75rem 0.1875rem 2rem;
}

.commit-row .hash {
  flex: none;
  color: var(--selection);
}

.commit-row .message {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.commit-row .meta {
  flex: none;
  margin-left: auto;
  display: inline-flex;
  gap: 0.5rem;
  font-size: var(--fs-small);
  color: var(--text-dim);
}

/* --- PR body --- */

.pr-body {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: clamp(12rem, 28%, 24rem) minmax(0, 1fr);
}

/* --- File tree (left) --- */

.files-col {
  min-width: 0;
  overflow-y: auto;
  border-right: 1px solid var(--border);
  background: var(--surface);
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
  border-left: 2px solid transparent;
  cursor: pointer;
}

.file-row:hover {
  background: var(--surface-raised);
}

.file-row.selected {
  background: var(--surface-raised);
  border-left-color: var(--selection);
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

.file-row .stats {
  flex: none;
  margin-left: auto;
  display: inline-flex;
  gap: 0.375rem;
  font-size: var(--fs-small);
}

/* --- Status letters (tree rows; DiffStack colors its own) --- */

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

.letter[data-status='renamed'] {
  color: var(--status-renamed);
}

.uncommitted-tag {
  flex: none;
  color: var(--uncommitted);
  font-size: var(--fs-micro);
}

/* --- Stacked per-file diffs (right) --- */

/* Grid placement only — the stack itself (scroller, sticky headers,
   collapse) lives in DiffStack; this scoped rule reaches its root via
   the parent-scope attribute Vue puts on a child component's root. */
.diffs-col {
  min-width: 0;
}

/* Narrow widths: stack — files above, diffs below. */
@media (max-width: 44rem) {
  .pr-body {
    grid-template-columns: 1fr;
    grid-template-rows: minmax(6rem, 32%) minmax(0, 1fr);
  }

  .files-col {
    border-right: none;
    border-bottom: 1px solid var(--border);
  }
}

/* Portrait: rotate ONLY the nested PR body — topbar and the (open)
   commits list keep stacking above it. The file band on top is a
   jump-index over the full-width stacked diffs; base picker + commits
   toggle live in the tab band (Teleport — they keep this component's
   scope, so the in-band restyles below reach them). */
@media (orientation: portrait), (max-aspect-ratio: 1/1), (max-width: 1080px) {
  .pr-body {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: minmax(4rem, var(--compare-top, 22vh)) 6px minmax(0, 1fr);
  }

  .files-col {
    border-right: none;
    border-bottom: 1px solid var(--border);
  }

  .row-resizer {
    height: 6px;
    cursor: row-resize;
    background: transparent;
    touch-action: none;
  }

  .row-resizer:hover,
  .row-resizer:focus-visible {
    background: var(--selection);
    opacity: 0.5;
  }

  /* In-band restyles for the lifted controls. */
  .commits-toggle {
    width: auto;
    padding: 0.25rem 0.5rem;
    border: 1px solid var(--border);
    border-radius: 4px;
  }

  /* The toggle is out of the section: no empty strip when collapsed. */
  .commits-section {
    background: transparent;
    border-bottom: none;
  }

  .commit-list {
    background: var(--surface);
    border-bottom: 1px solid var(--border);
  }
}
</style>
