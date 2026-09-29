<script setup lang="ts">
/**
 * History view, read-only: commit list | the selected commit's changed
 * files | their diffs. The right two columns are the same file tree and
 * diff stack Compare uses — a commit reads like a one-commit Compare.
 *
 * Stacked (portrait/narrow) layout: the two lists share the top band side
 * by side, and the diffs get the full width below. Lists are narrow
 * content; the diff is the one that needs the width.
 *
 * On first activation the list loads via repo.loadHistory() (skipped
 * when a previous visit already loaded it — the store re-pulls on
 * state-change anyway). Selecting a commit calls selectHistoryCommit
 * with the EXACT CommitInfo object (the row highlight compares by
 * identity); the store then pulls the commit's per-file rows.
 *
 * "Load more" raises the requested count by a page and re-pulls; it
 * hides once the log comes back short (nothing more to load).
 */

import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { beginUserNav } from '../composables/useUrlSync';
import { useRepoStore } from '../stores/repo';
import { useUiStore } from '../stores/ui';
import { formatRelativeTime, formatDateAbsolute } from '@diffstalker/core/view/formatDate';
import type { CommitInfo } from '@diffstalker/core/git/status';
import { TOP_MIN, TOP_MAX } from '../prefs';
import { nextIndex } from '../utils/listNav';
import { usePortrait } from '../composables/useMediaQuery';
import { useSplitDrag } from '../composables/useSplitDrag';
import { makeBandKeyHandler, portraitPayloadAttrs } from '../composables/usePortraitKeys';
import SplitResizer from '../components/SplitResizer.vue';
import DiffStack, { type StackFile } from '../components/DiffStack.vue';
import ChangedFileTree, { inTreeOrder } from '../components/ChangedFileTree.vue';
import { errorMessage } from '../api/errors';

const PAGE_SIZE = 100;

const repo = useRepoStore();
const ui = useUiStore();
const { history } = storeToRefs(repo);

const loadError = ref<string | null>(null);
/** Error from a rejected commit-diff load, shown in the detail pane. */
const detailError = ref<string | null>(null);
// Seed from what a previous visit already loaded, so a remount's
// "Load more" keeps paging forward instead of re-requesting page one.
const requestedCount = ref(Math.max(PAGE_SIZE, repo.history.commits.length));
const listEl = ref<HTMLElement | null>(null);

const commits = computed(() => history.value.commits);
const selected = computed(() => history.value.selectedCommit);

// --- The selected commit's files: tree (middle) + diff stack (right) ---

const commitFiles = computed(() => history.value.commitFiles ?? []);

/** Stack section key: the commit plus the file. It doubles as the
 *  whole-file slot key, which must not collide with the same path in
 *  another view or another commit (App.vue restores it from a link). */
function historyFileKey(path: string): string {
  return `h:${selected.value?.hash ?? ''}:${path}`;
}

/** Index into commitFiles; per commit, so a new commit starts at its top. */
const selectedFileIndex = ref<number | null>(null);
const collapsedFiles = reactive(new Set<string>());
const stackEl = ref<InstanceType<typeof DiffStack> | null>(null);
/** The stack's scroll container — the portrait j/k payload target. */
const diffsEl = computed(() => stackEl.value?.scrollerEl ?? null);

/**
 * Select the top file the moment a commit's files land, so the focus
 * indicator is there from the start (it is where the stack already sits).
 * The top of the TREE, not files[0]: the daemon sorts flat by path, the
 * tree puts folders first.
 */
watch(
  () => history.value.commitFiles,
  (files) => {
    const top = files ? inTreeOrder(files)[0] : undefined;
    selectedFileIndex.value = top && files ? files.indexOf(top) : null;
  },
  { immediate: true }
);

/**
 * No merge-commit case is needed in the ref pair. The daemon returns no
 * rows for a merge (we do not render combined diffs), so there is no file
 * section to label.
 */
const stackFiles = computed<StackFile[]>(() => {
  const commit = selected.value;
  if (!commit) return [];
  return inTreeOrder(commitFiles.value).map((file) => {
    const key = historyFileKey(file.path);
    return {
      key,
      path: file.path,
      status: file.status,
      stats: { insertions: file.additions, deletions: file.deletions },
      diff: repo.wholeFile?.key === key ? repo.wholeFile.diff : file.diff,
      collapsed: collapsedFiles.has(key),
      refPair: { kind: 'commit', shortHash: commit.shortHash },
    };
  });
});

const activeStackKey = computed(() => {
  const file = selectedFileIndex.value === null ? undefined : commitFiles.value[selectedFileIndex.value];
  return file ? historyFileKey(file.path) : null;
});

/** A file row clicked or confirmed: jump the stack to its diff. */
function selectFile(index: number): void {
  const file = commitFiles.value[index];
  if (!file) return;
  selectedFileIndex.value = index;
  const key = historyFileKey(file.path);
  collapsedFiles.delete(key); // selecting always reveals
  void nextTick(() => stackEl.value?.scrollToFile(key));
}

/** Stack scroll-spy: the diffs scrolled onto a file. Records it only —
 *  selectFile would scroll the stack back and loop. */
function onActiveFile(key: string): void {
  const index = commitFiles.value.findIndex((f) => historyFileKey(f.path) === key);
  if (index !== -1) selectedFileIndex.value = index;
}

function toggleFileCollapsed(key: string): void {
  if (collapsedFiles.has(key)) collapsedFiles.delete(key);
  else collapsedFiles.add(key);
}

/** `e`: mount every body the size gate holds back, so Ctrl+F reaches it. */
watch(
  () => ui.expandGatedRequest,
  (seq) => {
    if (seq === 0) return;
    stackEl.value?.expandAllGated();
  }
);

/**
 * Whole-file mode for one file in the shown commit. This is the surface
 * where it matters most: "view file" opens TODAY's copy of the path,
 * which is different bytes than a historical diff is about, so it was
 * never an answer here.
 */
// A different commit invalidates the slot: its key names the commit, and
// the file may not even appear in the new one.
watch(selected, (commit, previous) => {
  if (previous && commit?.hash !== previous.hash && repo.wholeFile !== null) {
    void repo.setWholeFile(null);
  }
});

function toggleWholeFile(key: string): void {
  const commit = selected.value;
  const file = commitFiles.value.find((f) => historyFileKey(f.path) === key);
  if (!commit || !file) return;
  if (repo.wholeFile?.key === key) {
    void repo.setWholeFile(null);
    return;
  }
  beginUserNav({ view: 'history' });
  void repo.setWholeFile({ view: 'history', key, path: file.path, hash: commit.hash });
}

/** The log filled the requested page — more commits may exist. */
const mayHaveMore = computed(() => commits.value.length >= requestedCount.value);

/** The count of the most recent load attempt — what a retry re-runs. */
let lastAttemptedCount = requestedCount.value;

/** loadHistory rejects a DaemonError to the caller; catch it here. */
async function load(count: number): Promise<void> {
  loadError.value = null;
  lastAttemptedCount = count;
  try {
    await repo.loadHistory(count);
    // Raised only on success: during the pull the load-more button keeps
    // its visible "Loading…" state, and after a failure it reappears.
    requestedCount.value = count;
  } catch (err) {
    loadError.value = errorMessage(err);
  }
}

function retryLoad(): void {
  void load(lastAttemptedCount);
}

onMounted(() => {
  if (commits.value.length === 0 && !history.value.isLoading) {
    void load(PAGE_SIZE);
  }
});

/** Hash of the last commit the user picked, for re-anchoring. */
const lastSelectedHash = ref<string | null>(null);

/**
 * selectHistoryCommit rejects a DaemonError (e.g. the commit was rebased
 * away between the list pull and the click) — catch it into a calm
 * detail-pane line instead of leaving "Loading diff…" hanging.
 * Connection errors resolve quietly (the store owns the reconnect line).
 */
/** A commit row clicked or confirmed — the deliberate landing. */
function activateCommit(commit: CommitInfo): void {
  beginUserNav({ view: 'history' });
  void select(commit);
}

async function select(commit: CommitInfo): Promise<void> {
  detailError.value = null;
  lastSelectedHash.value = commit.hash;
  try {
    await repo.selectHistoryCommit(commit);
  } catch (err) {
    detailError.value = `Failed to load commit diff: ${errorMessage(err)}`;
  }
}

/**
 * The store's reload (on every state-change) mints new commit objects and
 * drops the selection. Re-anchor by hash so the open detail survives a
 * working-tree change; a hash that vanished (rebased away) falls back to
 * the prompt. Watching the commits ARRAY (identity) can't loop: selecting
 * replaces the history object but never the commits array.
 */
watch(commits, (newCommits) => {
  const hash = lastSelectedHash.value;
  if (hash === null || selected.value !== null) return;
  const match = newCommits.find((c) => c.hash === hash);
  if (match) {
    void select(match);
  } else {
    lastSelectedHash.value = null;
  }
});

/** Ref/branch tags ("HEAD -> main, origin/main, tag: v1.0") as chips. */
function refTags(commit: CommitInfo): string[] {
  if (!commit.refs) return [];
  return commit.refs
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function relTime(commit: CommitInfo): string {
  return formatRelativeTime(commit.date.getTime());
}

// --- Keyboard selection (roving tabindex, same pattern as Changes) ---

/** The row that holds tabindex 0: the selected one, else the first. */
function isTabStop(commit: CommitInfo, index: number): boolean {
  const current = selected.value;
  if (current && commits.value.includes(current)) return commit === current;
  return index === 0;
}

function moveSelection(delta: number): void {
  const list = commits.value;
  const current = selected.value ? list.indexOf(selected.value) : -1;
  const next = nextIndex(current, delta, list.length);
  if (next === -1) return;
  void select(list[next]);
  void nextTick(() => {
    listEl.value?.querySelectorAll<HTMLElement>('.commit-row')[next]?.focus();
  });
}

// --- Portrait: row split (both lists above, diffs below) + j/k keys ---

const isPortrait = usePortrait();
const containerEl = ref<HTMLElement | null>(null);
const split = useSplitDrag({
  container: containerEl,
  isRow: isPortrait,
  row: { pref: 'historyTop', defaultRatio: 0.28, min: TOP_MIN, max: TOP_MAX },
});

const onRowBandKeydown = makeBandKeyHandler(isPortrait, moveSelection);
// The stack's root is the diffs scroller — scroll it, not a nested DiffView.
const payloadAttrs = portraitPayloadAttrs(isPortrait, diffsEl, 'Commit diff', { self: true });

/** Enter on a row: select; in portrait also hand focus to the payload. */
function selectAndFocusPayload(commit: CommitInfo): void {
  void select(commit);
  if (!isPortrait.value) return;
  void nextTick(() => diffsEl.value?.focus());
}
</script>

<template>
  <div
    ref="containerEl"
    class="history"
    :class="{ portrait: isPortrait }"
    :style="isPortrait ? { '--history-top': `${(split.rowRatio.value * 100).toFixed(2)}%` } : undefined"
  >
    <aside class="commits-col" aria-label="Commit history">
      <p v-if="history.isLoading && commits.length === 0" class="panel-note">Loading history…</p>
      <!-- Full-pane error only when there is nothing to show; with commits
           loaded a failed re-pull stays a small inline line below the list. -->
      <p v-else-if="loadError && commits.length === 0" class="panel-note view-error">
        {{ loadError }}
      </p>
      <p v-else-if="commits.length === 0" class="panel-note" data-testid="history-empty">
        No commits yet.
      </p>

      <template v-else>
        <div
          ref="listEl"
          class="commit-list"
          data-testid="commit-list"
          role="listbox"
          aria-label="Commits"
        >
          <div
            v-for="(commit, index) in commits"
            :key="commit.hash"
            class="commit-row list-row"
            :class="{ selected: commit === selected }"
            role="option"
            :aria-selected="commit === selected"
            :tabindex="isTabStop(commit, index) ? 0 : -1"
            :title="commit.hash"
            @click="activateCommit(commit)"
            @keydown.down.prevent="moveSelection(1)"
            @keydown.up.prevent="moveSelection(-1)"
            @keydown.enter.prevent="selectAndFocusPayload(commit)"
            @keydown.space.prevent="activateCommit(commit)"
            @keydown="onRowBandKeydown"
          >
            <span class="row-top">
              <span class="hash mono">{{ commit.shortHash }}</span>
              <span class="message" :title="commit.message">{{ commit.message }}</span>
            </span>
            <span class="row-meta mono">
              <span v-for="tag in refTags(commit)" :key="tag" class="ref-tag" :title="tag">{{
                tag
              }}</span>
              <span class="author" :title="commit.author">{{ commit.author }}</span>
              <span class="date">{{ relTime(commit) }}</span>
            </span>
          </div>
        </div>

        <p v-if="loadError" class="load-error view-error" data-testid="load-error">
          {{ loadError }}
          <button class="load-retry chrome-chip" data-testid="load-retry" @click="retryLoad">Retry</button>
        </p>

        <button
          v-if="mayHaveMore"
          class="load-more chrome-chip"
          data-testid="load-more"
          :disabled="history.isLoading"
          @click="load(requestedCount + PAGE_SIZE)"
        >
          {{ history.isLoading ? 'Loading…' : 'Load more' }}
        </button>
      </template>
    </aside>

    <SplitResizer
      v-if="isPortrait"
      class="history-resizer"
      :split="split"
      label="Resize commit and file lists"
    />

    <ChangedFileTree
      data-testid="commit-files"
      :files="commitFiles"
      :selected-index="selectedFileIndex"
      :portrait="isPortrait"
      @activate="selectFile"
      @select="selectFile"
    />

    <template v-if="selected">
      <header class="detail-header" data-testid="commit-detail">
        <div class="detail-top">
          <span class="full-hash mono" :title="selected.hash">{{ selected.hash }}</span>
        </div>
        <p class="detail-message">{{ selected.message }}</p>
        <p class="detail-meta mono">
          <span class="author">{{ selected.author }}</span>
          <span class="abs-date">{{ formatDateAbsolute(selected.date) }}</span>
        </p>
      </header>
      <p v-if="detailError" class="panel-note view-error detail-note" data-testid="detail-error">
        {{ detailError }}
      </p>
      <p v-else-if="history.commitFiles === null" class="panel-note detail-note">Loading diff…</p>
      <p
        v-else-if="history.commitFiles.length === 0"
        class="panel-note detail-note"
        data-testid="history-no-files"
      >
        No file changes to show (merge commits are not shown as a diff).
      </p>
      <DiffStack
        v-else
        ref="stackEl"
        class="diffs-col"
        data-testid="commit-diffs"
        :files="stackFiles"
        :active-key="activeStackKey"
        :syntax="ui.diffSyntaxEnabled"
        :mode="ui.diffMode"
        :wrap="ui.wrapEnabled"
        show-whole-toggle
        :whole-key="repo.wholeFile?.key ?? null"
        :whole-loading="repo.wholeFileLoading"
        :whole-refusal="repo.wholeFileRefusal"
        v-bind="payloadAttrs"
        @active-file="onActiveFile"
        @toggle-collapse="toggleFileCollapsed"
        @toggle-whole="toggleWholeFile"
      />
    </template>
    <p v-else class="panel-note detail-note" data-testid="history-prompt">
      Select a commit to view its changes
    </p>
  </div>
</template>

<style scoped>
.history {
  height: 100%;
  display: grid;
  grid-template-columns: clamp(16rem, 26%, 26rem) clamp(12rem, 20%, 22rem) minmax(0, 1fr);
  grid-template-rows: auto minmax(0, 1fr);
  grid-template-areas:
    'commits files header'
    'commits files diff';
  background: var(--bg);
}

/* --- Commit list --- */

.commits-col {
  grid-area: commits;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  /* No border-right: the diff beside it is a card now, so page background
     separates them — the same way Changes, Compare and Explorer do it. */
  background: var(--surface);
}

.commit-list {
  padding: 0.375rem 0;
}

.commit-row {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
  padding: 0.375rem 0.75rem;
  font-size: var(--fs-base);
}

.row-top {
  display: flex;
  align-items: baseline;
  gap: 0.625rem;
  min-width: 0;
}

.hash {
  flex: none;
  color: var(--selection);
}

.message {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
}

.commit-row.selected .message {
  color: var(--selection);
}

.row-meta {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  min-width: 0;
  font-size: var(--fs-small);
  color: var(--text-dim);
}

.ref-tag {
  flex: none;
  max-width: 14rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 0 0.25rem;
  border: 1px solid var(--add);
  border-radius: 3px;
  color: var(--add);
  font-size: var(--fs-micro);
}

.row-meta .author {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-meta .date {
  flex: none;
  margin-left: auto;
}

.load-error {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  margin: 0.375rem 0.75rem 0;
  font-size: var(--fs-small);
}

.load-retry {
  flex: none;
  padding: 0.125rem 0.5rem;
  color: var(--text);
  font-size: var(--fs-small);
}

.load-retry:hover {
  border-color: var(--text-dim);
}

.load-more {
  margin: 0.375rem 0.75rem 0.75rem;
  padding: 0.3125rem 0.875rem;
  font-size: var(--fs-small);
  align-self: flex-start;
}

.load-more:hover:not(:disabled) {
  border-color: var(--text-dim);
}

/* --- Changed files (middle) --- */

.files-col {
  grid-area: files;
}

/* --- Commit detail + diffs (right) --- */

.detail-header {
  grid-area: header;
  min-width: 0;
  margin-inline: var(--gutter);
  padding: 0.625rem 0.75rem;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
}

.detail-top {
  display: flex;
  align-items: baseline;
  gap: 0.75rem;
}

.full-hash {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--selection);
  font-size: var(--fs-small);
}

.detail-message {
  margin: 0.375rem 0 0;
  font-size: var(--fs-content);
  font-weight: 600;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.detail-meta {
  display: flex;
  gap: 0.75rem;
  margin: 0.375rem 0 0;
  font-size: var(--fs-small);
  color: var(--text-dim);
}

/* Grid placement only — the stack itself (scroller, sticky headers,
   collapse) lives in DiffStack. */
.diffs-col {
  grid-area: diff;
  min-width: 0;
}

.detail-note {
  grid-area: diff;
  align-self: start;
  justify-self: center;
  margin-top: 2.5rem;
}

/* No commit picked: the prompt takes the header's place too. */
.detail-note[data-testid='history-prompt'] {
  grid-row: header-start / diff-end;
  align-self: center;
  margin-top: 0;
}

/* Stacked: both lists share the top band side by side, the diffs get the
   full width below. The commit list keeps the wider share — a commit row
   carries a message, a file row mostly a name. Draggable row resizer
   between the band and the diffs (portrait-only element). */
:root[data-split='stacked'] .history {
  grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
  grid-template-rows: minmax(6rem, var(--history-top, 28vh)) var(--divider) auto minmax(0, 1fr);
  grid-template-areas:
    'commits files'
    'resizer resizer'
    'header header'
    'diff diff';
}

.history-resizer {
  grid-area: resizer;
}

:root[data-split='stacked'] .files-col {
  /* The commit list beside it is the same surface; a hairline keeps the
     two lists apart. */
  border-left: 1px solid var(--border);
}
</style>
