<script setup lang="ts">
/**
 * Compare view: a read-only, GitHub-PR-shaped review of the current
 * branch against a base branch.
 *
 * - Top bar (persistent): base-branch selector (candidates pulled once
 *   per activation; changing it PUTs the compare config and re-pulls),
 *   the include-uncommitted toggle, and the diff-colored stats line.
 * - Commits section: collapsible, collapsed by default.
 * - PR body: file tree (left, core/view/fileTree — same collapsing tree
 *   the CLI renders) and stacked per-file diffs (right), each with a
 *   sticky header and a per-file collapse. Clicking a file selects it
 *   in the store (selectCompareFile) and scrolls its diff into view.
 *
 * Unified diffs only; side-by-side is later polish. Everything renders
 * from synchronous store state — nothing here hands the template a
 * promise.
 */

import { computed, nextTick, onMounted, reactive, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { useRepoStore } from '../stores/repo';
import { buildFileTree, flattenTree } from '@diffstalker/core/view/fileTree';
import { formatRelativeTime } from '@diffstalker/core/view/formatDate';
import type { CommitInfo } from '@diffstalker/core/git/status';
import type { CompareFileDiff } from '@diffstalker/core/git/diff';
import { statusLetter } from '../utils/format';
import DiffView from '../components/DiffView.vue';

const repo = useRepoStore();
const { compare } = storeToRefs(repo);

// Seeded from the store so the choice survives a tab switch (the ref
// itself is component-local and would otherwise reset to false).
const includeUncommitted = ref(repo.getLastIncludeUncommitted());
const candidates = ref<string[]>([]);
const commitsOpen = ref(false);
const collapsedFiles = reactive(new Set<string>());
const filesEl = ref<HTMLElement | null>(null);
const diffsEl = ref<HTMLElement | null>(null);

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
  // A compare-config PUT (not a git mutation) + re-pull.
  await repo.setCompareBaseBranch(branch, includeUncommitted.value);
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

/** fileIndexes in tree order, for keyboard navigation over file rows. */
const treeFileOrder = computed(() =>
  treeRows.value
    .filter((row) => row.type === 'file')
    .map((row) => row.fileIndex as number)
);

const selectedFileIndex = computed(() =>
  compare.value.selection.type === 'file' ? compare.value.selection.index : null
);

function selectFile(index: number): void {
  repo.selectCompareFile(index);
  const file = files.value[index];
  if (file) collapsedFiles.delete(file.path); // selecting always reveals
  void nextTick(() => {
    diffsEl.value
      ?.querySelector(`[data-file-index="${index}"]`)
      ?.scrollIntoView({ block: 'start' });
  });
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

// --- Per-file diff sections (right) ---

function toggleFileCollapsed(path: string): void {
  if (collapsedFiles.has(path)) collapsedFiles.delete(path);
  else collapsedFiles.add(path);
}

function fileStats(file: CompareFileDiff): { add: number; del: number } {
  return { add: file.additions, del: file.deletions };
}
</script>

<template>
  <div class="compare">
    <!-- Top bar: base selector + uncommitted toggle + stats. Persistent
         so a bad/missing base can always be corrected here. -->
    <header class="topbar" data-testid="compare-topbar">
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
      <!-- Commits section: collapsible, collapsed by default. -->
      <section v-if="compareDiff.commits.length > 0" class="commits-section">
        <button
          class="commits-toggle mono"
          data-testid="commits-toggle"
          :aria-expanded="commitsOpen"
          @click="commitsOpen = !commitsOpen"
        >
          <span class="chevron">{{ commitsOpen ? '▾' : '▸' }}</span>
          Commits <span class="commits-count">{{ compareDiff.commits.length }}</span>
        </button>
        <ul v-if="commitsOpen" class="commit-list mono" data-testid="compare-commits">
          <li v-for="commit in compareDiff.commits" :key="commit.hash" class="commit-row">
            <span class="hash">{{ commit.shortHash }}</span>
            <span class="message">{{ commit.message }}</span>
            <span class="meta"
              ><span class="author">{{ commit.author }}</span>
              <span class="date">{{ relTime(commit) }}</span></span
            >
          </li>
        </ul>
      </section>

      <!-- PR body: file tree | stacked per-file diffs. -->
      <div class="pr-body">
        <aside
          ref="filesEl"
          class="files-col"
          role="listbox"
          aria-label="Changed files"
          data-testid="compare-files"
        >
          <template v-for="row in treeRows" :key="`${row.type}:${row.fullPath}`">
            <!-- role=presentation: only file rows are listbox options. -->
            <div
              v-if="row.type === 'directory'"
              class="dir-row mono"
              role="presentation"
              :style="{ '--depth': row.depth }"
            >
              {{ row.name }}/
            </div>
            <div
              v-else
              class="file-row mono"
              :class="{
                selected: selectedFileIndex === row.fileIndex,
                uncommitted: files[row.fileIndex!].isUncommitted,
              }"
              :style="{ '--depth': row.depth }"
              :data-file-index="row.fileIndex"
              role="option"
              :aria-selected="selectedFileIndex === row.fileIndex"
              :tabindex="isTabStop(row.fileIndex!) ? 0 : -1"
              :title="files[row.fileIndex!].path"
              @click="selectFile(row.fileIndex!)"
              @keydown.down.prevent="moveFileSelection(1)"
              @keydown.up.prevent="moveFileSelection(-1)"
              @keydown.enter.prevent="selectFile(row.fileIndex!)"
              @keydown.space.prevent="selectFile(row.fileIndex!)"
            >
              <span class="letter" :data-status="files[row.fileIndex!].status">{{
                statusLetter(files[row.fileIndex!].status)
              }}</span>
              <span class="name">{{ row.name }}</span>
              <span
                v-if="files[row.fileIndex!].isUncommitted"
                class="uncommitted-tag"
                data-testid="uncommitted-tag"
                >[uncommitted]</span
              >
              <span class="stats">
                <span v-if="files[row.fileIndex!].additions" class="count-add"
                  >+{{ files[row.fileIndex!].additions }}</span
                >
                <span v-if="files[row.fileIndex!].deletions" class="count-del"
                  >&minus;{{ files[row.fileIndex!].deletions }}</span
                >
              </span>
            </div>
          </template>
        </aside>

        <section ref="diffsEl" class="diffs-col" data-testid="compare-diffs">
          <section
            v-for="(file, index) in files"
            :key="file.path"
            class="file-diff"
            :class="{ selected: selectedFileIndex === index }"
            :data-file-index="index"
            data-testid="file-diff"
          >
            <header class="file-diff-header" :class="{ uncommitted: file.isUncommitted }">
              <button
                class="collapse-btn mono"
                :aria-expanded="!collapsedFiles.has(file.path)"
                :aria-label="`${collapsedFiles.has(file.path) ? 'Expand' : 'Collapse'} ${file.path}`"
                @click="toggleFileCollapsed(file.path)"
              >
                {{ collapsedFiles.has(file.path) ? '▸' : '▾' }}
              </button>
              <span class="letter mono" :data-status="file.status">{{
                statusLetter(file.status)
              }}</span>
              <span class="path mono">{{ file.path }}</span>
              <span v-if="file.isUncommitted" class="uncommitted-tag mono">[uncommitted]</span>
              <span class="stats mono">
                <span v-if="fileStats(file).add" class="count-add">+{{ fileStats(file).add }}</span>
                <span v-if="fileStats(file).del" class="count-del"
                  >&minus;{{ fileStats(file).del }}</span
                >
              </span>
            </header>
            <div v-show="!collapsedFiles.has(file.path)" class="file-diff-body">
              <DiffView :diff="file.diff" :file-path="file.path" />
            </div>
          </section>
        </section>
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
  padding: 0.1875rem 0.75rem;
  padding-left: calc(0.75rem + var(--depth, 0) * 0.875rem);
  color: var(--text-dim);
  font-size: var(--fs-base);
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

/* --- Status letters (shared coloring, Changes parity) --- */

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

.diffs-col {
  min-width: 0;
  overflow-y: auto;
}

.file-diff + .file-diff {
  margin-top: 0.75rem;
}

/* Sticky per-file header inside the diffs scroller; each .file-diff
   section bounds its own header, so the next one pushes it away. */
.file-diff-header {
  position: sticky;
  top: 0;
  z-index: 4;
  display: flex;
  align-items: baseline;
  gap: 0.625rem;
  padding: 0.375rem 0.75rem;
  border-top: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
  background: var(--surface);
  font-size: var(--fs-base);
}

.file-diff-header .path {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
}

.file-diff.selected .file-diff-header .path {
  color: var(--selection);
}

.file-diff-header.uncommitted .path {
  color: var(--uncommitted);
}

.file-diff-header .stats {
  flex: none;
  margin-left: auto;
  display: inline-flex;
  gap: 0.375rem;
  font-size: var(--fs-small);
}

.collapse-btn {
  flex: none;
  width: 1.25rem;
  color: var(--text-dim);
  font-size: var(--fs-base);
  text-align: left;
}

.collapse-btn:hover {
  color: var(--text);
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
</style>
