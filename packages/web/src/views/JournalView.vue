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
 * Journal view: a calm second-screen VIEWER of your UNCOMMITTED work — the
 * chronological, per-hunk log of your own edits since the last commit. ONE
 * scroller, NEWEST at the top, growing downward into the past, keyed by seq.
 * It SHOWS; it is not operated — no selection, keyboard-driving, filter, or
 * per-entry actions (those live in the shell / terminal UI, inches away). A
 * commit resets the timeline; recently-committed work lingers, collapsed under
 * a foldable boundary, until it ages out of the window.
 *
 * Rows come from foldEntries() over repo.journalEntries. Each hunk group is a
 * one-line header — a kind word on a kind-coloured rail, the path (bold file +
 * muted dir), a static "×N" churn marker when rapid saves folded, ±stats, and
 * a relative time that freezes to a wall-clock HH:MM past an hour — over a
 * reused DiffView fed the tip's single-hunk diff (a null diff falls into
 * DiffView's no-hunk note). Boundaries are slim dividers; a commit boundary is
 * clickable to fold its whole section. The store, foldEntries, and all seq
 * bookkeeping stay oldest-first; displayRows reverses for render only.
 *
 * Off-screen cost: each blurb body carries content-visibility: auto with a
 * contain-intrinsic-size fixed at append (entries are immutable) — no live probe.
 *
 * Head-pin: within ~40px of the top the view follows appends — a fresh entry
 * PREPENDS above and the view scrolls back to 0. Further down, an "N new ↑"
 * pill counts DISPLAYED rows the user has not seen and jumps back to the top. A
 * genuine append entering while head-pinned animates open (grid-rows 0fr → 1fr,
 * pure CSS, off under prefers-reduced-motion). ANY DOM change above the
 * viewport (an append, or a commit-fold hide/show) is compensated by a single
 * useScrollAnchor pre/post sandwich — the ONLY scrollTop writer; there is no
 * ResizeObserver and no JS height measurement, so the historic RO -> scroll ->
 * layout freeze is unreachable by construction.
 *
 * Epoch reset: when journalEpoch changes (daemon restart, prune, repo switch),
 * session-local view state — folded commits, huge-blurb expansions, enter-reveal
 * keys, the head-pin marker — is cleared; its keys are seqs from the OLD log.
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
import type {
  JournalBoundaryEntry,
  JournalHunkEntry,
  JournalHunkKind,
} from '@diffstalker/core/types/journal';
import {
  foldEntries,
  type JournalBoundaryRow,
  type JournalHunkRow,
  type JournalRow,
} from '../utils/foldEntries';
import { DIFF_ROW_PX } from '../utils/diffRows';
import { useScrollAnchor, type AnchorCandidate } from '../composables/useScrollAnchor';
import DiffView from '../components/DiffView.vue';
import ViewFileButton from '../components/ViewFileButton.vue';
import { errorMessage } from '../api/errors';

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

// --- Session-local view state ---

/** Commit/boundary rows folded shut, by boundary seq — hides the entries the
 *  boundary retired (its `resolves`) so a committed batch collapses to one
 *  line; click to re-expand. Recently-committed work lingers here, collapsed,
 *  until it ages out of the window. */
const foldedCommits = reactive(new Set<number>());

/** Superseded (re-edited) — kept ONLY to fold dead rows into a folded commit's
 *  section (see hiddenKeys). It carries no UI of its own: a superseded row just
 *  renders as a normal past entry and scrolls away. */
function isOutdated(row: JournalHunkRow): boolean {
  return supersededAt.value.has(row.tip.seq);
}

/** A boundary is foldable when it retired entries (commit / checkout / stash /
 *  op-end carry `resolves`; journal-start / op-start do not). */
function isFoldable(row: JournalBoundaryRow): boolean {
  return row.entry.resolves.length > 0;
}

function toggleCommitFold(key: number): void {
  if (foldedCommits.has(key)) foldedCommits.delete(key);
  else foldedCommits.add(key);
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

/** Past an hour old, freeze to a static wall-clock HH:MM so the column isn't
 *  perpetually re-ticking — only the freshest rows count up live. */
function relTime(ts: number): string {
  if (now.value - ts > 3_600_000) return clock(ts);
  return formatRelativeTime(ts, now.value);
}

function absTime(ts: number): string {
  return formatDateAbsolute(new Date(ts));
}

function clock(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// --- Path display: keep the file name visible on long paths ---

/** The file name (last path segment) — the part worth never ellipsing. */
function fileName(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

/** The directory prefix incl. its trailing slash — the part that ellipses. */
function fileDir(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i + 1);
}

// --- Kind labelling ---

/**
 * A brand-new FILE, vs a new change-region in an existing file. The 'created'
 * kind fires for BOTH (it means "no live hunk overlapped here yet"), so on its
 * own it reads as "new file" even for a one-line edit to a long-lived file —
 * the misleading label. status is the primary tell; the diff's `new file mode`
 * header is the fallback (diff is null for reverted/oversize entries).
 */
function isNewFile(entry: JournalHunkEntry): boolean {
  if (entry.status === 'untracked' || entry.status === 'added') return true;
  return (
    entry.diff?.lines.some(
      (line) => line.type === 'header' && line.content.startsWith('new file mode')
    ) ?? false
  );
}

/**
 * The kind reduced to what a glance needs, three colours: created (a genuinely
 * new file, green), edited (any in-place change — a 'created' region in an
 * existing file, plus expanded/shrunk, since the ±stats already say grew or
 * shrank; amber), and reverted (red). renamed keeps its own value but renders
 * neutral (a path event, not a content change). Drives both the rail and word.
 */
function displayKind(row: JournalHunkRow): JournalHunkKind {
  const k = row.kind;
  if (k === 'created') return isNewFile(row.tip) ? 'created' : 'edited';
  if (k === 'expanded' || k === 'shrunk') return 'edited';
  return k;
}

/** The WORD shown: 'created' reads as "new file" only when it truly is one. */
function kindLabel(row: JournalHunkRow): string {
  const k = displayKind(row);
  return k === 'created' ? 'new file' : k;
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

/** DiffView's row estimate, shared with DiffStack — see utils/diffRows. */
const ROW_PX = DIFF_ROW_PX;
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

/**
 * Hunk-group row keys hidden because their commit boundary is folded. Folding
 * a commit collapses its whole SECTION — every entry between it and the
 * previous boundary — to the one divider line, EXCEPT genuine live survivors
 * (a partial commit's still-dirty hunks, which belong to a future commit).
 *
 * So a row in a folded section hides when it is either:
 *   - resolved by the commit (its live/tip seq is in `resolves`), or
 *   - dead: an outdated stub, superseded before the commit and so absent from
 *     `resolves`. The client's 15s fold window is coarser than the daemon's
 *     component merge, so a slow supersession leaves such a stub behind — this
 *     is what made a lone entry survive an otherwise-clean fold.
 * A row that is live AND unresolved is the survivor and stays visible.
 */
/** The folded boundaries' resolved tip seqs + their section ranges (lo,hi). */
function foldedSectionsAndTips(): {
  resolvedTips: Set<number>;
  sections: { lo: number; hi: number }[];
} {
  const sectionStart = new Map<number, number>();
  let prevBoundarySeq = 0;
  for (const row of rows.value) {
    if (row.type !== 'boundary') continue;
    sectionStart.set(row.key, prevBoundarySeq);
    prevBoundarySeq = row.key;
  }
  const resolvedTips = new Set<number>();
  const sections: { lo: number; hi: number }[] = [];
  for (const row of rows.value) {
    if (row.type !== 'boundary' || !foldedCommits.has(row.key)) continue;
    for (const seq of row.entry.resolves) resolvedTips.add(seq);
    sections.push({ lo: sectionStart.get(row.key) ?? 0, hi: row.key });
  }
  return { resolvedTips, sections };
}

const hiddenKeys = computed(() => {
  const hidden = new Set<number>();
  if (foldedCommits.size === 0) return hidden;
  const { resolvedTips, sections } = foldedSectionsAndTips();
  if (sections.length === 0) return hidden;
  const inSection = (seq: number): boolean => sections.some((s) => seq > s.lo && seq < s.hi);
  for (const row of rows.value) {
    if (row.type !== 'hunk-group') continue;
    // Resolved by the commit, or a dead stub in its section — hide either way.
    if (resolvedTips.has(row.tip.seq) || (isOutdated(row) && inSection(row.tip.seq))) {
      hidden.add(row.key);
    }
  }
  return hidden;
});

/** displayRows minus the entries hidden under a folded commit. */
const visibleDisplayRows = computed(() =>
  displayRows.value.filter((row) => !hiddenKeys.value.has(row.key))
);

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

/**
 * Elements entering/leaving because a commit fold toggled. A newly-hidden row
 * LEAVES — push its current element so the below-fold skip can still apply
 * when it sits below the viewport. A newly-shown row (unfold) ENTERS — push
 * null, which disables the skip so the insert is always compensated.
 */
function foldChangeEls(nextHidden: Set<number>, prevHidden: Set<number>): (HTMLElement | null)[] {
  const els: (HTMLElement | null)[] = [];
  for (const key of nextHidden) {
    if (!prevHidden.has(key)) els.push(entryEls.get(key) ?? null);
  }
  for (const key of prevHidden) {
    if (!nextHidden.has(key)) els.push(null);
  }
  return els;
}

// Pre-flush: DOM still old. Classify each entering row and each commit-fold
// hide/show, then pick and measure the anchor.
watch(
  [rows, hiddenKeys],
  ([nextRows, nextHidden], [prevRows, prevHidden]) => {
    markEnteringRows(nextRows, prevRows);
    const changedEls = [
      ...rowChangeEls(nextRows, prevRows),
      ...foldChangeEls(nextHidden, prevHidden),
    ];
    if (changedEls.length === 0) return;
    anchor.prepare({
      // A row hidden by a fold is no longer a valid anchor target — exclude it
      // so pickAnchor falls back to a row that survives into the next DOM.
      survivingKeys: new Set(
        nextRows.filter((row) => !nextHidden.has(row.key)).map((row) => String(row.key))
      ),
      changedEls,
    });
  },
  { flush: 'pre' }
);

// Post-flush: DOM patched, same task, before paint — compensate.
watch(
  [rows, hiddenKeys],
  ([nextRows]) => {
    anchor.restore();
    committedRows = nextRows;
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
    expandedHuge.clear();
    enterKeys.clear();
    foldedCommits.clear();
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
    loadError.value = errorMessage(err);
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

      <template v-for="row in visibleDisplayRows" :key="row.key">
        <div
          v-if="row.type === 'boundary'"
          :ref="(el) => setEntryEl(row.key, el)"
          class="boundary mono"
          :class="{ foldable: isFoldable(row), folded: foldedCommits.has(row.key) }"
          data-testid="journal-boundary"
          :role="isFoldable(row) ? 'button' : undefined"
          :aria-expanded="isFoldable(row) ? !foldedCommits.has(row.key) : undefined"
          :title="isFoldable(row) ? (foldedCommits.has(row.key) ? 'Show this commit\'s changes' : 'Fold this commit\'s changes') : undefined"
          @click="isFoldable(row) && toggleCommitFold(row.key)"
        >
          <span v-if="isFoldable(row)" class="boundary-fold" aria-hidden="true">{{
            foldedCommits.has(row.key) ? '▸' : '▾'
          }}</span>
          <span class="boundary-label" :title="boundaryText(row.entry)">{{
            boundaryText(row.entry)
          }}</span>
        </div>

        <!-- The reveal wrapper is an inert block until the row enters
             while head-pinned; then it animates open once (see CSS). -->
        <div v-else class="reveal" :class="{ enter: enterKeys.has(row.key) }">
          <article
            :ref="(el) => setEntryEl(row.key, el)"
            class="entry"
            :data-kind="displayKind(row)"
            :data-seq="row.key"
            data-testid="journal-entry"
          >
            <header class="entry-header mono">
              <!-- Kind as a colour-coded word — the site's status idiom
                   (created green / edited amber / reverted red; renamed neutral). -->
              <span class="kind" :data-kind="displayKind(row)" data-testid="kind-badge">{{
                kindLabel(row)
              }}</span>

              <!-- The filename stays bold; the directory ellipsises before it. -->
              <span class="path" :title="row.tip.path"
                ><span v-if="fileDir(row.tip.path)" class="path-dir">{{
                  fileDir(row.tip.path)
                }}</span
                ><span class="path-name">{{ fileName(row.tip.path) }}</span></span
              >

              <ViewFileButton :path="row.tip.path" />

              <!-- ×N: a static marker of how many rapid saves folded into this
                   row — a count, not a button (walking the chain is forensics). -->
              <span v-if="row.members.length > 1" class="fold-count" data-testid="fold-count"
                >×{{ row.members.length }}</span
              >

              <!-- Ragged right cluster: stats, then the time. -->
              <span class="trailer">
                <span class="stats">
                  <span v-if="row.tip.stats.insertions" class="count-add"
                    >+{{ row.tip.stats.insertions }}</span
                  ><span v-if="row.tip.stats.deletions" class="count-del"
                    >&minus;{{ row.tip.stats.deletions }}</span
                  >
                </span>
                <time class="time" :title="absTime(row.tip.ts)">{{ relTime(row.tip.ts) }}</time>
              </span>
            </header>

            <!-- A post-formatter full-file snapshot is unreadable as a blurb:
                 collapse it behind a file-level show row. -->
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
                :mode="ui.diffMode"
              />
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
  padding: 0.5rem var(--gutter) 1rem;
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

/* A foldable boundary (a commit/checkout/stash that retired entries) is a
   click target: collapse its changes to this one line, click to re-expand. */
.boundary.foldable {
  cursor: pointer;
}

.boundary.foldable:hover .boundary-label,
.boundary.foldable:hover .boundary-fold {
  color: var(--text);
}

.boundary-fold {
  flex: none;
  font-size: var(--fs-micro);
}

/* --- Hunk-group entries --- */

.entry {
  /* No card frame (the site uses none): a 2px kind-coloured left rail brackets
     the --surface header + its flat diff. --rail is the single source of truth
     for the kind colour (the rail; the kind word matches it). */
  margin: 0.5rem 0;
  border-left: 2px solid var(--rail, var(--border));
  overflow: hidden; /* keeps the enter-reveal and the rail crisp */
}

.entry[data-kind='created'] {
  --rail: var(--status-added);
}
.entry[data-kind='edited'] {
  --rail: var(--status-modified);
}
.entry[data-kind='reverted'] {
  --rail: var(--status-deleted);
}
/* renamed is a path event, not a content change — a neutral rail, not a
   fourth status colour competing with real edits. */
.entry[data-kind='renamed'] {
  --rail: var(--text-dim);
}

/* The header strip matches the rest of the site (DiffStack / History / the
   diff file headers): flat --surface with hairline top+bottom borders, mono,
   the house padding + gap. One ragged flex line — nothing is forced to align
   across entries; kind + path lead, the trailing cluster recedes right. */
.entry-header {
  display: flex;
  align-items: baseline;
  gap: 0 0.625rem;
  min-width: 0;
  padding: 0.375rem 0.75rem;
  border-top: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
  background: var(--surface);
  font-size: var(--fs-base);
}

/* Kind: a colour-coded word — the site's status idiom (colored text keyed by
   an attribute, no pill). It leads the line; the colour matches the rail. */
.entry-header .kind {
  flex: none;
  font-weight: 600;
}

.kind[data-kind='created'] {
  color: var(--status-added);
}
.kind[data-kind='edited'] {
  color: var(--status-modified);
}
.kind[data-kind='reverted'] {
  color: var(--status-deleted);
}
.kind[data-kind='renamed'] {
  color: var(--text-dim);
}

/* The anchor: a flex row of dir + name. The directory shrinks and ellipses at
   ITS end; the file name never shrinks — so the useful part stays visible on a
   long path (…dir/name). Full path is on the title. */
.path {
  display: flex;
  align-items: baseline;
  min-width: 0;
  overflow: hidden;
  flex: 0 1 auto;
}

.path-dir {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-dim);
}

.path-name {
  flex: none;
  white-space: nowrap;
  font-weight: 600;
  color: var(--text);
  font-size: var(--fs-content); /* the filename is readable content, not chrome */
}

/* ×N: a static, muted marker of how many rapid saves folded into this row —
   a count, not a control. */
.fold-count {
  flex: none;
  padding: 0 0.25rem;
  color: var(--text-dim);
  font-size: var(--fs-micro);
}

/* The ragged right cluster — read on a stop, never scanned as a column.
   margin-left:auto shoves it to the trailing edge; muted + micro. */
.trailer {
  flex: none;
  margin-left: auto;
  display: inline-flex;
  align-items: baseline;
  gap: 0 0.625rem;
  color: var(--text-dim);
  font-size: var(--fs-micro);
}

.trailer .stats {
  display: inline-flex;
  gap: 0 0.375rem;
  font-variant-numeric: tabular-nums;
}

.trailer .time {
  white-space: nowrap;
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
  margin: 0.5rem 0;
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
   the entry's line count, fixed at append (entries are immutable). The diff
   sits flat on --bg below the --surface header; the header's border-bottom is
   the divider, so the body needs no border of its own. */
.entry-body {
  content-visibility: auto;
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
