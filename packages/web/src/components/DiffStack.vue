<script lang="ts">
import type { DiffLine, DiffResult } from '@diffstalker/core/git/diff';
import type { FileStatus } from '@diffstalker/core/git/status';
import { LARGE_DIFF_NOTICE_PREFIX } from '@diffstalker/core/git/diffParse';
import { diffModel, DIFF_ROW_PX, type DiffNotShown } from '../utils/diffRows';
import { splitRowCount } from '../utils/diffSplit';

/**
 * One file section in the stack. Compare keys sections by path; Changes
 * (phase 1) keys them `s:`/`u:` + path so a file both staged and
 * modified gets two sections, mirroring its file list.
 */
export interface StackFile {
  /** Stable section identity — v-for key, scrollToFile/scrollToHunk target. */
  key: string;
  path: string;
  status: FileStatus;
  /** Staged-side section (Changes, phase 1); unused by Compare. */
  staged?: boolean;
  /** Compare's [uncommitted] marker on the header. */
  uncommitted?: boolean;
  stats: { insertions: number; deletions: number };
  /**
   * null = the diff hasn't landed yet (Changes' untracked-file queue,
   * phase 1) — the section renders a stats-sized placeholder instead
   * of a DiffView. Compare always embeds diffs, so never null there.
   */
  diff: DiffResult | null;
  /** Collapse is parent-owned: this renders it, toggle-collapse reports. */
  collapsed?: boolean;
  /** What this section's diff is between; omitted renders no label. */
  refPair?: RefPair;
}

/**
 * Separator between a section key and a hunk key inside an anchor key.
 * NUL can never appear in a git path (so never in a section key), which
 * keeps composite hunk keys collision-free against file keys.
 */
const ANCHOR_SEP = '\u0000';

/**
 * The "no body to render" verdict per DiffResult identity: a cheap
 * header-line scan (the same markers buildDiffModel keys on), memoized so
 * the gate checks never have to build a full model for a diff they will
 * not render. Covers both withheld cases — git's binary marker and the
 * daemon's per-file size cap.
 */
const notShownCache = new WeakMap<DiffResult, DiffNotShown | null>();

/**
 * Exported so a parent can ask the SAME question this stack asks — the
 * Changes view needs it to know which sections are binary (and therefore
 * worth asking the daemon for image metadata about). A second copy of the
 * marker scan in the view would be one more place to drift.
 */
export function notShownForDiff(diff: DiffResult): DiffNotShown | null {
  let cached = notShownCache.get(diff);
  if (cached === undefined) {
    cached = null;
    for (const line of diff.lines) {
      if (line.type !== 'header') continue;
      if (line.content.startsWith('Binary files')) {
        cached = { kind: 'binary', note: 'Binary file — no text diff to show.' };
        break;
      }
      if (line.content.startsWith(LARGE_DIFF_NOTICE_PREFIX)) {
        cached = { kind: 'large', note: line.content };
        break;
      }
    }
    notShownCache.set(diff, cached);
  }
  return cached;
}

/** The heights every body computes its exact intrinsic size from. */
interface ProbeSizes {
  /** One content row (line box; fractional CSS px). */
  rowH: number;
  /** One sticky hunk header, borders included. */
  hunkHeaderH: number;
  /** The border-bottom a non-last hunk carries. */
  hunkBorderB: number;
  /** DiffView's own per-file header (multi-file diffs only). */
  fileHeaderH: number;
  /** One informational header line ("new file mode …"). */
  noteH: number;
  /** Margin between two file sections inside one DiffView. */
  sectionGap: number;
  /**
   * The horizontal scrollbar track of .diff-scroll (0 on overlay-
   * scrollbar platforms). overflow-x: scroll makes the track
   * unconditional, so it is part of EVERY rendered body's height —
   * deterministic, instead of appearing only when a wide line realizes.
   */
  scrollbarH: number;
}

/**
 * Probed values within this tolerance are "the same": a re-delivered
 * ResizeObserver tick or a resize that didn't change the metrics must
 * not republish probeSizes — that would re-render every body style and
 * drop the offset cache for nothing.
 */
const PROBE_EPSILON = 0.1;

function sameProbeSizes(a: ProbeSizes, b: ProbeSizes): boolean {
  return (
    Math.abs(a.rowH - b.rowH) < PROBE_EPSILON &&
    Math.abs(a.hunkHeaderH - b.hunkHeaderH) < PROBE_EPSILON &&
    Math.abs(a.hunkBorderB - b.hunkBorderB) < PROBE_EPSILON &&
    Math.abs(a.fileHeaderH - b.fileHeaderH) < PROBE_EPSILON &&
    Math.abs(a.noteH - b.noteH) < PROBE_EPSILON &&
    Math.abs(a.sectionGap - b.sectionGap) < PROBE_EPSILON &&
    Math.abs(a.scrollbarH - b.scrollbarH) < PROBE_EPSILON
  );
}

/**
 * A tiny constant diff for the hidden size probe: two files (so the
 * probe DiffView shows file headers and a measurable section gap), a
 * note line, two hunks in file A (the first carries the inter-hunk
 * border), and plain rows. Hand-built DiffLines — no parser import.
 */
const PROBE_LINES: DiffLine[] = [
  { type: 'header', content: 'diff --git a/__probe__/a b/__probe__/a' },
  { type: 'header', content: 'new file mode 100644' },
  { type: 'hunk', content: '@@ -0,0 +1,2 @@' },
  { type: 'addition', content: '+one', newLineNum: 1 },
  { type: 'addition', content: '+two', newLineNum: 2 },
  { type: 'hunk', content: '@@ -10 +11 @@ probe' },
  { type: 'context', content: ' ctx', oldLineNum: 10, newLineNum: 11 },
  { type: 'header', content: 'diff --git a/__probe__/b b/__probe__/b' },
  { type: 'hunk', content: '@@ -1 +1 @@' },
  { type: 'deletion', content: '-x', oldLineNum: 1 },
  { type: 'addition', content: '+y', newLineNum: 1 },
];

const PROBE_DIFF: DiffResult = { lines: PROBE_LINES };

/** Rows in the probe's FIRST hunk (its height check derives the border). */
const PROBE_FIRST_HUNK_ROWS = 2;

/**
 * Files with more changed lines than this start collapsed behind a
 * "Load diff" affordance (GitHub's escape hatch) — the worst-case DOM
 * cap: their DiffView is not even mounted until the user asks for it.
 */
export const HUGE_FILE_CHANGED_LINES = 1500;
</script>

<script setup lang="ts">
/**
 * DiffStack: the stacked "all diffs on one page" surface — ONE scroll
 * container holding a section per file: a sticky header (status letter
 * / path / stats / collapse chevron) over the file's DiffView.
 * Extracted from CompareView's diffs column (phase 0C of
 * docs/web-diff-stream-architecture.md); Changes moves onto it in
 * phase 1.
 *
 * Eager DOM: every section stays mounted. Off-screen cost is bounded
 * by content-visibility: auto on each body wrapper, so a far-away file
 * skips layout and paint as one unit (rows keep their own per-row c-v
 * inside DiffView). content-visibility sits on the BODY, never the
 * section — on the section it would break the sticky header inside it.
 *
 * Exact intrinsic sizes (phase 2): each body's contain-intrinsic-size
 * is COMPUTED from its model's row/hunk/note counts times constants
 * probed once from a hidden sample DiffView (re-probed on resize/zoom).
 * The probed row height is also published as the `--row-h` CSS var, so
 * the ROW-level contain-intrinsic-size inside DiffView uses the same
 * constant — one source of truth; a second hardcoded row constant
 * would make skipped and realized heights disagree, and every c-v
 * realization would shift offsets (the freeze fuel). With drift gone,
 * the body-level value carries the `auto` keyword: once a body has
 * been realized, the browser's remembered size (identical to ours)
 * wins on re-skip. Bodies without a computable height (placeholders,
 * empty/binary diffs) keep the stats-based estimate.
 *
 * Scroll anchoring (phase 2): overflow-anchor is off and useScrollAnchor
 * runs its pre-flush/post-flush sandwich around every change to the
 * rendered file set, so churn above the viewport never moves what the
 * user is looking at. A ResizeObserver over the bodies is the safety
 * net for any OUT-of-flush height change (it would mean the exact-size
 * assumption drifted): it re-caches the height, invalidates the offset
 * cache, and NOTHING more — observers never write scrollTop (see the
 * callback). When nothing churns (Compare's static diffs) all of this
 * is inert: no changed sections → no anchor, no size deltas → a silent
 * observer.
 *
 * Scrolling (phase 1): scrollToFile/scrollToHunk route through
 * useStackScroll's retargeting rAF tween (smooth by default; instant on
 * smooth:false / prefers-reduced-motion). Targets are re-read every
 * frame, so a churn commit landing mid-glide self-corrects — and the
 * anchor sandwich yields to the tween (isTweening) instead of writing
 * scrollTop against it. Positions are scroller-relative — never
 * scrollIntoView, which scrolls every ancestor and ignores sticky
 * headers. 'active-file' is emitted whenever the active key changes:
 * optimistically on programmatic jumps, and from the composable's
 * binary-search scroll-spy as the user scrolls.
 *
 * Huge files: a StackFile that FIRST APPEARS past
 * HUGE_FILE_CHANGED_LINES changed lines starts collapsed behind a
 * "Load diff" affordance; its DiffView mounts only after that explicit
 * click — the ONLY path that mounts a huge body. The gate latches: a
 * file already rendered small whose stats later grow past the cap
 * keeps its body (never unmounted mid-view). Manual (parent-owned)
 * collapse is unchanged.
 *
 * Binary files never get a diff body and never get the huge gate. They
 * render a FIXED-HEIGHT strip where the body would be: the plain "Binary
 * file" note, or — when the parent lists the section in `mediaKeys` —
 * the `media` slot, which the Changes view fills with an image card.
 * Auto-mode jumps land on the section top of gated/binary files without
 * expanding anything.
 *
 * Every strip SHAPE is measured into its OWN height slot (see
 * stripHeight): the binary note, the large-file notice, the media card,
 * the "Load diff" gate. That is not tidiness: a height slot is memoized
 * once and then reused for every unmeasured section of that kind, so two
 * body shapes sharing one slot desync every section offset below the
 * first mismatch, compounding as (N-1) x delta — which surfaces as the
 * scroll spy naming the wrong file.
 *
 * Which is why every strip is a FIXED height by construction, not by
 * hope. The media card sizes its three bands from CSS variables, so it is
 * the same height loading, loaded, failed and in every mode. The notes
 * are clamped to a single line: the large-file notice embeds a per-file
 * size and line count ("Large file — diff not shown (18.3 MB, 121,285
 * lines)"), which left to wrap would make two large sections different
 * heights on a narrow card — and the second one would be sized by the
 * first one's text. The full text stays reachable as the strip's title.
 */

import {
  nextTick,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  watch,
  type ComponentPublicInstance,
} from 'vue';
import { statusLetter } from '../utils/format';
import { usePortrait } from '../composables/useMediaQuery';
import { useScrollAnchor, type AnchorCandidate } from '../composables/useScrollAnchor';
import {
  useStackScroll,
  type SectionHeightModel,
  type StackSection,
} from '../composables/useStackScroll';
import DiffView from './DiffView.vue';
import ViewFileButton from './ViewFileButton.vue';
import CopyPathButton from './CopyPathButton.vue';
import WholeFileToggle from './WholeFileToggle.vue';
import RefPairLabel from './RefPairLabel.vue';
import type { RefPair } from '../utils/refPair';
import WrapToggle from './WrapToggle.vue';

const props = defineProps<{
  files: StackFile[];
  /** Key of the section styled as selected (nav highlight), if any. */
  activeKey?: string | null;
  /** Forwarded to each file's DiffView: syntax-highlight content lines. */
  syntax?: boolean;
  /** Forwarded to each file's DiffView: unified or side-by-side split. */
  mode?: 'unified' | 'split';
  /**
   * Forwarded to each file's DiffView: wrap long lines. Also disables
   * this stack's own exact per-file height computation (see
   * exactBodyHeight) — a wrapped file's real height depends on how many
   * lines its long lines wrap into, which this stack has no cheap way to
   * know exactly, so it falls back to the (rougher, already-existing)
   * stats-based estimate and stops content-visibility-skipping that
   * file's body, trading the off-screen-skip optimization for a height
   * promise it can actually keep. Same applies to sectionHeightModel's
   * arithmetic offsets (the scroll spy's OTHER consumer of that same
   * height promise) — it returns null while wrap is on, falling back to
   * the DOM-read path, for the same reason.
   */
  wrap?: boolean;
  /**
   * Section keys whose binary placeholder is replaced by the `media`
   * slot (an image card). The parent REPLACES this Set, never mutates
   * it — like `files`, the watchers below key on its identity, and an
   * in-place mutation would change the rendered heights with no anchor
   * sandwich around it.
   */
  mediaKeys?: Set<string>;
  /**
   * Whole-file mode, opt-in per surface. Undefined (Compare, for now)
   * renders no toggle at all — the control only appears where the owner
   * can actually serve it, which today is Changes. `wholeKey` is the one
   * section drawn in full; the mode is one file at a time by design.
   */
  wholeKey?: string | null;
  wholeLoading?: boolean;
  showWholeToggle?: boolean;
  /** Key + reason when the last whole-file request could not be served. */
  wholeRefusal?: { key: string; reason: string } | null;
}>();

const emit = defineEmits<{
  'active-file': [key: string];
  'toggle-collapse': [key: string];
  'toggle-whole': [key: string];
}>();

const scrollerEl = ref<HTMLElement | null>(null);
const toolbarEl = ref<HTMLElement | null>(null);

/** Section elements by key, kept by the v-for ref callbacks. */
const sectionEls = new Map<string, HTMLElement>();

function setSectionEl(key: string, el: Element | ComponentPublicInstance | null): void {
  if (el instanceof HTMLElement) sectionEls.set(key, el);
  else sectionEls.delete(key);
}

// --- Withheld diffs (binary, over the size cap): placeholder-only ---

/**
 * These sections never get a diff body and never get the huge-file "Load
 * diff" gate (there is nothing to reveal; the daemon did not send
 * content). Two cases share the shape:
 *  - binary files, per git's own marker. A binary section can still
 *    carry the `media` slot instead of the note — see isMediaSection;
 *  - files over the daemon's per-file diff cap, whose note carries the
 *    measured size so the reader knows what was withheld.
 */
function notShownFor(item: StackFile): DiffNotShown | null {
  return item.diff === null ? null : notShownForDiff(item.diff);
}

/**
 * This section renders the `media` slot instead of the note: the parent
 * has metadata for it AND git called it binary. The `kind` check is what
 * keeps an over-cap TEXT file out of an image card even if a key ever
 * leaked through.
 */
function isMediaSection(item: StackFile): boolean {
  return notShownFor(item)?.kind === 'binary' && (props.mediaKeys?.has(item.key) ?? false);
}

// --- Huge files: "Load diff" gate ---

/** Huge files the user explicitly loaded (per-key, view lifetime). */
const loadedHugeKeys = reactive(new Set<string>());

/**
 * Keys that have appeared BELOW the threshold (the latch): a file
 * already rendered whose stats later grow past the cap keeps its body
 * — unmounting content mid-view would yank it from under the reader.
 * Only files that FIRST APPEAR past the threshold are gated. A plain
 * Set: it only grows alongside props.files changes (latched in the
 * pre-flush watcher, before the re-render that reads it).
 */
const renderedSmallKeys = new Set<string>();

function latchSmallKeys(files: StackFile[]): void {
  for (const item of files) {
    if (item.stats.insertions + item.stats.deletions <= HUGE_FILE_CHANGED_LINES) {
      renderedSmallKeys.add(item.key);
    }
  }
}
latchSmallKeys(props.files);

function isHuge(item: StackFile): boolean {
  return item.stats.insertions + item.stats.deletions > HUGE_FILE_CHANGED_LINES;
}

/**
 * Whether the "whole file" toggle appears for a section at all.
 *
 * An untracked file is excluded rather than disabled: its diff already IS
 * the whole file, so a control offering to widen it would be a control
 * that does nothing. Everything else that cannot widen (binary, image,
 * a diff the daemon withheld) keeps the control and disables it with a
 * reason — those are cases where the reader might reasonably expect it.
 *
 * Deliberately NOT gated on isHuge. The huge-file threshold reads stats,
 * which context does not move, so a whole-file body can never trip it;
 * and the latch in renderedSmallKeys already keeps a file the reader is
 * looking at from being yanked behind "Load diff". The payload itself is
 * bounded by the daemon's per-file diff cap, not by this gate.
 */
function canGoWhole(item: StackFile): boolean {
  // A file that did not exist on the old side is ALREADY whole: every one
  // of its lines is an addition, and there is no unchanged text for wider
  // context to reveal. Offering the control there would be offering a
  // control that does nothing.
  return item.status !== 'untracked' && item.status !== 'added';
}

/** Why the toggle is disabled, or null when it works. */
function wholeDisabledReason(item: StackFile): string | null {
  // A refusal the reader just triggered outranks the static reasons: it
  // explains why the click they made did nothing visible.
  if (props.wholeRefusal?.key === item.key) return props.wholeRefusal.reason;
  const notShown = notShownFor(item);
  if (notShown !== null) {
    return notShown.kind === 'binary'
      ? 'Binary file — there is no text to show'
      : 'Diff withheld: this file is over the size cap';
  }
  if (isUnloaded(item)) return 'Load the diff first';
  return null;
}

/** True while a huge file's body is gated behind "Load diff". */
function isUnloaded(item: StackFile): boolean {
  return (
    isHuge(item) &&
    notShownFor(item) === null &&
    !loadedHugeKeys.has(item.key) &&
    !renderedSmallKeys.has(item.key)
  );
}

/**
 * The EFFECTIVE collapse: the parent's manual collapse OR the unloaded
 * huge-file gate. Everything geometric (anchors, surviving keys, the
 * height assert) reads this, never item.collapsed directly.
 */
function isCollapsed(item: StackFile): boolean {
  return !!item.collapsed || isUnloaded(item);
}

function loadHugeDiff(key: string): void {
  loadedHugeKeys.add(key);
  // The body mounts below the click point; offsets below it moved.
  void nextTick(() => stackScroll.invalidateOffsets());
}

/**
 * Mount every body still behind the "Load diff" gate, and report how
 * many. This is what lets browser find-in-page reach the whole
 * changeset — the gate is the only content the DOM withholds.
 *
 * Withheld diffs (no bytes fetched at all) are not gated files and are
 * untouched; there is nothing to reveal. Already-loaded files are a
 * no-op, so pressing this twice costs nothing.
 */
function expandAllGated(): number {
  const gated = props.files.filter((item) => isUnloaded(item));
  for (const item of gated) loadedHugeKeys.add(item.key);
  if (gated.length > 0) void nextTick(() => stackScroll.invalidateOffsets());
  return gated.length;
}

// --- Exact intrinsic sizes (probe) ---

const probeEl = ref<HTMLElement | null>(null);
const probeDiff = PROBE_DIFF;
const probeSizes = ref<ProbeSizes | null>(null);
let probeRo: ResizeObserver | null = null;

/**
 * Measure the ~4 height constants from the hidden probe DiffView. All
 * getBoundingClientRect (fractional px): rows stack block-on-block, so
 * N × the measured row height IS the exact realized height. Bails
 * (keeping the estimate path) when the probe has no real layout — e.g.
 * under happy-dom in tests, where every rect is zero.
 */
function measureProbe(): void {
  const root = probeEl.value;
  if (!root) return;
  const scroll = root.querySelector<HTMLElement>('.diff-scroll');
  const row = root.querySelector<HTMLElement>('.row');
  const hunk = root.querySelector<HTMLElement>('.hunk');
  const hunkHeader = root.querySelector<HTMLElement>('.hunk-header');
  const fileHeader = root.querySelector<HTMLElement>('.file-header');
  const note = root.querySelector<HTMLElement>('.file-note');
  const sections = root.querySelectorAll<HTMLElement>('.file-section');
  if (!scroll || !row || !hunk || !hunkHeader || !fileHeader || !note || sections.length < 2)
    return;

  const rowH = row.getBoundingClientRect().height;
  if (rowH <= 0) return; // no layout engine (tests) or hidden — keep estimates

  const hunkHeaderH = hunkHeader.getBoundingClientRect().height;
  const hunkBorderB = Math.max(
    0,
    hunk.getBoundingClientRect().height - hunkHeaderH - PROBE_FIRST_HUNK_ROWS * rowH
  );
  const next: ProbeSizes = {
    rowH,
    hunkHeaderH,
    hunkBorderB,
    fileHeaderH: fileHeader.getBoundingClientRect().height,
    noteH: note.getBoundingClientRect().height,
    sectionGap:
      sections[1].getBoundingClientRect().top - sections[0].getBoundingClientRect().bottom,
    // The always-on horizontal track (overflow-x: scroll): offsetHeight
    // includes it, clientHeight doesn't. The probe viewport gives
    // .diff-scroll a definite height so the subtraction is real.
    scrollbarH: Math.max(0, scroll.offsetHeight - scroll.clientHeight),
  };

  // Epsilon bail: unchanged constants must not republish — a fresh
  // probeSizes object re-renders every body style and drops the offset
  // cache, and this runs from a ResizeObserver and window resize.
  const prev = probeSizes.value;
  if (prev !== null && sameProbeSizes(prev, next)) return;

  // A GENUINE change (zoom, font swap) resizes every computed body:
  // hold the viewport through the re-render exactly like a files
  // commit — prepare against the old DOM now, restore after Vue
  // patches the new sizes in (nextTick runs post-render, pre-paint).
  anchor.prepare({ survivingKeys: survivingKeys(committedFiles), changedEls: [null] });
  probeSizes.value = next;
  // Publish the probed row height as the ONE row constant: the
  // row-level contain-intrinsic-size in DiffView (and FileContentPane)
  // reads var(--row-h), so skipped rows occupy exactly the height this
  // model computes — no drift, no offset shift on realization.
  document.documentElement.style.setProperty('--row-h', `${rowH}px`);
  // Stack chrome (header height, section gap) shares the font metrics
  // that just changed: drop that cache too.
  stackChrome = {};
  // Fresh constants resize every computed body: the spy/tween offset
  // cache is stale the moment they land.
  stackScroll.invalidateOffsets();
  void nextTick(() => {
    anchor.restore();
    publishStackHeaderH();
  });
}

/**
 * Height estimate for a body without a computable exact height: the
 * placeholder branch (no diff yet) and empty/binary diffs. Changed
 * lines at DiffView's row height, plus what stats don't count — a
 * header row per hunk and the surrounding context lines.
 */
const ROW_PX = DIFF_ROW_PX;
const CONTEXT_ROWS_PER_HUNK = 7; // 1 hunk-header row + ~6 context lines
const CHANGED_LINES_PER_HUNK = 10; // rough hunk-count guess
const MIN_PX = 48;

function estimateBodyHeight(item: StackFile): number {
  // With a diff in hand, COUNT the rows instead of guessing from stats.
  // The stats guess assumes ~3 lines of context per hunk, which is true
  // only of a -U3 body: a whole-file diff carries every unchanged line
  // too, so the guess under-sizes it by roughly twenty times, and the
  // stack's arithmetic offsets are built on this number. Counting is
  // also strictly better for the ordinary path — diffModel is memoized
  // per DiffResult, and every caller here already builds it.
  if (item.diff) {
    const rows = diffModel(item.diff, item.staged ?? false).rowCount;
    if (rows > 0) return Math.max(rows * ROW_PX, MIN_PX);
  }
  const changed = item.stats.insertions + item.stats.deletions;
  const hunks = Math.max(1, Math.ceil(changed / CHANGED_LINES_PER_HUNK));
  return Math.max((changed + hunks * CONTEXT_ROWS_PER_HUNK) * ROW_PX, MIN_PX);
}

/**
 * The exact realized height of a body, from its model's counts × the
 * probed constants; null when not computable (no diff, no probe yet,
 * or an empty/binary model that renders prose instead of rows).
 */
function exactBodyHeight(item: StackFile): number | null {
  // Wrap mode: a wrapped line's height is no longer the constant rowH
  // this formula multiplies by, so an "exact" height here would just be
  // wrong. Null routes callers to the estimate, and to turning this
  // body's content-visibility off entirely (see the wrap-mode CSS below)
  // rather than trusting an inexact placeholder.
  if (props.wrap) return null;
  const sizes = probeSizes.value;
  if (!sizes || !item.diff) return null;
  const model = diffModel(item.diff, item.staged ?? false);
  if (model.rowCount === 0) return null;
  const withHeaders = model.sections.filter((s) => s.filePath !== null).length > 1;
  // Split bodies keep .diff-scroll's always-on horizontal track (their
  // panes scroll on their own); a unified embedded body is overflow:visible
  // (no track — long lines scroll the stack), so it adds no scrollbar height.
  let height = props.mode === 'split' ? sizes.scrollbarH : 0;
  model.sections.forEach((section, i) => {
    if (i > 0) height += sizes.sectionGap;
    if (withHeaders && section.filePath !== null) height += sizes.fileHeaderH;
    height += section.notes.length * sizes.noteH;
    section.hunks.forEach((hunk, j) => {
      // Split view collapses each del/add run to max(dels, adds) rows, so
      // the visual row count differs from the unified length — count the
      // rows the chosen mode actually renders (a split line is one text
      // line tall, the same probed rowH).
      const rowCount = props.mode === 'split' ? splitRowCount(hunk.rows) : hunk.rows.length;
      height += sizes.hunkHeaderH + rowCount * sizes.rowH;
      if (j < section.hunks.length - 1) height += sizes.hunkBorderB;
    });
  });
  return height;
}

/**
 * Inline contain-intrinsic-size value: exact when possible, else
 * estimate. The `auto` keyword makes the browser's last REMEMBERED
 * realized size win on re-skip — with drift eliminated it equals the
 * computed value, and remembering means a realize/re-skip cycle can
 * never change the body's occupied height (no offset shift, no RO
 * churn).
 */
function bodyIntrinsicSize(item: StackFile): string {
  return `auto ${exactBodyHeight(item) ?? estimateBodyHeight(item)}px`;
}

// --- Arithmetic section offsets (useStackScroll's height model) ---

/**
 * Stack chrome heights, measured lazily ONCE and cached: the sticky
 * section header (identical for every section — one nowrap line), the
 * inter-section margin, and the two fixed strips (binary note /
 * "Load diff"). Each first measurement is a DOM read; every later
 * offset rebuild is pure arithmetic. That is the point: the rebuild
 * runs under per-frame invalidation churn (bodyRo, files commits,
 * resize), and reading the DOM there forces a full-stack synchronous
 * layout per scroll frame — the historic freeze. Reset by measureProbe
 * when the font metrics genuinely change.
 */
let stackChrome: {
  headerH?: number;
  gap?: number;
  borderY?: number;
  notShownBinaryH?: number;
  notShownLargeH?: number;
  notShownMediaH?: number;
  loadDiffH?: number;
  toolbarH?: number;
} = {};

/**
 * The strip slots stripHeight memoizes, one per BODY SHAPE.
 *
 * The two withheld-diff notes are two shapes, not one: "Binary file — no
 * text diff to show." is a fixed sentence, while the large-file notice
 * embeds the measured size and line count ("Large file — diff not shown
 * (18.3 MB, 121,285 lines)") and so differs from file to file. Both are
 * clamped to one line (see .not-shown-note), which is what makes a single
 * memoized height true for either — and they keep separate slots so that
 * the clamp is the only thing holding, never "the first note measured
 * happened to be the same height as the rest".
 */
type StripSlot = 'notShownBinaryH' | 'notShownLargeH' | 'notShownMediaH' | 'loadDiffH';

/** The DOM selector each strip slot measures. */
const STRIP_SELECTOR: Record<StripSlot, string> = {
  notShownBinaryH: '.not-shown-binary',
  notShownLargeH: '.not-shown-large',
  notShownMediaH: '.not-shown-media',
  loadDiffH: '.load-diff',
};

/** The wrap-toggle toolbar's own height — the height model's `start`
 * offset before the first section, so the spy's arithmetic offsets
 * agree with where sections actually sit (the toolbar is an in-flow
 * sibling, not part of any section). */
function chromeToolbarH(): number | null {
  if (stackChrome.toolbarH === undefined) {
    if (!toolbarEl.value) return null;
    stackChrome.toolbarH = toolbarEl.value.getBoundingClientRect().height;
  }
  return stackChrome.toolbarH ?? null;
}

/**
 * The card's own block-axis chrome on `.file-diff` — border-top +
 * border-bottom (plus any padding, should one ever be added). Every
 * section carries it, so it is a flat per-section constant that has to
 * enter `sectionOuterHeight`; without it each section's arithmetic top
 * drifts by this much MORE than the one above, compounding down the
 * stack until a jump to the last file lands visibly wrong.
 *
 * Computed style, not layout: resolved widths are plain lengths, so this
 * costs no reflow. The `|| 0` guards are load-bearing — happy-dom returns
 * '' for unset widths, and one NaN here silently poisons every cumulative
 * offset in useStackScroll rather than throwing.
 */
function chromeBorderY(): number | null {
  if (stackChrome.borderY === undefined) {
    for (const el of sectionEls.values()) {
      const cs = getComputedStyle(el);
      stackChrome.borderY =
        (parseFloat(cs.borderTopWidth) || 0) +
        (parseFloat(cs.borderBottomWidth) || 0) +
        (parseFloat(cs.paddingTop) || 0) +
        (parseFloat(cs.paddingBottom) || 0);
      break;
    }
  }
  return stackChrome.borderY ?? null;
}

function chromeHeaderH(): number | null {
  if (stackChrome.headerH === undefined) {
    for (const el of sectionEls.values()) {
      const header = el.querySelector<HTMLElement>('.file-diff-header');
      if (header) {
        stackChrome.headerH = header.getBoundingClientRect().height;
        break;
      }
    }
  }
  return stackChrome.headerH ?? null;
}

/**
 * Publish the sticky file-header height as --stack-header-h on the scroller,
 * so each embedded DiffView pins its sticky hunk headers just BELOW the file
 * header instead of behind it. Called on mount and whenever the font metrics
 * change (measureProbe) — the header height rides the same metrics.
 */
function publishStackHeaderH(): void {
  const scroller = scrollerEl.value;
  const h = chromeHeaderH();
  if (scroller && h !== null) {
    scroller.style.setProperty('--stack-header-h', `${h}px`);
  }
}

/** The `.file-diff + .file-diff` margin; 0 when there is one section. */
function chromeGap(): number | null {
  if (props.files.length <= 1) return 0;
  if (stackChrome.gap === undefined) {
    const second = sectionEls.get(props.files[1].key);
    if (!second) return null;
    // Computed style, not layout: a resolved margin is a plain length.
    stackChrome.gap = parseFloat(getComputedStyle(second).marginTop) || 0;
  }
  return stackChrome.gap;
}

/**
 * The height of ONE fixed strip kind, measured from the first section
 * that renders it and then reused for every other section of that kind.
 *
 * The reuse is the whole point (it keeps the offset rebuild free of DOM
 * reads) and also the whole danger: every strip sharing a slot must be
 * the same height in every state, which is why each BODY SHAPE gets its
 * own slot rather than one shared "not shown" slot. A shape that
 * borrowed another's slot would misplace every section below the first
 * mismatch, compounding down the stack.
 */
function stripHeight(slot: StripSlot, key: string): number | null {
  if (stackChrome[slot] === undefined) {
    const strip = sectionEls.get(key)?.querySelector<HTMLElement>(STRIP_SELECTOR[slot]);
    if (!strip) return null;
    stackChrome[slot] = strip.getBoundingClientRect().height;
  }
  return stackChrome[slot] ?? null;
}

/**
 * Which fixed strip this section renders where a body would be, or null
 * when it renders a real body. THE ONE PLACE that choice is made, so the
 * height model, the DEV guard and the template can never disagree about
 * which slot a section belongs to — and no two body shapes (the two
 * note kinds, the much taller media card) can share one memoized height.
 */
function stripSlotFor(item: StackFile): StripSlot | null {
  const notShown = notShownFor(item);
  if (notShown !== null) {
    if (isMediaSection(item)) return 'notShownMediaH';
    return notShown.kind === 'binary' ? 'notShownBinaryH' : 'notShownLargeH';
  }
  return isUnloaded(item) ? 'loadDiffH' : null;
}

/**
 * The note's kind class — the measurement hook stripSlotFor picks by.
 * Styling stays on the shared .not-shown-note; only the height slots are
 * per kind.
 */
function notShownClass(item: StackFile): string {
  return notShownFor(item)?.kind === 'binary' ? 'not-shown-binary' : 'not-shown-large';
}

/**
 * Outer section height (card chrome + header + visible body); null =
 * unknowable. `borderY` is the card's own border-box chrome and applies to
 * EVERY branch — a branch that forgets it drifts only for sections of that
 * kind, which is the hardest version of this bug to see.
 */
function sectionOuterHeight(
  item: StackFile,
  headerH: number,
  borderY: number
): number | null {
  if (item.collapsed) return borderY + headerH; // v-show hides every body variant
  const slot = stripSlotFor(item);
  if (slot !== null) {
    const h = stripHeight(slot, item.key);
    return h === null ? null : borderY + headerH + h;
  }
  // Exact model height; the estimate branches (placeholder, empty
  // diff) match the inline sizing the body renders with, so the
  // arithmetic top stays honest within the spy's hysteresis.
  return borderY + headerH + (exactBodyHeight(item) ?? estimateBodyHeight(item));
}

/**
 * The height model handed to useStackScroll: lets it rebuild the
 * spy/tween offset cache with ZERO per-section DOM reads. Null (full
 * DOM fallback) only when no probe has landed (tests, first paint), a
 * chrome piece cannot be measured yet, OR wrap mode is on — wrapped
 * bodies render at content-visibility:visible (see exactBodyHeight),
 * so sectionOuterHeight's estimateBodyHeight fallback no longer
 * matches what actually renders; the DOM-read fallback is the only
 * honest source of section offsets while that's true.
 */
function sectionHeightModel(): SectionHeightModel | null {
  if (probeSizes.value === null || props.wrap) return null;
  const headerH = chromeHeaderH();
  const gap = chromeGap();
  const toolbarH = chromeToolbarH();
  const borderY = chromeBorderY();
  if (headerH === null || gap === null || toolbarH === null || borderY === null) return null;
  const byKey = new Map(props.files.map((f) => [f.key, f]));
  return {
    start: toolbarH, // the toolbar sits in-flow before the first section
    gap,
    heightFor: (key) => {
      const item = byKey.get(key);
      return item === undefined ? null : sectionOuterHeight(item, headerH, borderY);
    },
  };
}

// --- Scroll anchoring (the sandwich) ---

/**
 * The file set the CURRENT DOM was rendered from: prepare() must build
 * its candidates against the old world while props.files already holds
 * the new one. Updated post-flush. (Callers must replace `files`, never
 * mutate it in place — both views feed a computed, which does.)
 */
let committedFiles: StackFile[] = props.files;

function hunkAnchorKey(fileKey: string, hunkKey: string): string {
  return `${fileKey}${ANCHOR_SEP}${hunkKey}`;
}

/**
 * Anchorable elements of the current DOM in document order: each file
 * section element, then its hunk group elements (the non-sticky .hunk
 * wrappers — a STUCK sticky header's rect would not move with its
 * content, which would break the delta). Collapsed/placeholder sections
 * contribute only their section element.
 */
function anchorCandidates(): AnchorCandidate[] {
  const out: AnchorCandidate[] = [];
  for (const item of committedFiles) {
    const sectionEl = sectionEls.get(item.key);
    if (!sectionEl) continue;
    out.push({ key: item.key, kind: 'file', fileKey: item.key, el: sectionEl });
    if (isCollapsed(item) || !item.diff) continue;
    const model = diffModel(item.diff, item.staged ?? false);
    const hunkEls = sectionEl.querySelectorAll<HTMLElement>('.hunk');
    let i = 0;
    for (const section of model.sections) {
      for (const hunk of section.hunks) {
        const el = hunkEls[i++];
        if (el) out.push({ key: hunkAnchorKey(item.key, hunk.key), kind: 'hunk', fileKey: item.key, el });
      }
    }
  }
  return out;
}

/**
 * Anchor key → element in the CURRENT (post-patch) DOM. Only called by
 * restore(), so the hunk index must come from the NEW models
 * (props.files) — the DOM was just patched to them; the old model's
 * index would point at the wrong element when a hunk was inserted or
 * removed above the anchor within the same file.
 */
function resolveAnchorEl(key: string): HTMLElement | null {
  const sep = key.indexOf(ANCHOR_SEP);
  if (sep === -1) return sectionEls.get(key) ?? null;
  const fileKey = key.slice(0, sep);
  const hunkKey = key.slice(sep + 1);
  const sectionEl = sectionEls.get(fileKey);
  const item = props.files.find((f) => f.key === fileKey);
  if (!sectionEl || !item?.diff || isCollapsed(item)) return null;
  const model = diffModel(item.diff, item.staged ?? false);
  let i = 0;
  for (const section of model.sections) {
    for (const hunk of section.hunks) {
      if (hunk.key === hunkKey) return sectionEl.querySelectorAll<HTMLElement>('.hunk')[i] ?? null;
      i++;
    }
  }
  return null;
}

const anchor = useScrollAnchor(scrollerEl, {
  candidates: anchorCandidates,
  resolve: resolveAnchorEl,
  // The sandwich yields to the tween: the tween re-reads its target per
  // frame and absorbs content shifts itself (burst-during-glide case).
  isTweenActive: () => stackScroll.isTweening(),
});

/** Every anchor key (file + hunk) the NEXT file set will render. */
function survivingKeys(next: StackFile[]): Set<string> {
  const keys = new Set<string>();
  for (const item of next) {
    keys.add(item.key);
    if (!item.diff || isCollapsed(item)) continue; // collapsed hunks are unmeasurable
    const model = diffModel(item.diff, item.staged ?? false);
    for (const section of model.sections) {
      for (const hunk of section.hunks) keys.add(hunkAnchorKey(item.key, hunk.key));
    }
  }
  return keys;
}

/**
 * Which sections change in this commit. Identity comparison is enough:
 * unchanged files keep the same DiffResult object (the store's identity
 * preservation), so Compare's static recomputes yield an empty set and
 * the whole sandwich stays inert. `null` = a section entering the model
 * (no old element to measure).
 */
function diffChanges(next: StackFile[]): {
  els: (HTMLElement | null)[];
  changedKeys: string[];
} {
  const els: (HTMLElement | null)[] = [];
  const changedKeys: string[] = [];
  const prevByKey = new Map(committedFiles.map((f) => [f.key, f]));
  const nextKeys = new Set(next.map((f) => f.key));
  for (const item of committedFiles) {
    if (!nextKeys.has(item.key)) els.push(sectionEls.get(item.key) ?? null);
  }
  for (const item of next) {
    const prev = prevByKey.get(item.key);
    if (!prev) {
      els.push(null);
      changedKeys.push(item.key);
    } else if (prev.diff !== item.diff || isCollapsed(prev) !== isCollapsed(item)) {
      // Effective collapse: also catches a stats change flipping a file
      // across the huge-file gate (its body mounts/unmounts).
      els.push(sectionEls.get(item.key) ?? null);
      changedKeys.push(item.key);
    }
  }
  // A pure reorder moves sections without changing any one of them;
  // report one unmeasurable change so compensation still runs.
  if (els.length === 0) {
    const sameOrder =
      next.length === committedFiles.length &&
      next.every((f, i) => f.key === committedFiles[i].key);
    if (!sameOrder) els.push(null);
  }
  return { els, changedKeys };
}

/** Changed keys of the in-flight commit, for the post-flush recache. */
let pendingChangedKeys: string[] = [];

// Pre-flush: DOM still old — pick and measure the anchor, then latch
// the gate for the coming render. Latching LAST keeps the effective
// collapse honest inside diffChanges: a gated file whose stats drop
// below the cap must still read as a collapse flip (its body mounts).
watch(
  () => props.files,
  (next) => {
    const changes = diffChanges(next);
    pendingChangedKeys = changes.changedKeys;
    anchor.prepare({ survivingKeys: survivingKeys(next), changedEls: changes.els });
    latchSmallKeys(next);
  },
  { flush: 'pre' }
);

// Post-flush: DOM patched, same task, before paint — compensate.
watch(
  () => props.files,
  (next) => {
    anchor.restore();
    committedFiles = next;
    // Section offsets moved with the content: the spy and any in-flight
    // tween must re-read fresh geometry.
    stackScroll.invalidateOffsets();
    // Re-cache the just-committed heights of the changed bodies so the
    // RO safety net reads delta 0 for changes the sandwich absorbed.
    for (const key of pendingChangedKeys) {
      const body = bodyEls.get(key);
      if (body) bodyHeights.set(body, body.getBoundingClientRect().height);
    }
    pendingChangedKeys = [];
    if (import.meta.env.DEV) {
      assertBodyHeights();
      assertSectionOffsets();
    }
  },
  { flush: 'post' }
);

// Flipping the global unified<->split mode, OR wrap on/off, re-renders
// every body at a new height (split collapses each run to max(dels,
// adds) rows, vs dels + adds unified; wrap turns fixed-height rows into
// however-many-lines-they-wrap-to), so content above the viewport would
// shift under the reader. A mediaKeys change is the same kind of event:
// it flips sections between the note strip and the much taller media
// card. Sandwich all three in the same anchor prepare/restore the files
// and probe-resize paths use — nothing the user is looking at moves.
// changedEls: [null] means "a height change happened somewhere; keep the
// anchored line put" (the probe-resize path, where every body also moves).
watch(
  () => [props.mode, props.wrap, props.mediaKeys],
  () => {
    anchor.prepare({ survivingKeys: survivingKeys(committedFiles), changedEls: [null] });
  },
  { flush: 'pre' }
);

watch(
  () => [props.mode, props.wrap, props.mediaKeys],
  () => {
    anchor.restore();
    // Every body's height changed: the spy/tween offsets are stale, and
    // the RO net must read delta 0 for the shifts the sandwich absorbed.
    stackScroll.invalidateOffsets();
    for (const body of bodyEls.values()) {
      bodyHeights.set(body, body.getBoundingClientRect().height);
    }
    if (import.meta.env.DEV) {
      assertBodyHeights();
      assertSectionOffsets();
    }
  },
  { flush: 'post' }
);

// --- ResizeObserver safety net ---

const bodyEls = new Map<string, HTMLElement>();
const bodyHeights = new WeakMap<Element, number>();

/**
 * The net only exists for OUT-of-flush height changes — anything the
 * sandwich could not see (a drifted exact size realizing, a late font
 * load). In-flush changes are pre-cached by the post-flush watcher, so
 * they arrive here as delta 0. RO callbacks run post-layout, pre-paint:
 * a scrollTop-only write is still invisible.
 */
const bodyRo =
  typeof ResizeObserver !== 'undefined'
    ? new ResizeObserver((entries) => {
        for (const entry of entries) {
          const el = entry.target as HTMLElement;
          const height =
            entry.borderBoxSize?.[0]?.blockSize ?? el.getBoundingClientRect().height;
          const previous = bodyHeights.get(el);
          bodyHeights.set(el, height);
          if (previous === undefined || previous === height) continue;
          // An out-of-flush body height change moved the sections below it,
          // so the spy/tween offset cache is stale — mark it dirty.
          stackScroll.invalidateOffsets();
          // ResizeObserver callbacks must never write scrollTop / scroll — it
          // feeds back through content-visibility realization into an infinite
          // loop. The write shifts the realization boundary, which toggles
          // bodies between their intrinsic-size estimate and their real height,
          // which fires this observer again with a fresh delta — an RO ->
          // scroll -> layout livelock that hangs the tab. In-flush changes are
          // already compensated by the anchor sandwich (useScrollAnchor); a
          // rare out-of-flush drift above the viewport is left as a small
          // one-time shift rather than risk the loop.
        }
      })
    : null;

function setBodyEl(key: string, el: Element | ComponentPublicInstance | null): void {
  const prev = bodyEls.get(key);
  if (el instanceof HTMLElement) {
    if (prev === el) return;
    if (prev) bodyRo?.unobserve(prev);
    bodyEls.set(key, el);
    bodyRo?.observe(el);
  } else if (prev) {
    bodyRo?.unobserve(prev);
    bodyEls.delete(key);
  }
}

/**
 * DEV assert: a realized body's DOM height must match its computed
 * exact height within 1px — drift means the deterministic-height
 * assumption broke (new wrapping CSS, sub-pixel line-height change)
 * and every skipped body is now mis-sized.
 */
function assertBodyHeights(): void {
  const scroller = scrollerEl.value;
  if (!scroller || !probeSizes.value) return;
  const scrollerTop = scroller.getBoundingClientRect().top;
  const viewBottom = scrollerTop + scroller.clientHeight;
  for (const item of committedFiles) {
    if (isCollapsed(item)) continue;
    const exact = exactBodyHeight(item);
    if (exact === null) continue;
    const body = bodyEls.get(item.key);
    if (!body) continue;
    const rect = body.getBoundingClientRect();
    // Only realized (viewport-intersecting) bodies: a skipped body is
    // sized BY the computed value, so comparing it proves nothing.
    if (rect.bottom <= scrollerTop || rect.top >= viewBottom) continue;
    if (Math.abs(rect.height - exact) > 1) {
      console.warn(
        `[DiffStack] body height drift for ${item.key}: dom=${rect.height}px computed=${exact}px`
      );
    }
  }
}

/**
 * The strip half of the section-geometry guard: every RENDERED strip must
 * be exactly the height its slot memoized. A slot is measured once from
 * whichever section rendered it first and then reused sight-unseen, so a
 * strip that shrank or grew (a media card that changed height with its
 * state, a note that wrapped onto two lines) is invisible to
 * assertBodyHeights — which only looks at bodies — and to the offset
 * check below, which reads the same stale constant it is checking.
 */
function assertStripHeights(): void {
  for (const item of committedFiles) {
    if (isCollapsed(item)) continue;
    const slot = stripSlotFor(item);
    const expected = slot === null ? undefined : stackChrome[slot];
    if (slot === null || expected === undefined) continue;
    const strip = sectionEls.get(item.key)?.querySelector<HTMLElement>(STRIP_SELECTOR[slot]);
    if (!strip) continue;
    const height = strip.getBoundingClientRect().height;
    if (Math.abs(height - expected) > 1) {
      console.warn(
        `[DiffStack] ${slot} drift at ${item.key}: dom=${height}px memoized=${expected}px ` +
          `(this slot's strip must be the SAME height in every state)`
      );
    }
  }
}

/**
 * DEV guard for SECTION geometry, which assertBodyHeights does not cover: it
 * checks bodies, so chrome that sits outside a body — the card's border, and
 * above all the --sep-block gutter — has no net at all.
 *
 * Compares the LAST section's real offsetTop against the model's arithmetic
 * top. The last one specifically: a per-section error compounds as (N-1) x
 * delta, so section 0 or 1 proves nothing and the last is where a stale gap is
 * unmissable. A stale chromeGap after a layout-mode step is exactly the bug
 * this catches, and it is otherwise silent — jumps still land, because they
 * read live offsetTop.
 */
function assertSectionOffsets(): void {
  assertStripHeights();
  const model = sectionHeightModel();
  if (model === null || committedFiles.length < 2) return;
  const last = committedFiles[committedFiles.length - 1];
  const el = sectionEls.get(last.key);
  if (!el) return;
  let top = model.start;
  for (const item of committedFiles) {
    if (item.key === last.key) break;
    const h = model.heightFor(item.key);
    if (h === null) return; // unknowable: the model is not claiming anything
    top += h + model.gap;
  }
  if (Math.abs(el.offsetTop - top) > 1) {
    console.warn(
      `[DiffStack] section offset drift at ${last.key}: dom=${el.offsetTop}px model=${Math.round(top)}px ` +
        `(${committedFiles.length} sections; a stale chromeGap looks exactly like this)`
    );
  }
}

onMounted(() => {
  measureProbe();
  void nextTick(() => publishStackHeaderH());
  // Re-probe when the sample's metrics change (font load, zoom — page
  // zoom also fires window resize; the RO covers in-place font swaps).
  const probeRow = probeEl.value?.querySelector<HTMLElement>('.row');
  if (probeRow && typeof ResizeObserver !== 'undefined') {
    probeRo = new ResizeObserver(() => measureProbe());
    probeRo.observe(probeRow);
  }
  window.addEventListener('resize', measureProbe);
});

onBeforeUnmount(() => {
  probeRo?.disconnect();
  bodyRo?.disconnect();
  window.removeEventListener('resize', measureProbe);
});

// --- Programmatic scrolling + scroll-spy (useStackScroll) ---

/**
 * Sticky chrome above the sections inside the scroller. The target
 * section's own header is its first child (it sticks AT the landing
 * position, not above it), so this is 0 today; revisit if the stack
 * gains pinned chrome.
 */
const STICKY_OFFSET = 0;

/**
 * Sections in document order for the offset cache / spy. offsetTop is
 * scroller-relative: .stack-scroller is position:relative, making it
 * the sections' offsetParent.
 */
function scrollSections(): StackSection[] {
  const out: StackSection[] = [];
  for (const item of props.files) {
    const el = sectionEls.get(item.key);
    if (el) out.push({ key: item.key, el });
  }
  return out;
}

const stackScroll = useStackScroll(scrollerEl, {
  sections: scrollSections,
  // Arithmetic offsets from the exact height model: the offset cache
  // rebuilds with zero DOM reads no matter how often it is invalidated.
  sectionHeights: sectionHeightModel,
  stickyOffset: STICKY_OFFSET,
  onActiveKey: (key) => emit('active-file', key),
});

/**
 * --sep-block steps with the layout mode, and it is the ONLY cached chrome
 * measurement that moves with the viewport. Clear that one slot and rebuild
 * the offsets.
 *
 * Clears `gap` alone, never `stackChrome = {}`: every other slot (headerH,
 * borderY, toolbarH, the strip heights) reads a frozen literal, and blanket-
 * clearing turns an arithmetic rebuild into a forced-layout one — the exact
 * cost the cache exists to avoid. Anything that later becomes viewport-
 * dependent must be added here explicitly.
 *
 * chromeGap() stays lazy on purpose: never re-measure inside this handler,
 * just drop the value and let the next ensureOffsets() read it on the
 * following scroll frame, after Vue has flushed. post-flush so the new
 * margin is in the DOM before anything reads it.
 */
const isStacked = usePortrait();
watch(
  isStacked,
  () => {
    stackChrome.gap = undefined;
    stackScroll.invalidateOffsets();
  },
  { flush: 'post' }
);

function scrollToFile(key: string, opts?: { smooth?: boolean }): void {
  stackScroll.scrollToKey(key, opts);
}

/**
 * Glide to a hunk resolved BY KEY, re-read every tween frame: getHunkKey
 * may re-derive its target (the freshest hunk) from live data, and the
 * content-stable key is looked up in the CURRENT model via
 * resolveAnchorEl — so a refetched diff landing mid-glide re-resolves to
 * the right element instead of a DOM ordinal captured up front. An
 * unresolvable key (null, diff not landed, collapsed, a gated huge
 * file, binary) lands on the file section top — auto jumps must never
 * mount a gated body just to reach a hunk.
 */
function scrollToHunk(
  key: string,
  getHunkKey: () => string | null,
  opts?: { smooth?: boolean }
): void {
  stackScroll.scrollToTarget(
    () => {
      const scroller = scrollerEl.value;
      const section = sectionEls.get(key);
      if (!scroller || !section) return null;
      const hunkKey = getHunkKey();
      // resolveAnchorEl returns the NON-STICKY .hunk wrapper, never the
      // sticky hunk header: a header already stuck recedes with every
      // frame the tween approaches, landing the jump short. A
      // collapsed/unloaded body resolves to null — land on the file
      // header instead (offsetParent is also null inside display:none).
      const hunk = hunkKey === null ? null : resolveAnchorEl(hunkAnchorKey(key, hunkKey));
      if (!hunk || hunk.offsetParent === null) return section.offsetTop - STICKY_OFFSET;
      // The section's sticky file header overlays the top of the
      // scrollport, so the hunk lands just below it. Re-measured every
      // tween frame — content shifting above self-corrects.
      const headerH = section.querySelector<HTMLElement>('.file-diff-header')?.offsetHeight ?? 0;
      return (
        hunk.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top +
        scroller.scrollTop -
        STICKY_OFFSET -
        headerH
      );
    },
    { ...opts, activeKey: key }
  );
}

/** Focus a section (Enter in the jump navigator; tabindex="-1"). */
function focusFile(key: string): void {
  sectionEls.get(key)?.focus({ preventScroll: true });
}

defineExpose({
  scrollToFile,
  scrollToHunk,
  expandAllGated,
  focusFile,
  scrollerEl,
  isTweening: stackScroll.isTweening,
  lastUserScrollAt: stackScroll.lastUserScrollAt,
});
</script>

<template>
  <div ref="scrollerEl" class="stack-scroller">
    <!-- Hidden size probe: a real DiffView (so DiffView's scoped styles
         apply) whose row/header/note/gap heights feed the exact
         contain-intrinsic-size computation. Zero-height wrapper: it
         never affects layout or scrollHeight. The inner viewport gives
         .diff-scroll a definite height, so its always-on horizontal
         scrollbar track is measurable (scrollbarH). -->
    <div ref="probeEl" class="size-probe" aria-hidden="true">
      <div class="probe-viewport">
        <DiffView :diff="probeDiff" show-file-headers />
      </div>
    </div>
    <!-- Scrolls away with the rest of the stack, on purpose: wrap is a
         set-and-forget preference, not something reached for mid-scroll,
         and pinning it would mean fighting the file/hunk sticky-header
         stack (both already claim top:0 at different offsets) for very
         little benefit. -->
    <div ref="toolbarEl" class="stack-toolbar">
      <WrapToggle />
    </div>
    <section
      v-for="item in files"
      :key="item.key"
      :ref="(el) => setSectionEl(item.key, el)"
      class="file-diff"
      :class="{ selected: item.key === activeKey, uncommitted: item.uncommitted }"
      :data-key="item.key"
      data-testid="file-diff"
      tabindex="-1"
    >
      <header class="file-diff-header" :class="{ uncommitted: item.uncommitted }">
        <!-- Unloaded huge file: the chevron becomes the load trigger
             (same slot, so the header never jumps when it flips). -->
        <button
          class="collapse-btn mono"
          :aria-expanded="!isCollapsed(item)"
          :aria-label="`${isCollapsed(item) ? 'Expand' : 'Collapse'} ${item.path}`"
          @click="isUnloaded(item) ? loadHugeDiff(item.key) : emit('toggle-collapse', item.key)"
        >
          {{ isCollapsed(item) ? '▸' : '▾' }}
        </button>
        <span class="letter mono" :data-status="item.status">{{ statusLetter(item.status) }}</span>
        <span class="path mono" :title="item.path">{{ item.path }}</span>
        <RefPairLabel v-if="item.refPair" :pair="item.refPair" />
        <WholeFileToggle
          v-if="props.showWholeToggle && canGoWhole(item)"
          :on="props.wholeKey === item.key"
          :busy="props.wholeLoading && props.wholeKey === item.key"
          :disabled="wholeDisabledReason(item) !== null"
          :disabled-reason="wholeDisabledReason(item) ?? undefined"
          @toggle="emit('toggle-whole', item.key)"
        />
        <ViewFileButton :path="item.path" />
        <CopyPathButton :path="item.path" />
        <span v-if="item.uncommitted" class="uncommitted-tag mono">[uncommitted]</span>
        <span class="stats mono">
          <span v-if="item.stats.insertions" class="count-add">+{{ item.stats.insertions }}</span>
          <span v-if="item.stats.deletions" class="count-del"
            >&minus;{{ item.stats.deletions }}</span
          >
        </span>
      </header>
      <!-- A binary file the parent has image metadata for: the media
           slot stands where the note would. Registered with setBodyEl
           as a belt — the RO net then reports any height change of this
           card, which the memoized notShownMediaH slot depends on NOT
           happening. -->
      <div
        v-if="isMediaSection(item)"
        v-show="!item.collapsed"
        :ref="(el) => setBodyEl(item.key, el)"
        class="not-shown-media"
        data-testid="not-shown-media"
      >
        <slot name="media" :file="item" />
      </div>
      <!-- Withheld diff (binary with no metadata, or over the daemon's
           per-file size cap): placeholder-only — never bytes, never a
           diff body, no "Load diff" (there is no content to reveal).
           See notShownFor. The title is what the one-line clamp costs:
           the large-file notice's size and line count stay readable when
           the card is too narrow for them. -->
      <div
        v-else-if="notShownFor(item)"
        v-show="!item.collapsed"
        class="not-shown-note"
        :class="notShownClass(item)"
        :title="notShownFor(item)?.note"
        data-testid="not-shown-note"
      >
        {{ notShownFor(item)?.note }}
      </div>
      <!-- Unloaded huge file: the worst-case DOM cap — nothing below
           the header mounts until the user asks. A distinct affordance
           from the collapse chevron on purpose. -->
      <div v-else-if="isUnloaded(item)" v-show="!item.collapsed" class="load-diff">
        <button class="load-diff-btn mono chrome-chip" data-testid="load-diff" @click="loadHugeDiff(item.key)">
          Load diff
          <span class="load-diff-size"
            >({{ item.stats.insertions + item.stats.deletions }} changed lines)</span
          >
        </button>
      </div>
      <!-- `auto <exact px>`: the computed height sizes the body until
           it has been realized once; after that the browser's
           remembered size (equal to ours — drift is designed out) wins
           on re-skip, so realize/skip cycles can't move offsets. Falls
           back to the stats estimate only where no exact height exists
           (placeholder, empty diff, probe not measured). -->
      <div
        v-else
        v-show="!item.collapsed"
        :ref="(el) => setBodyEl(item.key, el)"
        class="file-diff-body"
        :class="{ 'wrap-mode': props.wrap }"
        :style="{ containIntrinsicSize: bodyIntrinsicSize(item) }"
      >
        <DiffView
          v-if="item.diff"
          :diff="item.diff"
          :file-path="item.path"
          :syntax="props.syntax"
          :mode="props.mode"
          :wrap="props.wrap"
          :whole-path="props.wholeKey === item.key ? item.path : null"
          embedded
        />
        <div
          v-else
          class="placeholder"
          data-testid="diff-placeholder"
          :style="{ height: `${estimateBodyHeight(item)}px` }"
        ></div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.stack-scroller {
  /* The sections' offsetParent, so their offsetTop is scroller-relative
     (scrollToFile depends on it). */
  position: relative;
  overflow-y: auto;
  /* Long unified lines scroll here now (the embedded DiffViews are no longer
     their own scroll containers, so their sticky hunk headers can pin to
     this scroller). Split bodies still scroll their panes internally. */
  overflow-x: auto;
  /* Native scroll anchoring off: Safari has none, sticky headers
     suppress it elsewhere, and it would double-correct against the
     useScrollAnchor sandwich — which is the ONE compensation path. */
  overflow-anchor: none;

  /* Inset the cards so page background shows on BOTH sides as well as
     between them — the same band left, right and in the gaps, which is what
     makes a card read as a discrete sheet rather than a full-bleed strip.
     This is also what separates the stack from the file tree now that the
     tree's border-right is gone: both the tree and a card body paint
     --surface, so without this inset they would fuse into one slab.
     INLINE axis only. Block padding here would shift every section's
     offsetTop while the height model still starts at `start: toolbarH`,
     drifting every scroll target by the padding. */
  padding-inline: var(--gutter);

  /* The spine color. --border is tuned to be a hairline against --surface;
     against --bg it is far too faint to read as a file's full-height edge.
     Mixing toward --text-dim lifts it to a visible rule in every theme,
     light and dark, without hardcoding a color. color-mix precedent:
     --row-selected-bg in style.css. */
  --file-edge: color-mix(in srgb, var(--border) 40%, var(--text-dim));

  /* The card body's fill, resolved HERE and not on .file-diff itself.
     Writing `--bg: var(--surface)` on the card and ALSO mixing against
     var(--bg) there would be a self-reference: a custom property may not
     consume its own value, so the declaration would be invalid at
     computed-value time, --bg would resolve to nothing, and every
     `background: var(--bg)` inside the card would fall back to transparent.
     On this ancestor --bg is merely inherited, so there is no cycle.

     --surface outright, not a mix toward it. A 30% mix measured 2/255 against
     the gutter in the dark themes — invisible, which is exactly the "I can't
     tell these are three files" complaint. This is the same desk/sheet
     relationship the file tree already uses (that panel paints --surface
     against the page's --bg and reads as obviously separate), so it is
     proven in-app and guaranteed distinct in every theme: --bg and --surface
     differ by construction, or headers would not be visible either. */
}

.stack-toolbar {
  display: flex;
  justify-content: flex-end;
  padding: 0.25rem 0.25rem 0;
}

/* The size probe: laid out (so it measures) but invisible, zero-height,
   and out of the scroller's flow and scrollHeight. */
.size-probe {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 0;
  overflow: hidden;
  visibility: hidden;
  pointer-events: none;
  z-index: -1;
}

/* A definite height for the probe's .diff-scroll (height: 100%), so
   offsetHeight − clientHeight yields the real horizontal scrollbar
   track height. Clipped by the zero-height .size-probe above. */
.probe-viewport {
  height: 100px;
}

/* Probe rows must never be c-v-skipped: the measurements (and the
   ResizeObserver re-probe) need them permanently laid out. */
.size-probe :deep(.row) {
  content-visibility: visible;
}

/* One card per file, so a file reads as a single object with a top AND a
   bottom edge — "where does this file end" was the actual complaint.

   Deliberately NOT here:
     - overflow: hidden/clip — would make the card a scroll container and
       silently re-root the sticky file header and every hunk header onto a
       box that never scrolls. Nothing overflows the card anyway: the body's
       content-visibility already applies paint containment.
     - position: relative — would make .file-diff the offsetParent of every
       .hunk and break useScrollAnchor.pickAnchor, which compares a hunk's
       offsetTop against its section's.
     - padding or a border on .file-diff-body — contain-intrinsic-size sizes
       the CONTENT box while assertBodyHeights compares a border-box rect.
   Anything added to .file-diff itself MUST be threaded into chromeBorderY(). */
.file-diff {
  border: 1px solid var(--border);
  /* The spine: the only chrome present for the file's whole vertical
     extent, so "which file am I in" stays answerable mid-scroll, when both
     the header and the bottom edge are off-screen. Inline axis only — zero
     vertical cost. */
  border-left: 3px solid var(--file-edge);
  border-radius: 4px;
  /* Fills the card body: .row, .diff-scroll, .not-shown-note and .load-diff
     all paint var(--bg), so re-pointing --bg here turns the whole file into
     a tinted region read against an untinted gutter. This is what carries
     the separation mid-scroll — the border alone is a hairline at the far
     edges, the weakest mark in the weakest position. Costs zero vertical
     space and nothing in the height model. --file-bg is pre-resolved on
     .stack-scroller; mixing against var(--bg) here would be a self-reference
     and would blank the fill entirely. */
  --bg: var(--file-bg);
}

.file-diff + .file-diff {
  /* The gutter, and the main separator now that cards are --surface against
     a --bg page. 0.75rem was barely wider than a row, so three stacked cards
     still scanned as one ruled region. Read as a band of page background,
     not as spacing.

     Viewport-dependent, and therefore the reason invalidateBand() exists.
     chromeGap() reads this once and memoizes it in stackChrome, and
     stackChrome is otherwise cleared only inside measureProbe, AFTER an
     epsilon bail that compares font metrics — none of which move when the
     layout mode changes. Without the explicit invalidation, useStackScroll
     would keep rebuilding offsets from the stale gap: error (N-1) x delta,
     compounding down the stack, showing up as the scroll-spy naming the wrong
     file. Jumps still land (they read live offsetTop), nothing warns, and
     assertBodyHeights covers bodies only. */
  margin-top: var(--sep-block);
}

/* The scroll-spy's active file, outlined as one object. Zero px cost, and
   only expressible because the card has a border to recolor. */
.file-diff.selected {
  border-color: var(--selection);
}

/* Spine only, so it never competes with .selected — which wins the other
   three edges by source order. */
.file-diff.uncommitted {
  border-left-color: var(--uncommitted);
}

/* Programmatically focusable (Enter in the jump navigator). */
.file-diff:focus-visible {
  outline: 1px solid var(--selection);
  /* Was -1px, which now lands on the card border and reads as a color
     change rather than a focus ring. */
  outline-offset: -4px;
}

/* Sticky per-file header inside the stack scroller; each .file-diff
   section bounds its own header, so the next one pushes it away. */
.file-diff-header {
  position: sticky;
  top: 0;
  /* Also pin to the left edge so the header stays readable when the stack is
     scrolled horizontally (long unified lines). */
  left: 0;
  z-index: 4;
  display: flex;
  align-items: baseline;
  gap: 0.625rem;
  padding: 0.375rem 0.75rem;
  /* border-top removed: the card draws the top edge now, so keeping this
     would double the hairline (net -1px per file). */
  border-bottom: 1px solid var(--border);
  /* Card radius minus each border width, so the fill does not square off
     the card's rounded top corners — cheaper than clipping the card, which
     would re-root the sticky headers. */
  border-radius: 1px 3px 0 0;
  /* One rank ABOVE the hunk headers, which stay --surface. This is the root
     cause of the complaint: today a file header and a hunk header are
     byte-identical chrome, so a 6-hunk file shows 7 near-identical bands and
     the file header loses the hierarchy fight. Not a hover collision —
     .file-diff-header has no hover state. */
  background: var(--surface-raised);
  font-size: var(--fs-base);
  /* Stays viewport-width while pinned left, rather than stretching to the
     widest line (which would push its content off-screen and leave a gap). */
  width: 100%;
}

/* Same selection language as the file tree and every other list. */
.file-diff.selected .file-diff-header {
  background: var(--row-selected-bg);
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


/* Skip layout+paint for whole off-screen files; a skipped body is
   sized by the inline computed contain-intrinsic-size. NEVER move
   this onto .file-diff — c-v on the section breaks its sticky header. */
.file-diff-body {
  content-visibility: auto;
}

/* Wrap mode: exactBodyHeight() returns null while props.wrap is set, so
   the inline contain-intrinsic-size above is only ever the rough stats
   estimate — content-visibility:auto would use it as a real placeholder
   for far-away files, and a rough estimate standing in for a file that
   might be a normal height OR five times taller (many long lines,
   wrapped) is exactly the kind of drift the exact-height model elsewhere
   is built to avoid. Turning content-visibility off for wrapped bodies
   is the reliable trade: full natural layout, no promise to keep. */
.file-diff-body.wrap-mode {
  content-visibility: visible;
}

/* Untracked file whose fetch hasn't landed (phase 1); sized inline
   from its stats so the stack doesn't jump when the diff arrives. */
.placeholder {
  background: var(--surface);
}

/* The image card's slot. The height is set HERE, on the container, and is
   a constant sum of the three strips ImageDiffView lays out — so the
   memoized notShownMediaH holds no matter what the card is doing inside
   (loading, decoded, failed, any mode), and even if the slot is empty.
   Never make this height content-driven. */
.not-shown-media {
  height: calc(var(--image-meta-h) + var(--image-frame-h) + var(--image-controls-h));
  overflow: hidden;
  background: var(--bg);
}

/* Withheld diff: the whole body is this note — no bytes, no "Load diff".
   The kind classes (.not-shown-binary / .not-shown-large) carry no style;
   they exist so the two notes get their own memoized height slot.

   ONE LINE, ALWAYS. The large-file notice carries a per-file size and line
   count, so on a narrow card two of them would wrap to different heights —
   and a strip's height is measured once per slot and then reused for every
   section of that kind, sight-unseen, which turns that difference into a
   compounding section-offset error (the scroll spy naming the wrong file).
   Clamping to a single line makes the memoized constant true at any card
   width; the full text stays on the element's title. */
.not-shown-note {
  padding: 0.75rem;
  color: var(--text-dim);
  font-size: var(--fs-small);
  background: var(--bg);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Huge-file gate: a quiet strip where the body would be. */
.load-diff {
  padding: 0.75rem;
  background: var(--bg);
}

.load-diff-btn {
  padding: 0.25rem 0.625rem;
  color: var(--text);
  font-size: var(--fs-small);
  cursor: pointer;
}

.load-diff-btn:hover {
  border-color: var(--selection);
}

.load-diff-size {
  color: var(--text-dim);
}
</style>
