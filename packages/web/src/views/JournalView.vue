<script lang="ts">
/**
 * The fold itself lives in utils/foldEntries (a pure projection shared
 * with its own table tests); this block only derives "outdated" —
 * never stored, always re-derivable from the immutable log — exported
 * for tests.
 */

import type { JournalEntry } from '@diffstalker/core/types/journal';

/**
 * seq → ts of the entry that first retired it, from later entries'
 * supersedes/resolves pointers — so a REST refetch is always
 * authoritative about what is outdated.
 */
export function buildSupersededAt(entries: readonly JournalEntry[]): Map<number, number> {
  const at = new Map<number, number>();
  for (const entry of entries) {
    const retired = entry.type === 'hunk' ? entry.supersedes : entry.resolves;
    for (const seq of retired) {
      if (!at.has(seq)) at.set(seq, entry.ts);
    }
  }
  return at;
}
</script>

<script setup lang="ts">
/**
 * Journal view: the chronological, append-only, per-hunk log of diff
 * blurbs — ONE scroller, oldest at the top, growing downward, keyed by
 * seq (append-only, so keys never reorder).
 *
 * Rows come from foldEntries() over repo.journalEntries (the phase-4
 * store slice). Each hunk group renders a compact header (relative
 * time, path, "lines a–b", kind badge, +n −m, a "×N" affordance when
 * folded) over a reused DiffView fed the tip's single-hunk DiffResult;
 * a null diff (reverted tombstone, oversize, pruned) falls into
 * DiffView's no-hunk note. Boundary entries render as slim dividers;
 * seeded entries render muted. An entry superseded by a later one
 * (derived, never stored) collapses to a one-line stub with an
 * "outdated HH:MM" badge; clicking re-expands the stale snapshot.
 *
 * Off-screen cost: each blurb body carries content-visibility: auto
 * with a contain-intrinsic-size derived from the entry's line count —
 * fixed at append (entries are immutable), so the estimate never goes
 * stale; no live probe needed.
 *
 * Collapse transitions (design §5, verbatim): a collapse AT or BELOW
 * the viewport top animates (grid-template-rows 1fr → 0fr, ~200ms, off
 * under prefers-reduced-motion); a collapse ENTIRELY ABOVE the viewport
 * snaps inside one Vue flush and is compensated by a useScrollAnchor
 * pre/post sandwich (candidates = entry elements keyed by seq), so
 * nothing the user is reading moves. The sandwich is the ONLY scrollTop
 * compensation path — there is no ResizeObserver here at all, so the
 * RO -> scroll -> layout feedback loop (the historic freeze) is
 * unreachable by construction.
 *
 * Tail-pin: within ~40px of the bottom the view auto-follows appends;
 * further up, an "N new ↓" pill counts DISPLAYED rows (post-fold) whose
 * content the user has not seen — a burst of autosave supersessions
 * that folds into one row is "1 new", not N — and jumps to the end.
 *
 * Epoch reset: when the store's journalEpoch changes (daemon restart,
 * prune reset, repo switch), all session-local view state — expanded
 * stale stubs, opened chains, dismissed markers, huge-blurb expansions,
 * the tail-pin marker — is cleared; keys are seqs from the OLD log and
 * would otherwise leak onto unrelated new rows.
 */

import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  watch,
  type ComponentPublicInstance,
} from 'vue';
import { useRepoStore } from '../stores/repo';
import { formatRelativeTime, formatDateAbsolute } from '@diffstalker/core/view/formatDate';
import type { JournalBoundaryEntry, JournalHunkEntry } from '@diffstalker/core/types/journal';
import { foldEntries, type JournalHunkRow, type JournalRow } from '../utils/foldEntries';
import { useScrollAnchor, type AnchorCandidate } from '../composables/useScrollAnchor';
import DiffView from '../components/DiffView.vue';

/** Pinned-to-tail band: this close to the bottom, appends auto-follow. */
const TAIL_PIN_PX = 40;

const repo = useRepoStore();

const entries = computed<readonly JournalEntry[]>(() => repo.journalEntries);

const rows = computed(() => foldEntries(entries.value));
const supersededAt = computed(() => buildSupersededAt(entries.value));

// --- Outdated stubs and fold-chain expansion (session-local) ---

/** Stale snapshots the user re-expanded, by row key. */
const expandedStale = reactive(new Set<number>());
/** Fold chains opened via the ×N affordance, by row key. */
const expandedChains = reactive(new Set<number>());
/** Marker rows (renamed) the user dismissed, by row key. */
const dismissedMarkers = reactive(new Set<number>());

function isOutdated(row: JournalHunkRow): boolean {
  return supersededAt.value.has(row.tip.seq);
}

function outdatedAtOf(row: JournalHunkRow): number | undefined {
  return supersededAt.value.get(row.tip.seq);
}

/** A marker row: informational (renamed), never superseded by content. */
function isMarker(row: JournalHunkRow): boolean {
  return row.kind === 'renamed';
}

/** The header toggles collapse for outdated stubs AND dismissable markers. */
function isCollapsible(row: JournalHunkRow): boolean {
  return isOutdated(row) || isMarker(row);
}

function isCollapsed(row: JournalHunkRow): boolean {
  if (isOutdated(row)) return !expandedStale.has(row.key);
  return isMarker(row) && dismissedMarkers.has(row.key);
}

function toggleStale(key: number): void {
  if (expandedStale.has(key)) expandedStale.delete(key);
  else expandedStale.add(key);
}

function toggleChain(key: number): void {
  if (expandedChains.has(key)) expandedChains.delete(key);
  else expandedChains.add(key);
}

function toggleDismissed(key: number): void {
  if (dismissedMarkers.has(key)) dismissedMarkers.delete(key);
  else dismissedMarkers.add(key);
}

function onHeaderClick(row: JournalHunkRow): void {
  if (isOutdated(row)) toggleStale(row.key);
  else if (isMarker(row)) toggleDismissed(row.key);
}

function headerTitle(row: JournalHunkRow): string | undefined {
  if (isOutdated(row)) return 'Show the stale snapshot';
  if (isMarker(row)) return dismissedMarkers.has(row.key) ? 'Show the marker' : 'Dismiss the marker';
  return undefined;
}

// --- Header formatting ---

/** When the view mounted — the empty state's "journal started" label. */
const mountedAt = Date.now();

// Relative time labels tick once per 30s while mounted (append churn
// re-renders anyway; this keeps a quiet journal's labels honest).
const now = ref(Date.now());
let ticker: ReturnType<typeof setInterval> | null = null;

function relTime(ts: number): string {
  return formatRelativeTime(ts, now.value);
}

function absTime(ts: number): string {
  return formatDateAbsolute(new Date(ts));
}

function clock(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * The line-range to display: the NEW side of the entry's @@ header, so
 * the label matches the editor's line numbers (the HEAD pre-image span
 * reads "lines 0–1" at top-of-file and drifts as edits above land).
 * Falls back to the span when there is no diff (reverted/oversize).
 */
function newSideSpan(entry: JournalHunkEntry): { start: number; count: number } {
  const header = entry.diff?.lines.find((line) => line.type === 'hunk');
  const match = header?.content.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
  if (!match) return entry.span;
  return {
    start: parseInt(match[1], 10),
    count: match[2] !== undefined ? parseInt(match[2], 10) : 1,
  };
}

/** "lines 10–14" from the new-side @@ range (span fallback, see above). */
function lineLabel(entry: JournalHunkEntry): string {
  const { start, count } = newSideSpan(entry);
  if (count > 1) return `lines ${start}–${start + count - 1}`;
  // count 0 is a pure deletion: the new side has no lines, so name the
  // line the deletion sits after (clamped — "line 0" helps nobody).
  return `line ${Math.max(start, 1)}`;
}

function boundaryText(entry: JournalBoundaryEntry): string {
  const n = entry.resolves.length;
  switch (entry.kind) {
    case 'commit':
      return `committed ${entry.label} — ${n} change${n === 1 ? '' : 's'}`;
    case 'checkout':
      return `checked out ${entry.label}`;
    case 'stash':
      return entry.label ? `stash — ${entry.label}` : 'stash';
    case 'op-start':
      return `operation started — ${entry.label}`;
    case 'op-end':
      return `operation finished — ${entry.label}`;
    case 'journal-start':
      return `journal started ${clock(entry.ts)}`;
  }
}

// --- Bounded off-screen cost (fixed at append — no live probe) ---

/** DiffView's row estimate at a 16px root (matches DiffStack's ROW_PX). */
const ROW_PX = 20;
const BODY_MIN_PX = 48;
const BODY_CHROME_PX = 32; // hunk header + the always-on horizontal track

function bodyStyle(entry: JournalHunkEntry): { containIntrinsicSize: string } {
  const lines = entry.diff?.lines.length ?? 0;
  const px = Math.max(BODY_MIN_PX, lines * ROW_PX + BODY_CHROME_PX);
  return { containIntrinsicSize: `auto ${px}px` };
}

// --- Huge blurbs (post-formatter full-file snapshots) ---

/**
 * Above this many changed lines a blurb is a full-file snapshot (a
 * formatter sweep welded the file into one git hunk — secondary-review
 * section 2c), not a readable keystroke: render it collapsed behind a
 * "N lines changed — show" row instead. Keyed by entry seq so chain
 * members expand independently of the tip. Expansion is a plain
 * v-if flip below the click point — no scrollTop write, so the
 * freeze-safety argument is untouched.
 */
const HUGE_LINES = 800;
const expandedHuge = reactive(new Set<number>());

function changedLines(entry: JournalHunkEntry): number {
  return entry.stats.insertions + entry.stats.deletions;
}

function isHugeCollapsed(entry: JournalHunkEntry): boolean {
  return changedLines(entry) > HUGE_LINES && !expandedHuge.has(entry.seq);
}

// --- Entry elements, keyed by row key (seq) ---

const scrollerEl = ref<HTMLElement | null>(null);
const entryEls = new Map<number, HTMLElement>();

function setEntryEl(key: number, el: Element | ComponentPublicInstance | null): void {
  if (el instanceof HTMLElement) entryEls.set(key, el);
  else entryEls.delete(key);
}

// --- Scroll anchoring (the pre/post sandwich) ---

/** The rows the CURRENT DOM was rendered from; updated post-flush. */
let committedRows: JournalRow[] = rows.value;

/** Rows snapping (not animating) their collapse in the current commit. */
const snapKeys = reactive(new Set<number>());

function anchorCandidates(): AnchorCandidate[] {
  const out: AnchorCandidate[] = [];
  for (const row of committedRows) {
    const el = entryEls.get(row.key);
    if (el) {
      const key = String(row.key);
      out.push({ key, kind: 'file', fileKey: key, el });
    }
  }
  return out;
}

const anchor = useScrollAnchor(scrollerEl, {
  candidates: anchorCandidates,
  resolve: (key) => entryEls.get(Number(key)) ?? null,
});

/** Keys collapsed in the NEXT render (outdated and not re-expanded). */
const collapsedKeys = computed(() => {
  const set = new Set<number>();
  for (const row of rows.value) {
    if (row.type === 'hunk-group' && isCollapsed(row)) set.add(row.key);
  }
  return set;
});

/**
 * Elements whose collapse state flips in this commit. Side effect: a
 * collapse whose element sits ENTIRELY ABOVE the viewport is marked in
 * snapKeys — it snaps (transition off) and the anchor compensates; at
 * or below the viewport top it animates instead.
 */
function collapseChangeEls(
  nextCollapsed: Set<number>,
  prevCollapsed: Set<number>
): (HTMLElement | null)[] {
  const els: (HTMLElement | null)[] = [];
  const scroller = scrollerEl.value;
  const viewTop = scroller?.getBoundingClientRect().top ?? 0;
  for (const key of nextCollapsed) {
    if (prevCollapsed.has(key)) continue;
    const el = entryEls.get(key) ?? null;
    els.push(el);
    if (scroller && el && el.getBoundingClientRect().bottom <= viewTop) {
      snapKeys.add(key);
    }
  }
  for (const key of prevCollapsed) {
    if (!nextCollapsed.has(key)) els.push(entryEls.get(key) ?? null);
  }
  return els;
}

/** Elements of rows entering, leaving, or moving (a fold absorbed the tip). */
function rowChangeEls(nextRows: JournalRow[], prevRows: JournalRow[]): (HTMLElement | null)[] {
  const els: (HTMLElement | null)[] = [];
  const prevByKey = new Map(prevRows.map((row) => [row.key, row]));
  for (const row of nextRows) {
    const prev = prevByKey.get(row.key);
    if (!prev) {
      els.push(null); // entering — appends land at the bottom
    } else if (
      prev.type === 'hunk-group' &&
      row.type === 'hunk-group' &&
      prev.tip.seq !== row.tip.seq
    ) {
      // A fold absorbed the tip: the group moves to the bottom.
      els.push(entryEls.get(row.key) ?? null);
    }
  }
  const nextKeys = new Set(nextRows.map((row) => row.key));
  for (const row of prevRows) {
    if (!nextKeys.has(row.key)) els.push(entryEls.get(row.key) ?? null);
  }
  return els;
}

// Pre-flush: DOM still old. Classify each NEW collapse (snap vs
// animate), then pick and measure the anchor.
watch(
  [rows, collapsedKeys],
  ([nextRows, nextCollapsed], [prevRows, prevCollapsed]) => {
    snapKeys.clear();
    const changedEls = [
      ...collapseChangeEls(nextCollapsed, prevCollapsed),
      ...rowChangeEls(nextRows, prevRows),
    ];
    if (changedEls.length === 0) return;
    anchor.prepare({
      survivingKeys: new Set(nextRows.map((row) => String(row.key))),
      changedEls,
    });
  },
  { flush: 'pre' }
);

// Post-flush: DOM patched, same task, before paint — compensate.
watch(
  [rows, collapsedKeys],
  ([nextRows]) => {
    anchor.restore();
    committedRows = nextRows;
    // Drop the snap markers once the collapsed state is committed: the
    // clamp is already at 0fr, so re-enabling the transition animates
    // nothing — but a later user re-expand animates again.
    void nextTick(() => snapKeys.clear());
  },
  { flush: 'post' }
);

// --- Tail-pin ---

const pinned = ref(true);
const newCount = ref(0);
/** Highest seq the user has seen at the tail (frozen while scrolled up). */
let lastSeenSeq = tailSeq(entries.value);

function tailSeq(list: readonly JournalEntry[]): number {
  return list.length > 0 ? list[list.length - 1].seq : 0;
}

/**
 * The pill counts DISPLAYED rows (post-fold) whose newest content the
 * user has not seen — a burst of autosave supersessions folding into
 * one row is "1 new", not one per revision. Declarative (recomputed
 * against the frozen marker, never accumulated), so a group growing
 * across several SSE batches still counts once.
 */
function countNewRows(list: readonly JournalRow[], seenSeq: number): number {
  let count = 0;
  for (const row of list) {
    const newest = row.type === 'hunk-group' ? row.tip.seq : row.key;
    if (newest > seenSeq) count++;
  }
  return count;
}

function onScroll(): void {
  const el = scrollerEl.value;
  if (!el) return;
  const near = el.scrollHeight - el.scrollTop - el.clientHeight <= TAIL_PIN_PX;
  pinned.value = near;
  if (near) {
    lastSeenSeq = tailSeq(entries.value);
    newCount.value = 0;
  }
}

function scrollToEnd(): void {
  const el = scrollerEl.value;
  if (!el) return;
  el.scrollTop = el.scrollHeight;
  pinned.value = true;
  lastSeenSeq = tailSeq(entries.value);
  newCount.value = 0;
}

watch(
  rows,
  (nextRows) => {
    const tail = tailSeq(entries.value);
    // Seq regression = journal reset (epoch change refetched the log
    // wholesale; seqs restart near 1). A stale marker would mute the
    // counter forever — resync it instead of counting the refetched
    // log as "new".
    if (tail < lastSeenSeq) {
      lastSeenSeq = tail;
      newCount.value = 0;
      if (pinned.value) scrollToEnd();
      return;
    }
    if (pinned.value) {
      // Follow genuine appends only; a wholesale replace at the same
      // tail must not yank the viewport.
      if (tail > lastSeenSeq) scrollToEnd();
      else lastSeenSeq = tail;
      return;
    }
    newCount.value = countNewRows(nextRows, lastSeenSeq);
  },
  { flush: 'post' }
);

// --- Epoch reset ---

// A journalEpoch change means the log was replaced wholesale (daemon
// restart, prune reset, repo switch): every piece of session-local view
// state is keyed by seqs from the OLD log and must not leak onto the
// new one. The seq-regression guard above cannot cover this alone — a
// long-lived new log can overtake the old marker.
watch(
  () => repo.journalEpoch,
  (_next, prev) => {
    if (prev === null) return; // first load — nothing local to reset
    expandedStale.clear();
    expandedChains.clear();
    dismissedMarkers.clear();
    expandedHuge.clear();
    // A stale mount-time load error must not linger over a fresh log.
    loadError.value = null;
    lastSeenSeq = tailSeq(entries.value);
    newCount.value = 0;
    pinned.value = true;
    void nextTick(scrollToEnd);
  }
);

// --- Lifecycle ---

// Lazy load on first tab visit (mirrors history/compare; the store
// no-ops when already loaded — appends ride SSE from then on).
// loadJournal rejects a DaemonError to the visiting view; catch it
// into a calm line (connection loss collapses store-side instead).
const loadError = ref<string | null>(null);

async function loadNow(): Promise<void> {
  loadError.value = null;
  try {
    await repo.loadJournal();
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : String(err);
  }
}

onMounted(() => {
  void loadNow();
  ticker = setInterval(() => {
    now.value = Date.now();
  }, 30_000);
  // Start reading at the newest entries (the bottom).
  void nextTick(scrollToEnd);
});

onBeforeUnmount(() => {
  if (ticker !== null) {
    clearInterval(ticker);
    ticker = null;
  }
});
</script>

<template>
  <div class="journal">
    <div
      ref="scrollerEl"
      class="journal-scroll"
      data-testid="journal-scroll"
      @scroll.passive="onScroll"
    >
      <!-- Full-pane error only when there is nothing to show; with
           entries loaded the log stays visible (appends ride SSE). -->
      <p
        v-if="loadError && rows.length === 0"
        class="journal-empty view-error"
        data-testid="journal-error"
      >
        {{ loadError }}
      </p>
      <p
        v-else-if="rows.length === 0 && !repo.journalLoaded"
        class="journal-empty"
        data-testid="journal-loading"
      >
        Loading journal…
      </p>
      <p v-else-if="rows.length === 0" class="journal-empty" data-testid="journal-empty">
        journal started {{ clock(mountedAt) }} — your edits will show up here
      </p>

      <!-- Epoch mismatch / pruned gap on reconnect: the log was refetched
           from scratch — say so instead of leaving a silent hole. -->
      <div
        v-if="repo.journalRestarted && rows.length > 0"
        class="boundary mono"
        data-testid="journal-restarted"
      >
        <span class="boundary-label">journal restarted — earlier entries were lost</span>
      </div>

      <template v-for="row in rows" :key="row.key">
        <div
          v-if="row.type === 'boundary'"
          :ref="(el) => setEntryEl(row.key, el)"
          class="boundary mono"
          data-testid="journal-boundary"
        >
          <span class="boundary-label">{{ boundaryText(row.entry) }}</span>
        </div>

        <article
          v-else
          :ref="(el) => setEntryEl(row.key, el)"
          class="entry"
          :class="{
            outdated: isOutdated(row),
            seeded: row.tip.seeded,
            snap: snapKeys.has(row.key),
          }"
          :data-seq="row.key"
          data-testid="journal-entry"
        >
          <header
            class="entry-header mono"
            :class="{ clickable: isCollapsible(row) }"
            :title="headerTitle(row)"
            @click="onHeaderClick(row)"
          >
            <span class="time" :title="absTime(row.tip.ts)">{{ relTime(row.tip.ts) }}</span>
            <span class="path">{{ row.tip.path }}</span>
            <span class="lines">{{ lineLabel(row.tip) }}</span>
            <span class="kind" :data-kind="row.kind" data-testid="kind-badge">{{ row.kind }}</span>
            <button
              v-if="row.members.length > 1"
              class="fold-count"
              data-testid="fold-count"
              :aria-expanded="expandedChains.has(row.key)"
              :title="`${row.members.length} folded revisions`"
              @click.stop="toggleChain(row.key)"
            >
              ×{{ row.members.length }}
            </button>
            <span v-if="row.tip.seeded" class="seeded-note" data-testid="seeded-note"
              >present when journal started</span
            >
            <span v-if="isOutdated(row)" class="outdated-badge" data-testid="outdated-badge"
              >outdated {{ clock(outdatedAtOf(row)!) }}</span
            >
            <span class="stats">
              <span v-if="row.tip.stats.insertions" class="count-add"
                >+{{ row.tip.stats.insertions }}</span
              >
              <span v-if="row.tip.stats.deletions" class="count-del"
                >&minus;{{ row.tip.stats.deletions }}</span
              >
            </span>
          </header>

          <div class="clamp" :class="{ closed: isCollapsed(row) }">
            <div class="clamp-inner">
              <!-- The ×N chain, oldest first, above the tip — stale
                   revisions of the same hunk, muted. -->
              <template v-if="expandedChains.has(row.key)">
                <div
                  v-for="member in row.members.slice(0, -1)"
                  :key="member.seq"
                  class="chain-member"
                  data-testid="chain-member"
                >
                  <div class="chain-head mono">
                    <span class="time" :title="absTime(member.ts)">{{ relTime(member.ts) }}</span>
                    <span class="kind" :data-kind="member.kind">{{ member.kind }}</span>
                    <span class="stats">
                      <span v-if="member.stats.insertions" class="count-add"
                        >+{{ member.stats.insertions }}</span
                      >
                      <span v-if="member.stats.deletions" class="count-del"
                        >&minus;{{ member.stats.deletions }}</span
                      >
                    </span>
                  </div>
                  <button
                    v-if="isHugeCollapsed(member)"
                    class="huge-row mono"
                    data-testid="huge-collapsed"
                    @click="expandedHuge.add(member.seq)"
                  >
                    {{ changedLines(member) }} lines changed — show
                  </button>
                  <div v-else class="entry-body" :style="bodyStyle(member)">
                    <DiffView :diff="member.diff" :file-path="member.path" />
                  </div>
                </div>
              </template>

              <!-- A post-formatter full-file snapshot is unreadable as a
                   blurb: collapse it behind a file-level show row. -->
              <button
                v-if="isHugeCollapsed(row.tip)"
                class="huge-row mono"
                data-testid="huge-collapsed"
                @click="expandedHuge.add(row.tip.seq)"
              >
                {{ changedLines(row.tip) }} lines changed — show
              </button>
              <div v-else class="entry-body" :style="bodyStyle(row.tip)" data-testid="entry-body">
                <DiffView :diff="row.tip.diff" :file-path="row.tip.path" />
              </div>
            </div>
          </div>
        </article>
      </template>
    </div>

    <button v-if="newCount > 0" class="new-pill mono" data-testid="new-pill" @click="scrollToEnd">
      {{ newCount }} new ↓
    </button>
  </div>
</template>

<style scoped>
.journal {
  position: relative;
  height: 100%;
  background: var(--bg);
}

.journal-scroll {
  height: 100%;
  overflow-y: auto;
  /* The useScrollAnchor sandwich is the ONE compensation path; native
     anchoring would double-correct against it (and Safari has none). */
  overflow-anchor: none;
  padding: 0.5rem 0.75rem 1rem;
}

.journal-empty {
  margin: 1rem 0.25rem;
  color: var(--text-dim);
  font-size: var(--fs-content);
}

/* --- Boundary dividers --- */

.boundary {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  margin: 0.625rem 0;
  color: var(--text-dim);
  font-size: var(--fs-small);
  white-space: nowrap;
}

.boundary::before,
.boundary::after {
  content: '';
  flex: 1;
  border-top: 1px solid var(--border);
}

.boundary-label {
  overflow: hidden;
  text-overflow: ellipsis;
}

/* --- Hunk-group entries --- */

.entry {
  margin: 0.375rem 0;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--surface);
  overflow: hidden;
}

.entry-header {
  display: flex;
  align-items: baseline;
  gap: 0.625rem;
  min-width: 0;
  padding: 0.3125rem 0.625rem;
  font-size: var(--fs-small);
}

.entry-header.clickable {
  cursor: pointer;
}

.entry-header .time {
  flex: none;
  color: var(--text-dim);
}

.entry-header .path {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
}

.entry-header .lines {
  flex: none;
  color: var(--text-dim);
}

.kind {
  flex: none;
  padding: 0 0.3125rem;
  border: 1px solid var(--text-dim);
  border-radius: 3px;
  color: var(--text-dim);
  font-size: var(--fs-micro);
}

.kind[data-kind='created'] {
  border-color: var(--status-added);
  color: var(--status-added);
}

.kind[data-kind='edited'],
.kind[data-kind='expanded'],
.kind[data-kind='shrunk'] {
  border-color: var(--status-modified);
  color: var(--status-modified);
}

.kind[data-kind='reverted'] {
  border-color: var(--status-deleted);
  color: var(--status-deleted);
}

.kind[data-kind='renamed'] {
  border-color: var(--status-renamed);
  color: var(--status-renamed);
}

.fold-count {
  flex: none;
  padding: 0 0.3125rem;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: var(--surface-raised);
  color: var(--text);
  font-size: var(--fs-micro);
  cursor: pointer;
}

.fold-count:hover {
  border-color: var(--selection);
}

.seeded-note {
  flex: none;
  color: var(--text-dim);
  font-size: var(--fs-micro);
  font-style: italic;
}

.outdated-badge {
  flex: none;
  padding: 0 0.3125rem;
  border-radius: 3px;
  background: var(--surface-raised);
  color: var(--text-dim);
  font-size: var(--fs-micro);
}

.entry-header .stats {
  flex: none;
  margin-left: auto;
  display: inline-flex;
  gap: 0.375rem;
}

/* Seeded entries: present before the journal watched anything — muted. */
.entry.seeded {
  opacity: 0.75;
}

/* Outdated: the header IS the one-line stub while collapsed. */
.entry.outdated .entry-header .path,
.entry.outdated .entry-header .time {
  color: var(--text-dim);
}

/* --- Collapse clamp (grid-rows 1fr -> 0fr) --- */

.clamp {
  display: grid;
  grid-template-rows: 1fr;
  transition: grid-template-rows 200ms ease;
}

.clamp.closed {
  grid-template-rows: 0fr;
}

/* Entirely-above-viewport collapses snap; the anchor compensates. */
.entry.snap .clamp {
  transition: none;
}

@media (prefers-reduced-motion: reduce) {
  .clamp {
    transition: none;
  }
}

.clamp-inner {
  min-height: 0;
  overflow: hidden;
}

/* Skip layout+paint for far-away blurbs; the intrinsic size comes from
   the entry's line count, fixed at append (entries are immutable). */
.entry-body {
  content-visibility: auto;
  border-top: 1px solid var(--border);
}

/* Huge blurb collapsed behind a file-level show row (formatter sweep). */
.huge-row {
  display: block;
  width: 100%;
  padding: 0.375rem 0.625rem;
  border: none;
  border-top: 1px solid var(--border);
  background: var(--surface);
  color: var(--text-dim);
  font-size: var(--fs-small);
  text-align: left;
  cursor: pointer;
}

.huge-row:hover {
  color: var(--text);
}

/* --- Fold-chain members (stale revisions above the tip) --- */

.chain-member {
  opacity: 0.65;
}

.chain-head {
  display: flex;
  align-items: baseline;
  gap: 0.625rem;
  padding: 0.1875rem 0.625rem;
  border-top: 1px solid var(--border);
  color: var(--text-dim);
  font-size: var(--fs-micro);
}

.chain-head .stats {
  margin-left: auto;
  display: inline-flex;
  gap: 0.375rem;
}

/* --- New-entries pill --- */

.new-pill {
  position: absolute;
  bottom: 0.875rem;
  left: 50%;
  transform: translateX(-50%);
  padding: 0.25rem 0.75rem;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface-raised);
  color: var(--text);
  font-size: var(--fs-small);
  cursor: pointer;
  box-shadow: 0 2px 8px rgb(0 0 0 / 0.25);
}

.new-pill:hover {
  border-color: var(--selection);
}
</style>
