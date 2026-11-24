<script setup lang="ts">
/**
 * The Work page (`/work`, docs/work-page.md §5): every piece of the
 * author's work across the watched repos, found without bookkeeping.
 *
 * - Work: open PRs, branches with a draft, tracked items.
 * - Candidates: worktrees with changes, branches ahead or unpushed, fresh
 *   worktrees. Track moves one to Work. Those with no activity in the last
 *   CANDIDATE_RECENT_DAYS sit folded right below, as older candidates.
 * - Done: PRs merged or closed in the last seven days.
 *
 * With a time filter on, Done comes right after Work: looking back, what
 * finished reads before the candidates. Each section folds away, and the
 * browser remembers which ones are folded.
 *
 * Dismiss hides an item until something about it changes. The page scans
 * when it opens and when Refresh is pressed, never on its own. An item's
 * time reads as how long ago (`3 days 12 hours ago`), the date and time on
 * hover; a display clock re-renders those every 30 s and asks nothing of
 * the daemon. The gh line keeps a clock time (`checked 14:02`).
 *
 * Every section is one grid with the same columns, so the columns line up
 * across sections; inside a section the rows are grouped by repo. A row
 * opens a fold-out; the PR number and the compare button are one click to
 * GitHub and to Compare. "Last day" keeps only what moved in the last 24
 * hours; the other filters keep a week, 2 weeks or a month.
 */

import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useDaemonStore } from '../stores/daemon';
import { useRepoStore } from '../stores/repo';
import { useUiStore } from '../stores/ui';
import { useWorkStore } from '../stores/work';
import { useRepoOpen } from '../composables/useRepoOpen';
import { beginUserNav } from '../composables/useUrlSync';
import { basename } from '../utils/format';
import {
  TIME_BUCKETS,
  activeWithin,
  checkedAgoLine,
  formatAgo,
  formatFull,
  ghNotice,
  layoutWork,
} from '../utils/workFormat';
import type { WorkSort, WorkSortKey } from '../utils/workFormat';
import type { WorkSectionName } from '../prefs';
import WorkRow from '../components/WorkRow.vue';
import type { WorkClassification, WorkItem, WorkMarkAction } from '@diffstalker/core/types/work';

const daemon = useDaemonStore();
const repo = useRepoStore();
const ui = useUiStore();
const work = useWorkStore();
const { openByPath } = useRepoOpen();

/** How often the how-long-ago times re-render. */
const CLOCK_TICK_MS = 30_000;

/** The time the rows' how-long-ago is measured from. Display only: the sections use work.now. */
const clock = ref(Date.now());
let ticker: ReturnType<typeof setInterval> | null = null;

/** The page is in view again: bring what is old up to date (store catchUp). */
function onShown(): void {
  if (document.visibilityState !== 'visible') return;
  clock.value = Date.now();
  void work.catchUp();
}

onMounted(() => {
  ticker = setInterval(() => (clock.value = Date.now()), CLOCK_TICK_MS);
  document.addEventListener('visibilitychange', onShown);
  window.addEventListener('focus', onShown);
});

onUnmounted(() => {
  if (ticker !== null) clearInterval(ticker);
  document.removeEventListener('visibilitychange', onShown);
  window.removeEventListener('focus', onShown);
});

onMounted(() => {
  void work.load();
});

type BlockName = WorkSectionName | 'older';

const TITLES: Record<WorkSectionName, string> = {
  work: 'Work',
  candidates: 'Candidates',
  done: 'Done',
};

/** Page order. `older` is the folded rest of Candidates, so it sits right after them. */
const ORDER: readonly BlockName[] = ['work', 'candidates', 'older', 'done'];

/** Page order with a time filter on: looking back, what finished reads before the candidates. */
const ORDER_FILTERED: readonly BlockName[] = ['work', 'done', 'candidates', 'older'];

interface Column {
  label: string;
  key: WorkSortKey | null;
  /** What a click sorts by, first click first. */
  order?: string;
  right?: boolean;
}

/** The column headings; a key makes the heading sort. Same order as the row's cells. */
const COLUMNS: readonly Column[] = [
  { label: 'Stage', key: 'stage', order: 'how far along: local only first, merged last' },
  { label: 'Branch', key: 'branch', order: 'branch name, A to Z' },
  { label: 'Stack', key: 'stack', order: 'stack, each one bottom layer first' },
  { label: 'PR', key: 'pr', order: 'PR number, lowest first' },
  {
    label: 'Review',
    key: 'review',
    order: 'review: changes requested first, then waiting, then approved',
  },
  { label: 'CI', key: 'ci', order: 'CI: conflicts first, then failed, running, passed' },
  { label: 'Local', key: 'local', order: 'uncommitted plus unpushed, fewest first' },
  {
    label: 'Draft',
    key: 'draft',
    order:
      'PR draft: drafts with {{…}} gaps first, then drafts that differ from GitHub, then the rest',
  },
  {
    label: 'Status',
    key: 'status',
    order: "whose move: yours first, then someone else's, then done",
  },
  { label: 'When', key: 'activity', order: 'last activity, newest first', right: true },
  { label: '', key: null },
];

function sortTip(column: Column): string {
  const within = ui.workByRepo ? 'inside each repo' : 'inside each section';
  return `Sort by ${column.order} (${within}). Again to reverse, a third time for the default order. Rows with none go last.`;
}

/** null: the default order (newest activity first, stacks together). Not stored. */
const sort = ref<WorkSort | null>(null);

/** First click sorts (newest first for activity), the second reverses, the third goes back to the default. */
function sortBy(key: WorkSortKey): void {
  const first = key === 'activity' ? 'desc' : 'asc';
  const current = sort.value;
  if (current === null || current.key !== key) sort.value = { key, dir: first };
  else if (current.dir === first) sort.value = { key, dir: first === 'asc' ? 'desc' : 'asc' };
  else sort.value = null;
}

function ariaSort(key: WorkSortKey | null): 'ascending' | 'descending' | undefined {
  if (key === null || sort.value?.key !== key) return undefined;
  return sort.value.dir === 'asc' ? 'ascending' : 'descending';
}

const classification = computed<WorkClassification>(() => work.classification);

/** The filter: every item, or only those with activity in the last day, week or month. Not stored. */
const WINDOWS = TIME_BUCKETS.filter((bucket) => bucket.within !== Infinity);
const within = ref<string | null>(null);

function windowOf(key: string | null): number | null {
  return WINDOWS.find((window) => window.key === key)?.within ?? null;
}

function shown(items: WorkItem[], key: string | null): WorkItem[] {
  const ms = windowOf(key);
  return ms === null ? items : items.filter((item) => activeWithin(item, clock.value, ms));
}

/** Per filter, how many items it keeps across every section. */
const windowCounts = computed(() => {
  const all = ORDER.flatMap((name) => classification.value[name]);
  return Object.fromEntries(WINDOWS.map((window) => [window.key, shown(all, window.key).length]));
});

/** The older candidates fold; not stored, it starts closed. */
const olderOpen = ref(false);

function isOpen(name: BlockName): boolean {
  return name === 'older' ? olderOpen.value : !ui.workFolded.includes(name);
}

function onToggle(name: BlockName, event: Event): void {
  const open = (event.target as HTMLDetailsElement).open;
  if (name === 'older') olderOpen.value = open;
  else ui.setWorkFolded(name, !open);
}

const blocks = computed(() => {
  const order = within.value === null ? ORDER : ORDER_FILTERED;
  const shownBlocks = order
    .map((name) => {
      const items = shown(classification.value[name], within.value);
      const lines = layoutWork(items, {
        byRepo: ui.workByRepo,
        byTime: ui.workByTime,
        sort: sort.value,
        now: clock.value,
      });
      return { name, title: name === 'older' ? '' : TITLES[name], items, lines };
    })
    .filter((block) => block.items.length > 0);
  // The older candidates belong to Candidates: they fold away with it.
  const candidatesFolded = shownBlocks.some(
    (block) => block.name === 'candidates' && !isOpen('candidates')
  );
  return candidatesFolded ? shownBlocks.filter((block) => block.name !== 'older') : shownBlocks;
});

function olderSummary(count: number): string {
  return `${count} older ${count === 1 ? 'candidate' : 'candidates'}`;
}

const busy = computed(() => work.scan.running || work.prsLoading);

/** The `gh` line: how long ago the PR list was read, or why it could not be. */
const ghLine = computed<{ text: string; failed: boolean; tip?: string } | null>(() => {
  const snapshot = work.prs;
  if (snapshot === null) return work.prsLoading ? { text: 'checking PRs…', failed: false } : null;
  const checked =
    snapshot.checkedAt === null
      ? null
      : checkedAgoLine(snapshot.checkedAt, snapshot.viewer, clock.value);
  const tip = snapshot.checkedAt === null ? undefined : formatFull(snapshot.checkedAt);
  const notice = ghNotice(snapshot.status, snapshot.message);
  // A failed refresh keeps the last list; say how old it is.
  if (notice !== null)
    return { text: checked === null ? notice : `${notice} · ${checked}`, failed: true, tip };
  if (checked === null) return work.prsLoading ? { text: 'checking PRs…', failed: false } : null;
  const text = snapshot.capped ? `${checked} · more PRs than listed` : checked;
  return { text: work.prsLoading ? `${text} · checking…` : text, failed: false, tip };
});

/** How far a running scan is, or how long ago the last one finished. */
const scanLine = computed<{ text: string; tip?: string } | null>(() => {
  if (work.scan.running) return { text: `scanned ${work.scan.done} of ${work.scan.total} repos` };
  const at = work.scannedAt;
  if (at === null) return null;
  return { text: `Repos scanned ${formatAgo(at, clock.value)}`, tip: formatFull(at) };
});

const nothingToScan = computed(
  () =>
    work.scanFinished &&
    work.repos.length === 0 &&
    work.repoErrors.length === 0 &&
    work.rootErrors.length === 0
);

const allClear = computed(
  () =>
    work.scanFinished &&
    !nothingToScan.value &&
    ORDER.every((name) => classification.value[name].length === 0) &&
    classification.value.dismissed.length === 0
);

/**
 * Open the item in Compare. The repo opens first, with the page still up,
 * so the reader never sees the previous repo's Compare flash by; the
 * gesture is declared once it is there, so it is one history entry.
 */
async function openItem(item: WorkItem): Promise<void> {
  const target = item.open;
  if (target === null) return;
  if (daemon.activeRepoPath !== target.path && !(await openByPath(target.path))) return;
  beginUserNav({ repo: repo.repoPath ?? target.path, view: 'compare' });
  ui.setActiveView('compare');
  await repo.setComparePick({ head: target.head });
}

function mark(item: WorkItem, action: WorkMarkAction): void {
  void work.mark(item.key, action, action === 'dismiss' ? item.fingerprint : undefined);
}
</script>

<template>
  <div class="work-page" data-testid="work-page">
    <header class="work-head">
      <div class="head-text">
        <h1 class="title">Work</h1>
        <p
          v-if="ghLine"
          class="gh-line mono"
          :class="{ failed: ghLine.failed }"
          :data-tip="ghLine.tip"
          data-testid="gh-line"
        >
          {{ ghLine.text }}
        </p>
        <p v-if="scanLine" class="scan-line mono" :data-tip="scanLine.tip" data-testid="scan-line">
          {{ scanLine.text }}
        </p>
      </div>
      <div class="filters" role="group" aria-label="Show">
        <button
          class="filter chrome-chip"
          :class="{ on: within === null }"
          :aria-pressed="within === null"
          data-testid="work-within-all"
          @click="within = null"
        >
          All
        </button>
        <button
          v-for="window in WINDOWS"
          :key="window.key"
          class="filter chrome-chip"
          :class="{ on: within === window.key }"
          :aria-pressed="within === window.key"
          :data-testid="`work-within-${window.key}`"
          :data-tip="`Only what moved in the ${window.label.toLowerCase()}`"
          @click="within = window.key"
        >
          {{ window.label }} <span class="filter-count">{{ windowCounts[window.key] }}</span>
        </button>
      </div>
      <div class="filters" role="group" aria-label="Group">
        <button
          class="filter chrome-chip"
          :class="{ on: ui.workByRepo }"
          :aria-pressed="ui.workByRepo"
          data-testid="work-by-repo"
          data-tip="Group the rows under a heading per repo"
          @click="ui.toggleWorkByRepo()"
        >
          By repository
        </button>
        <button
          class="filter chrome-chip"
          :class="{ on: ui.workByTime }"
          :aria-pressed="ui.workByTime"
          data-testid="work-by-time"
          data-tip="Group the rows by their last activity: last day, week, 2 weeks, month, older"
          @click="ui.toggleWorkByTime()"
        >
          By time
        </button>
      </div>
      <button
        class="refresh-btn chrome-chip"
        data-testid="work-refresh"
        :disabled="busy"
        data-tip="Check GitHub and rescan every repo"
        @click="work.refresh()"
      >
        Refresh
      </button>
    </header>

    <p v-if="work.error" class="page-error view-error" data-testid="work-error">{{ work.error }}</p>
    <p
      v-if="work.repoErrors.length > 0"
      class="page-error view-error"
      data-testid="work-repo-errors"
      :data-tip="work.repoErrors.map((e) => `${e.path}: ${e.message}`).join('\n')"
    >
      {{ work.repoErrors.length }} {{ work.repoErrors.length === 1 ? 'repo' : 'repos' }} could not
      be scanned: {{ work.repoErrors.map((e) => basename(e.path)).join(', ') }}
    </p>
    <p
      v-if="work.rootErrors.length > 0"
      class="page-error view-error"
      data-testid="work-root-errors"
      :data-tip="work.rootErrors.map((e) => `${e.path}: ${e.message}`).join('\n')"
    >
      {{ work.rootErrors.length }} watch
      {{ work.rootErrors.length === 1 ? 'directory' : 'directories' }} not fully scanned:
      {{ work.rootErrors.map((e) => basename(e.path)).join(', ') }}
    </p>

    <div v-if="nothingToScan" class="state-block" data-testid="work-no-repos">
      <p class="state-title">No repos to scan.</p>
      <p class="state-hint">
        Add a watch directory in
        <button class="link-btn" @click="ui.openOverlay('settings')">Settings</button>, and its
        repos show up here.
      </p>
    </div>
    <p v-else-if="allClear" class="panel-note" data-testid="work-clear">
      Nothing open. A worktree with changes, a branch ahead of its base, or an open PR shows up
      here.
    </p>
    <p
      v-else-if="within !== null && blocks.length === 0 && work.scanFinished"
      class="panel-note"
      data-testid="work-within-empty"
    >
      Nothing moved in the {{ WINDOWS.find((w) => w.key === within)?.label.toLowerCase() }}.
    </p>

    <div v-if="blocks.length > 0" class="col-heads" data-testid="work-col-heads">
      <template v-for="column in COLUMNS" :key="column.label">
        <button
          v-if="column.key"
          class="col-head"
          :class="{ right: column.right, sorted: sort?.key === column.key }"
          :aria-sort="ariaSort(column.key)"
          :data-tip="sortTip(column)"
          @click="sortBy(column.key)"
        >
          {{ column.label
          }}<span v-if="sort?.key === column.key" class="sort-mark" aria-hidden="true">{{
            sort.dir === 'asc' ? ' ↑' : ' ↓'
          }}</span>
        </button>
        <span v-else class="col-head">{{ column.label }}</span>
      </template>
    </div>

    <details
      v-for="block in blocks"
      :key="block.name"
      class="work-section"
      :class="{ fold: block.name === 'older' }"
      :open="isOpen(block.name)"
      :data-testid="`work-section-${block.name}`"
      @toggle="onToggle(block.name, $event)"
    >
      <summary v-if="block.name === 'older'" class="eyebrow">
        {{ olderSummary(block.items.length) }}
      </summary>
      <summary v-else class="section-title eyebrow">
        <h2 class="section-name">
          {{ block.title }} <span class="count">{{ block.items.length }}</span>
        </h2>
      </summary>
      <ul class="rows">
        <template v-for="line in block.lines" :key="line.key">
          <li v-if="line.kind === 'time'" class="time-head" data-testid="work-time">
            <span class="time-name">{{ line.label }}</span>
            <span class="group-count">{{ line.count }}</span>
          </li>
          <li
            v-else-if="line.kind === 'repo'"
            class="group-head"
            :class="{ nested: ui.workByTime }"
            data-testid="work-group"
          >
            <span class="group-name">{{ line.name }}</span>
            <span class="group-count">{{ line.count }}</span>
          </li>
          <WorkRow v-else :item="line.item" :now="clock" @open="openItem" @mark="mark" />
        </template>
      </ul>
    </details>

    <details
      v-if="classification.dismissed.length > 0"
      class="work-section dismissed"
      data-testid="work-dismissed"
    >
      <summary class="eyebrow">{{ classification.dismissed.length }} dismissed</summary>
      <ul class="rows">
        <WorkRow
          v-for="item in classification.dismissed"
          :key="item.key"
          :item="item"
          :now="clock"
          dismissed
          @open="openItem"
          @mark="mark"
        />
      </ul>
    </details>
  </div>
</template>

<style scoped>
.work-page {
  /* The one column template every section shares, so columns line up. */
  --work-cols: 4.5rem minmax(0, 1fr) 3.5rem 4.25rem 4rem 2.75rem 5.25rem 3.75rem 11rem 9.5rem 7rem;
  max-width: 90rem;
  margin: 0 auto;
  padding: 1rem var(--gutter) 2rem;
}

.work-head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 0.5rem 1rem;
  margin-bottom: 1rem;
}

.filter-count {
  color: var(--text-dim);
}

.head-text {
  flex: 1;
  min-width: 0;
}

.title {
  margin: 0 0 0.25rem;
  font-size: var(--fs-display);
  font-weight: 650;
  letter-spacing: -0.01em;
}

.gh-line,
.scan-line {
  margin: 0;
  font-size: var(--fs-small);
  color: var(--text-dim);
}

.gh-line.failed {
  color: var(--warn);
}

.filters {
  display: inline-flex;
  gap: 0.25rem;
}

.filter,
.refresh-btn {
  flex: none;
  padding: 0.25rem 0.75rem;
  font-size: var(--fs-small);
}

.filter.on {
  border-color: var(--accent);
  color: var(--text);
}

.refresh-btn:hover:not(:disabled),
.filter:hover {
  border-color: var(--text-dim);
}

.page-error {
  margin: 0 0 0.75rem;
}

.state-block {
  margin: 2.5rem auto;
  max-width: 34rem;
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

.link-btn {
  color: var(--accent);
  text-decoration: underline;
}

.col-heads,
.rows {
  display: grid;
  grid-template-columns: var(--work-cols);
  column-gap: 0.5rem;
}

.col-heads {
  position: sticky;
  top: 0;
  z-index: 1;
  padding: 0.375rem 0;
  margin-bottom: 0.5rem;
  border-bottom: 1px solid var(--border);
  background: var(--bg);
  font-size: var(--fs-micro);
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  white-space: nowrap;
}

.col-head {
  min-width: 0;
  overflow: hidden;
  font: inherit;
  text-align: left;
  text-transform: inherit;
  letter-spacing: inherit;
  color: inherit;
  white-space: nowrap;
  cursor: pointer;
}

.col-head:first-child {
  padding-left: 0.75rem;
}

.col-head:hover,
.col-head.sorted {
  color: var(--text);
}

.col-head.right {
  text-align: right;
}

.work-section {
  margin-bottom: 1.5rem;
}

.section-title {
  margin-bottom: 0.375rem;
  cursor: pointer;
}

.section-name {
  display: inline;
  margin: 0;
  font: inherit;
  font-weight: 500;
}

.count {
  opacity: 0.8;
}

.rows {
  list-style: none;
  margin: 0;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--surface);
  overflow: hidden;
}

.group-head {
  grid-column: 1 / -1;
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  padding: 0.375rem 0.75rem 0.25rem;
  border-top: 1px solid var(--border);
  background: var(--bg);
  font-size: var(--fs-small);
}

.group-head:first-child,
.time-head:first-child {
  border-top: none;
}

.group-head.nested {
  padding-left: 1.5rem;
}

.time-head {
  grid-column: 1 / -1;
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem 0.375rem;
  border-top: 1px solid var(--border);
  background: color-mix(in srgb, var(--accent) 8%, var(--bg));
  font-size: var(--fs-small);
}

.time-name {
  font-weight: 650;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.group-name {
  font-weight: 600;
}

.group-count {
  color: var(--text-dim);
}

.dismissed summary,
.fold summary {
  cursor: pointer;
  margin-bottom: 0.375rem;
}

/* Narrow: the columns that need room go; branch, PR and when stay. */
@media (max-width: 60rem) {
  .work-page {
    --work-cols: 4.5rem minmax(0, 1fr) 4.25rem 4rem 2.75rem 9.5rem 7rem;
  }

  .col-heads > :nth-child(3),
  .col-heads > :nth-child(7),
  .col-heads > :nth-child(8),
  .col-heads > :nth-child(9),
  .rows :deep(.cell.stack),
  .rows :deep(.cell.local),
  .rows :deep(.cell.draft),
  .rows :deep(.cell.status) {
    display: none;
  }
}
</style>
