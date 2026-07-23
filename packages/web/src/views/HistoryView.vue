<script setup lang="ts">
/**
 * History view: commit list (left) + commit detail (right), read-only.
 *
 * On first activation the list loads via repo.loadHistory() (skipped
 * when a previous visit already loaded it — the store re-pulls on
 * state-change anyway). Selecting a commit calls selectHistoryCommit
 * with the EXACT CommitInfo object (the store's stale-guard is
 * identity-based); the commit's multi-file diff renders through the
 * shared DiffView with per-file section headers forced on.
 *
 * "Load more" raises the requested count by a page and re-pulls; it
 * hides once the log comes back short (nothing more to load).
 */

import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useRepoStore } from '../stores/repo';
import { useUiStore } from '../stores/ui';
import { formatRelativeTime, formatDateAbsolute } from '@diffstalker/core/view/formatDate';
import type { CommitInfo } from '@diffstalker/core/git/status';
import { TOP_MIN, TOP_MAX } from '../prefs';
import { usePortrait } from '../composables/useMediaQuery';
import { useSplitDrag } from '../composables/useSplitDrag';
import { makeBandKeyHandler, makePayloadKeyHandler } from '../composables/usePortraitKeys';
import DiffView from '../components/DiffView.vue';

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
    loadError.value = err instanceof Error ? err.message : String(err);
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
async function select(commit: CommitInfo): Promise<void> {
  detailError.value = null;
  lastSelectedHash.value = commit.hash;
  try {
    await repo.selectHistoryCommit(commit);
  } catch (err) {
    detailError.value = `Failed to load commit diff: ${err instanceof Error ? err.message : String(err)}`;
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
  if (list.length === 0) return;
  const current = selected.value ? list.indexOf(selected.value) : -1;
  let next: number;
  if (current === -1) {
    next = delta > 0 ? 0 : list.length - 1;
  } else {
    next = Math.min(list.length - 1, Math.max(0, current + delta));
  }
  void select(list[next]);
  void nextTick(() => {
    listEl.value?.querySelectorAll<HTMLElement>('.commit-row')[next]?.focus();
  });
}

// --- Portrait: row split (commit band above, detail below) + j/k keys ---

const isPortrait = usePortrait();
const containerEl = ref<HTMLElement | null>(null);
const split = useSplitDrag({
  container: containerEl,
  isRow: isPortrait,
  row: { pref: 'historyTop', defaultRatio: 0.28, min: TOP_MIN, max: TOP_MAX },
});

const payloadEl = ref<HTMLElement | null>(null);
const onRowBandKeydown = makeBandKeyHandler(isPortrait, moveSelection);
const onPayloadKeydown = makePayloadKeyHandler(isPortrait, payloadEl);

/** Enter on a row: select; in portrait also hand focus to the payload. */
function selectAndFocusPayload(commit: CommitInfo): void {
  void select(commit);
  if (!isPortrait.value) return;
  void nextTick(() => payloadEl.value?.focus());
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
      <p v-if="history.isLoading && commits.length === 0" class="col-empty">Loading history…</p>
      <!-- Full-pane error only when there is nothing to show; with commits
           loaded a failed re-pull stays a small inline line below the list. -->
      <p v-else-if="loadError && commits.length === 0" class="col-empty view-error">
        {{ loadError }}
      </p>
      <p v-else-if="commits.length === 0" class="col-empty" data-testid="history-empty">
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
            class="commit-row"
            :class="{ selected: commit === selected }"
            role="option"
            :aria-selected="commit === selected"
            :tabindex="isTabStop(commit, index) ? 0 : -1"
            :title="commit.hash"
            @click="select(commit)"
            @keydown.down.prevent="moveSelection(1)"
            @keydown.up.prevent="moveSelection(-1)"
            @keydown.enter.prevent="selectAndFocusPayload(commit)"
            @keydown.space.prevent="select(commit)"
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
          <button class="load-retry" data-testid="load-retry" @click="retryLoad">Retry</button>
        </p>

        <button
          v-if="mayHaveMore"
          class="load-more"
          data-testid="load-more"
          :disabled="history.isLoading"
          @click="load(requestedCount + PAGE_SIZE)"
        >
          {{ history.isLoading ? 'Loading…' : 'Load more' }}
        </button>
      </template>
    </aside>

    <div
      v-if="isPortrait"
      class="row-resizer"
      role="separator"
      :aria-orientation="split.ariaOrientation.value"
      aria-label="Resize commit list"
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

    <section class="detail-col" data-testid="commit-detail">
      <template v-if="selected">
        <header class="detail-header">
          <div class="detail-top">
            <span class="full-hash mono" :title="selected.hash">{{ selected.hash }}</span>
          </div>
          <p class="detail-message">{{ selected.message }}</p>
          <p class="detail-meta mono">
            <span class="author">{{ selected.author }}</span>
            <span class="abs-date">{{ formatDateAbsolute(selected.date) }}</span>
          </p>
        </header>
        <div
          ref="payloadEl"
          class="detail-diff"
          :tabindex="isPortrait ? 0 : undefined"
          :role="isPortrait ? 'region' : undefined"
          :aria-label="isPortrait ? 'Commit diff' : undefined"
          @keydown="onPayloadKeydown"
        >
          <p v-if="detailError" class="col-empty view-error" data-testid="detail-error">
            {{ detailError }}
          </p>
          <p v-else-if="!history.commitDiff" class="col-empty">Loading diff…</p>
          <DiffView
            v-else
            :diff="history.commitDiff"
            show-file-headers
            :syntax="ui.diffSyntaxEnabled"
            :mode="ui.diffMode"
          />
        </div>
      </template>
      <p v-else class="col-empty detail-prompt" data-testid="history-prompt">
        Select a commit to view its changes
      </p>
    </section>
  </div>
</template>

<style scoped>
.history {
  height: 100%;
  display: grid;
  grid-template-columns: clamp(16rem, 34%, 30rem) minmax(0, 1fr);
  background: var(--bg);
}

/* --- Commit list --- */

.commits-col {
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  border-right: 1px solid var(--border);
  background: var(--surface);
}

.col-empty {
  margin: 1rem;
  color: var(--text-dim);
  font-size: var(--fs-content);
}

.commit-list {
  padding: 0.375rem 0;
}

.commit-row {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
  padding: 0.375rem 0.75rem;
  border-left: 2px solid transparent;
  cursor: pointer;
  font-size: var(--fs-base);
}

.commit-row:hover {
  background: var(--surface-raised);
}

.commit-row.selected {
  background: var(--surface-raised);
  border-left-color: var(--selection);
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
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--surface-raised);
  color: var(--text);
  font-size: var(--fs-small);
}

.load-retry:hover {
  border-color: var(--text-dim);
}

.load-more {
  margin: 0.375rem 0.75rem 0.75rem;
  padding: 0.3125rem 0.875rem;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--surface-raised);
  font-size: var(--fs-small);
  align-self: flex-start;
}

.load-more:hover:not(:disabled) {
  border-color: var(--text-dim);
}

/* --- Commit detail --- */

.detail-col {
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.detail-header {
  flex: none;
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

.detail-diff {
  flex: 1;
  min-height: 0;
}

.detail-prompt {
  align-self: center;
  margin: auto;
}

/* Narrow widths: stack — commits above, detail below. */
@media (max-width: 44rem) {
  .history {
    grid-template-columns: 1fr;
    grid-template-rows: minmax(6rem, 40%) minmax(0, 1fr);
  }

  .commits-col {
    border-right: none;
    border-bottom: 1px solid var(--border);
  }
}

/* Portrait: rotate column → row. Full-width detail below a bounded
   commit band, with a draggable row resizer (portrait-only element). */
@media (orientation: portrait), (max-aspect-ratio: 1/1), (max-width: 1400px) {
  .history {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: minmax(6rem, var(--history-top, 28vh)) 8px minmax(0, 1fr);
  }

  .commits-col {
    border-right: none;
    border-bottom: 1px solid var(--border);
  }

  /* A visible divider bar (not a bare drag gap) so the two stacked panes
     read as clearly separate, with a centered grab handle signalling it
     drags. */
  .row-resizer {
    height: 8px;
    cursor: row-resize;
    background: var(--surface-raised);
    box-shadow:
      inset 0 1px 0 var(--border),
      inset 0 -1px 0 var(--border);
    touch-action: none;
    position: relative;
  }

  .row-resizer::after {
    content: '';
    position: absolute;
    inset: 0;
    margin: auto;
    width: 2.25rem;
    height: 2px;
    border-radius: 1px;
    background: var(--text-dim);
    opacity: 0.5;
  }

  .row-resizer:hover,
  .row-resizer:focus-visible {
    background: var(--selection);
  }

  .row-resizer:hover::after,
  .row-resizer:focus-visible::after {
    background: var(--surface);
    opacity: 0.9;
  }
}
</style>
