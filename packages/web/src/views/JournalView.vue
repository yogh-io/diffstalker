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
 * blurbs — ONE scroller, NEWEST at the top, growing downward into the
 * past, keyed by seq (append-only, so keys never reorder). The store,
 * foldEntries, and every piece of seq bookkeeping stay oldest-first
 * (tailSeq still means highest seq); displayRows reverses for render
 * only, so the fold/supersede logic never learns about the flip.
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
 * Head-pin: within ~40px of the top the view follows appends — a fresh
 * entry PREPENDS above and the view scrolls back to 0 so it is in view.
 * Further down, an "N new ↑" pill counts DISPLAYED rows (post-fold)
 * whose content the user has not seen — a burst of autosave
 * supersessions that folds into one row is "1 new", not N — and jumps
 * back to the top. An append while scrolled down inserts ABOVE the
 * viewport; the same anchor sandwich that covers collapses compensates
 * the insert (entering rows ride changedEls), so nothing the user is
 * reading moves.
 *
 * Enter reveal: a genuine append entering while head-pinned animates
 * open (grid-template-rows 0fr → 1fr, ~200ms, off under
 * prefers-reduced-motion) — a pure-CSS keyframe on mount, no
 * ResizeObserver, no JS height measurement. When the user is scrolled
 * down the entering row SNAPS in at full height instead and the anchor
 * compensates it in one shot — a continuously-growing row would outrun
 * the one-shot pre/post measurement. The collapse policy, mirrored.
 *
 * Epoch reset: when the store's journalEpoch changes (daemon restart,
 * prune reset, repo switch), all session-local view state — expanded
 * stale stubs, opened chains, dismissed markers, huge-blurb expansions,
 * enter-reveal keys, the head-pin marker — is cleared; keys are seqs
 * from the OLD log and would otherwise leak onto unrelated new rows.
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
import { useUiStore } from '../stores/ui';
import { formatRelativeTime, formatDateAbsolute } from '@diffstalker/core/view/formatDate';
import type { JournalBoundaryEntry, JournalHunkEntry } from '@diffstalker/core/types/journal';
import { foldEntries, type JournalHunkRow, type JournalRow } from '../utils/foldEntries';
import { useScrollAnchor, type AnchorCandidate } from '../composables/useScrollAnchor';
import DiffView from '../components/DiffView.vue';

/** Pinned-to-head band: this close to the top, appends auto-follow. */
const TOP_PIN_PX = 40;

const repo = useRepoStore();
const ui = useUiStore();

const entries = computed<readonly JournalEntry[]>(() => repo.journalEntries);

const rows = computed(() => foldEntries(entries.value));
const supersededAt = computed(() => buildSupersededAt(entries.value));

/**
 * The template renders newest-first; `rows` stays oldest-first (seq
 * order — everything that reasons about "the tail = newest = last"
 * keeps doing so). Only the VISUAL order flips here.
 */
const displayRows = computed(() => [...rows.value].reverse());

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

// Relative-time labels ("42 seconds ago") must count up live from the
// moment an entry arrives, not jump on a coarse fixed tick. While the
// newest entry is under a minute old we tick every second so its
// seconds-granularity label stays honest; past a minute the label only
// changes on the minute/hour, so we drop to a quiet 30s cadence. A fresh
// append reschedules the tick immediately (see the newest-entry watch)
// so its counter starts the instant the entry lands.
const now = ref(Date.now());
let ticker: ReturnType<typeof setTimeout> | null = null;

/** Timestamp of the youngest entry (the tail), or 0 when empty. */
function newestTs(): number {
  const list = entries.value;
  return list.length > 0 ? list[list.length - 1].ts : 0;
}

function tick(): void {
  now.value = Date.now();
  const interval = now.value - newestTs() < 60_000 ? 1_000 : 30_000;
  ticker = setTimeout(tick, interval);
}

function restartTicker(): void {
  if (ticker !== null) clearTimeout(ticker);
  tick();
}

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

/**
 * Rows that entered while head-pinned — they animate open on mount
 * (the .reveal enter keyframe). Never pruned: keys are append-only
 * seqs and a finished one-shot animation does not replay; epoch reset
 * clears the set (a new log restarts seqs, which would collide).
 */
const enterKeys = reactive(new Set<number>());

function anchorCandidates(): AnchorCandidate[] {
  const out: AnchorCandidate[] = [];
  // The anchor binary-searches candidates by rect top, so they must be
  // in DOCUMENT order — the DOM renders newest-first, so walk the
  // (oldest-first) committed rows in reverse.
  for (let i = committedRows.length - 1; i >= 0; i--) {
    const row = committedRows[i];
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
    // Two cases both PREPEND at the display top (newest-first) and both
    // push null rather than an old element:
    //   - entering: a fresh append, no old element to measure;
    //   - fold-move: a fold absorbed the tip, so the group relocates to
    //     the newest slot (the top).
    // Null is deliberate over the old rect: the row reinserts ABOVE the
    // viewport, so measuring its old rect would let allChangesBelow()
    // skip compensation when the old position sat entirely below the
    // viewport — an uncompensated downward jump. Null forces the anchor
    // to compensate the net shift, correct in both directions (an
    // above-viewport move nets ~0).
    const foldMoved =
      prev?.type === 'hunk-group' && row.type === 'hunk-group' && prev.tip.seq !== row.tip.seq;
    if (!prev || foldMoved) els.push(null);
  }
  const nextKeys = new Set(nextRows.map((row) => row.key));
  for (const row of prevRows) {
    if (!nextKeys.has(row.key)) els.push(entryEls.get(row.key) ?? null);
  }
  return els;
}

/**
 * A genuine append (a new highest key) entering while head-pinned
 * animates open; every other enter — initial load, an epoch refetch, an
 * append while the user is scrolled down reading older entries — snaps
 * in at full height so the anchor sandwich can compensate it in one
 * shot. Animating an above-viewport insert would grow the row across
 * many frames against a single pre/post measurement.
 */
function markEnteringRows(nextRows: JournalRow[], prevRows: JournalRow[]): void {
  if (!pinned.value || prevRows.length === 0) return;
  const prevKeys = new Set(prevRows.map((row) => row.key));
  let prevMax = 0;
  for (const key of prevKeys) if (key > prevMax) prevMax = key;
  for (const row of nextRows) {
    if (row.type === 'hunk-group' && !prevKeys.has(row.key) && row.key > prevMax) {
      enterKeys.add(row.key);
    }
  }
}

// Pre-flush: DOM still old. Classify each NEW collapse (snap vs
// animate) and each entering row (animate vs snap, same policy), then
// pick and measure the anchor.
watch(
  [rows, collapsedKeys],
  ([nextRows, nextCollapsed], [prevRows, prevCollapsed]) => {
    snapKeys.clear();
    markEnteringRows(nextRows, prevRows);
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

// --- Head-pin ---

const pinned = ref(true);
const newCount = ref(0);
/** Highest seq the user has seen at the head (frozen while scrolled down). */
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
  const near = el.scrollTop <= TOP_PIN_PX;
  pinned.value = near;
  if (near) {
    lastSeenSeq = tailSeq(entries.value);
    newCount.value = 0;
  }
}

function scrollToStart(): void {
  const el = scrollerEl.value;
  if (!el) return;
  el.scrollTop = 0;
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
      if (pinned.value) scrollToStart();
      return;
    }
    if (pinned.value) {
      // Follow genuine appends only (they prepend above; scroll back
      // to 0 so the freshest entry is in view — this runs AFTER the
      // anchor's restore in the same flush, so it wins). A wholesale
      // replace at the same tail must not yank the viewport.
      if (tail > lastSeenSeq) scrollToStart();
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
    enterKeys.clear();
    // A stale mount-time load error must not linger over a fresh log.
    loadError.value = null;
    lastSeenSeq = tailSeq(entries.value);
    newCount.value = 0;
    pinned.value = true;
    void nextTick(scrollToStart);
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

// A fresh (or wholesale-replaced) youngest entry restarts the cadence
// now, so a just-arrived entry's seconds counter starts ticking at once
// instead of waiting out a pending 30s timer.
watch(() => newestTs(), restartTicker);

onMounted(() => {
  void loadNow();
  tick();
  // Start reading at the newest entries (the top).
  void nextTick(scrollToStart);
});

onBeforeUnmount(() => {
  if (ticker !== null) {
    clearTimeout(ticker);
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

      <template v-for="row in displayRows" :key="row.key">
        <div
          v-if="row.type === 'boundary'"
          :ref="(el) => setEntryEl(row.key, el)"
          class="boundary mono"
          data-testid="journal-boundary"
        >
          <span class="boundary-label">{{ boundaryText(row.entry) }}</span>
        </div>

        <!-- The reveal wrapper is an inert block until the row enters
             while head-pinned; then it animates open once (see CSS). -->
        <div v-else class="reveal" :class="{ enter: enterKeys.has(row.key) }">
          <article
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
                      <DiffView
                        :diff="member.diff"
                        :file-path="member.path"
                        :syntax="ui.diffSyntaxEnabled"
                      />
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
                  <DiffView
                    :diff="row.tip.diff"
                    :file-path="row.tip.path"
                    :syntax="ui.diffSyntaxEnabled"
                  />
                </div>
              </div>
            </div>
          </article>
        </div>
      </template>

      <!-- Epoch mismatch / pruned gap on reconnect: the log was refetched
           from scratch — say so instead of leaving a silent hole. Sits at
           the OLD end (the bottom, past the oldest surviving entry). -->
      <div
        v-if="repo.journalRestarted && rows.length > 0"
        class="boundary mono"
        data-testid="journal-restarted"
      >
        <span class="boundary-label">journal restarted — earlier entries were lost</span>
      </div>
    </div>

    <button v-if="newCount > 0" class="new-pill mono" data-testid="new-pill" @click="scrollToStart">
      {{ newCount }} new ↑
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

/* --- Enter reveal (a fresh append opening at the top) --- */

/* Without .enter the wrapper is a plain block: the entry's margins
   collapse through it, so spacing is identical to an unwrapped row.
   With .enter (a head-pinned append) it becomes a grid and plays a
   one-shot 0fr -> 1fr open on mount — pure CSS, no measurement. The
   wrapper takes over the entry's margin so the reveal grows from a
   true zero (a grid container's own margins still collapse with its
   siblings; its child's would not). */
.reveal.enter {
  display: grid;
  overflow: hidden;
  margin: 0.375rem 0;
  animation: journal-enter 200ms ease;
}

.reveal.enter > .entry {
  min-height: 0;
  margin: 0;
}

@keyframes journal-enter {
  from {
    grid-template-rows: 0fr;
  }

  to {
    grid-template-rows: 1fr;
  }
}

@media (prefers-reduced-motion: reduce) {
  .reveal.enter {
    animation: none;
  }
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
  top: 0.875rem;
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
