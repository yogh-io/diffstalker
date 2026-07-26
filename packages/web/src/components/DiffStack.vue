<script lang="ts">
import type { DiffLine, DiffResult } from '@diffstalker/core/git/diff';
import type { FileStatus } from '@diffstalker/core/git/status';
import { buildDiffModel, type DiffModel } from '../utils/diffRows';
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
}

/**
 * Separator between a section key and a hunk key inside an anchor key.
 * NUL can never appear in a git path (so never in a section key), which
 * keeps composite hunk keys collision-free against file keys.
 */
const ANCHOR_SEP = '\u0000';

/**
 * buildDiffModel memoized per DiffResult identity (split by staged-ness,
 * which feeds the model's section keys). The anchor sandwich and the
 * exact-height computation both need models pre- AND post-flush; with
 * identity-preserved diffs this makes every repeat lookup free.
 */
const modelCache = new WeakMap<DiffResult, { unstaged?: DiffModel; staged?: DiffModel }>();

function modelFor(diff: DiffResult, staged: boolean): DiffModel {
  let entry = modelCache.get(diff);
  if (!entry) {
    entry = {};
    modelCache.set(diff, entry);
  }
  const slot = staged ? 'staged' : 'unstaged';
  entry[slot] ??= buildDiffModel(diff, staged);
  return entry[slot];
}

/**
 * isBinary per DiffResult identity: a cheap header-line scan (the same
 * marker buildDiffModel keys on), memoized so the gate checks never
 * have to build a full model for a diff they will not render.
 */
const binaryCache = new WeakMap<DiffResult, boolean>();

function isBinaryDiff(diff: DiffResult): boolean {
  let cached = binaryCache.get(diff);
  if (cached === undefined) {
    cached = diff.lines.some(
      (line) => line.type === 'header' && line.content.startsWith('Binary files')
    );
    binaryCache.set(diff, cached);
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

const PROBE_DIFF: DiffResult = { raw: '', lines: PROBE_LINES };

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
 * Binary files render as a placeholder ONLY (sticky header + a "Binary
 * file" note) — never bytes, never a diff body, and never the huge
 * gate. Auto-mode jumps land on the section top of gated/binary files
 * without expanding anything.
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
import { useScrollAnchor, type AnchorCandidate } from '../composables/useScrollAnchor';
import {
  useStackScroll,
  type SectionHeightModel,
  type StackSection,
} from '../composables/useStackScroll';
import DiffView from './DiffView.vue';

const props = defineProps<{
  files: StackFile[];
  /** Key of the section styled as selected (nav highlight), if any. */
  activeKey?: string | null;
  /** Forwarded to each file's DiffView: syntax-highlight content lines. */
  syntax?: boolean;
  /** Forwarded to each file's DiffView: unified or side-by-side split. */
  mode?: 'unified' | 'split';
}>();

const emit = defineEmits<{
  'active-file': [key: string];
  'toggle-collapse': [key: string];
}>();

const scrollerEl = ref<HTMLElement | null>(null);

/** Section elements by key, kept by the v-for ref callbacks. */
const sectionEls = new Map<string, HTMLElement>();

function setSectionEl(key: string, el: Element | ComponentPublicInstance | null): void {
  if (el instanceof HTMLElement) sectionEls.set(key, el);
  else sectionEls.delete(key);
}

// --- Binary files: placeholder-only ---

/**
 * A binary file's section is ALWAYS the placeholder note: its sticky
 * header plus a plain "Binary file" line — never bytes, never a diff
 * body, and never the huge-file gate (there is no "Load diff" that
 * reveals binary content, explicit or auto). Real binary rendering
 * (image preview, size delta) is deliberately deferred — a future
 * feature; until then the note is all a binary section ever shows.
 */
function isBinaryFile(item: StackFile): boolean {
  return item.diff !== null && isBinaryDiff(item.diff);
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

/** True while a huge file's body is gated behind "Load diff". */
function isUnloaded(item: StackFile): boolean {
  return (
    isHuge(item) &&
    !isBinaryFile(item) &&
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
const ROW_PX = 20; // DiffView's 1.26rem row estimate at a 16px root
const CONTEXT_ROWS_PER_HUNK = 7; // 1 hunk-header row + ~6 context lines
const CHANGED_LINES_PER_HUNK = 10; // rough hunk-count guess
const MIN_PX = 48;

function estimateBodyHeight(item: StackFile): number {
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
  const sizes = probeSizes.value;
  if (!sizes || !item.diff) return null;
  const model = modelFor(item.diff, item.staged ?? false);
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
  binaryNoteH?: number;
  loadDiffH?: number;
} = {};

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

function stripHeight(
  slot: 'binaryNoteH' | 'loadDiffH',
  key: string,
  selector: string
): number | null {
  if (stackChrome[slot] === undefined) {
    const strip = sectionEls.get(key)?.querySelector<HTMLElement>(selector);
    if (!strip) return null;
    stackChrome[slot] = strip.getBoundingClientRect().height;
  }
  return stackChrome[slot] ?? null;
}

/** Outer section height (header + visible body); null = unknowable. */
function sectionOuterHeight(item: StackFile, headerH: number): number | null {
  if (item.collapsed) return headerH; // v-show hides every body variant
  if (isBinaryFile(item)) {
    const h = stripHeight('binaryNoteH', item.key, '.binary-note');
    return h === null ? null : headerH + h;
  }
  if (isUnloaded(item)) {
    const h = stripHeight('loadDiffH', item.key, '.load-diff');
    return h === null ? null : headerH + h;
  }
  // Exact model height; the estimate branches (placeholder, empty
  // diff) match the inline sizing the body renders with, so the
  // arithmetic top stays honest within the spy's hysteresis.
  return headerH + (exactBodyHeight(item) ?? estimateBodyHeight(item));
}

/**
 * The height model handed to useStackScroll: lets it rebuild the
 * spy/tween offset cache with ZERO per-section DOM reads. Null (full
 * DOM fallback) only when no probe has landed (tests, first paint) or
 * a chrome piece cannot be measured yet.
 */
function sectionHeightModel(): SectionHeightModel | null {
  if (probeSizes.value === null) return null;
  const headerH = chromeHeaderH();
  const gap = chromeGap();
  if (headerH === null || gap === null) return null;
  const byKey = new Map(props.files.map((f) => [f.key, f]));
  return {
    start: 0, // the first section sits at the scroller's top
    gap,
    heightFor: (key) => {
      const item = byKey.get(key);
      return item === undefined ? null : sectionOuterHeight(item, headerH);
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
    const model = modelFor(item.diff, item.staged ?? false);
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
  const model = modelFor(item.diff, item.staged ?? false);
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
    const model = modelFor(item.diff, item.staged ?? false);
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
    if (import.meta.env.DEV) assertBodyHeights();
  },
  { flush: 'post' }
);

// Flipping the global unified<->split mode re-renders every body at a new
// height (split collapses each run to max(dels, adds) rows, vs
// dels + adds unified), so content above the viewport would shift under
// the reader. Sandwich the flip in the same anchor prepare/restore the
// files and probe-resize paths use — nothing the user is looking at moves.
// changedEls: [null] means "a height change happened somewhere; keep the
// anchored line put" (the probe-resize path, where every body also moves).
watch(
  () => props.mode,
  () => {
    anchor.prepare({ survivingKeys: survivingKeys(committedFiles), changedEls: [null] });
  },
  { flush: 'pre' }
);

watch(
  () => props.mode,
  () => {
    anchor.restore();
    // Every body's height changed: the spy/tween offsets are stale, and
    // the RO net must read delta 0 for the shifts the sandwich absorbed.
    stackScroll.invalidateOffsets();
    for (const body of bodyEls.values()) {
      bodyHeights.set(body, body.getBoundingClientRect().height);
    }
    if (import.meta.env.DEV) assertBodyHeights();
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
    <section
      v-for="item in files"
      :key="item.key"
      :ref="(el) => setSectionEl(item.key, el)"
      class="file-diff"
      :class="{ selected: item.key === activeKey }"
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
        <span v-if="item.uncommitted" class="uncommitted-tag mono">[uncommitted]</span>
        <span class="stats mono">
          <span v-if="item.stats.insertions" class="count-add">+{{ item.stats.insertions }}</span>
          <span v-if="item.stats.deletions" class="count-del"
            >&minus;{{ item.stats.deletions }}</span
          >
        </span>
      </header>
      <!-- Binary file: placeholder-only, always — never bytes, never a
           diff body, no "Load diff" (explicit or auto). Real binary
           rendering is a deferred future feature (see isBinaryFile). -->
      <div
        v-if="isBinaryFile(item)"
        v-show="!item.collapsed"
        class="binary-note"
        data-testid="binary-note"
      >
        Binary file — no text diff to show.
      </div>
      <!-- Unloaded huge file: the worst-case DOM cap — nothing below
           the header mounts until the user asks. A distinct affordance
           from the collapse chevron on purpose. -->
      <div v-else-if="isUnloaded(item)" v-show="!item.collapsed" class="load-diff">
        <button class="load-diff-btn mono" data-testid="load-diff" @click="loadHugeDiff(item.key)">
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
        :style="{ containIntrinsicSize: bodyIntrinsicSize(item) }"
      >
        <DiffView
          v-if="item.diff"
          :diff="item.diff"
          :file-path="item.path"
          :syntax="props.syntax"
          :mode="props.mode"
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

.file-diff + .file-diff {
  margin-top: 0.75rem;
}

/* Programmatically focusable (Enter in the jump navigator). */
.file-diff:focus-visible {
  outline: 1px solid var(--selection);
  outline-offset: -1px;
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
  border-top: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
  background: var(--surface);
  font-size: var(--fs-base);
  /* Stays viewport-width while pinned left, rather than stretching to the
     widest line (which would push its content off-screen and leave a gap). */
  width: 100%;
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

.letter[data-status='untracked'] {
  color: var(--status-untracked);
}

.uncommitted-tag {
  flex: none;
  color: var(--uncommitted);
  font-size: var(--fs-micro);
}

/* Skip layout+paint for whole off-screen files; a skipped body is
   sized by the inline computed contain-intrinsic-size. NEVER move
   this onto .file-diff — c-v on the section breaks its sticky header. */
.file-diff-body {
  content-visibility: auto;
}

/* Untracked file whose fetch hasn't landed (phase 1); sized inline
   from its stats so the stack doesn't jump when the diff arrives. */
.placeholder {
  background: var(--surface);
}

/* Binary file: the whole body is this note — no bytes, no "Load diff". */
.binary-note {
  padding: 0.75rem;
  color: var(--text-dim);
  font-size: var(--fs-small);
  background: var(--bg);
}

/* Huge-file gate: a quiet strip where the body would be. */
.load-diff {
  padding: 0.75rem;
  background: var(--bg);
}

.load-diff-btn {
  padding: 0.25rem 0.625rem;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--surface-raised);
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
