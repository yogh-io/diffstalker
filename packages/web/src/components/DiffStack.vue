<script lang="ts">
import type { DiffLine, DiffResult } from '@diffstalker/core/git/diff';
import type { FileStatus } from '@diffstalker/core/git/status';
import { buildDiffModel, type DiffModel } from '../utils/diffRows';

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
 * Deliberately no `auto` keyword — the browser's remembered size goes
 * stale when a skipped subtree is patched; the computed value updates
 * in the same Vue patch as the content, so the anchor sandwich
 * compensates it and later c-v realization is a ~0px no-op. Bodies
 * without a computable height (placeholders, empty/binary diffs) keep
 * the stats-based estimate.
 *
 * Scroll anchoring (phase 2): overflow-anchor is off and useScrollAnchor
 * runs its pre-flush/post-flush sandwich around every change to the
 * rendered file set, so churn above the viewport never moves what the
 * user is looking at. A ResizeObserver over the bodies is the safety
 * net for any OUT-of-flush height change (it would mean the exact-size
 * assumption drifted): it compensates scrollTop for bodies entirely
 * above the viewport and warns in dev. When nothing churns (Compare's
 * static diffs) all of this is inert: no changed sections → no anchor,
 * no size deltas → a silent observer.
 *
 * Scrolling: scrollToFile/scrollToHunk are exposed and INSTANT for now
 * (the smooth tween is phase 1). Both use scroller.scrollTo with the
 * section's scroller-relative offsetTop — never scrollIntoView, which
 * scrolls every ancestor and ignores sticky headers. 'active-file' is
 * emitted on programmatic jumps; the real scroll-spy is phase 1.
 */

import { onBeforeUnmount, onMounted, ref, watch, type ComponentPublicInstance } from 'vue';
import { statusLetter } from '../utils/format';
import { useScrollAnchor, type AnchorCandidate } from '../composables/useScrollAnchor';
import DiffView from './DiffView.vue';

const props = defineProps<{
  files: StackFile[];
  /** Key of the section styled as selected (nav highlight), if any. */
  activeKey?: string | null;
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
  const row = root.querySelector<HTMLElement>('.row');
  const hunk = root.querySelector<HTMLElement>('.hunk');
  const hunkHeader = root.querySelector<HTMLElement>('.hunk-header');
  const fileHeader = root.querySelector<HTMLElement>('.file-header');
  const note = root.querySelector<HTMLElement>('.file-note');
  const sections = root.querySelectorAll<HTMLElement>('.file-section');
  if (!row || !hunk || !hunkHeader || !fileHeader || !note || sections.length < 2) return;

  const rowH = row.getBoundingClientRect().height;
  if (rowH <= 0) return; // no layout engine (tests) or hidden — keep estimates

  const hunkHeaderH = hunkHeader.getBoundingClientRect().height;
  const hunkBorderB = Math.max(
    0,
    hunk.getBoundingClientRect().height - hunkHeaderH - PROBE_FIRST_HUNK_ROWS * rowH
  );
  probeSizes.value = {
    rowH,
    hunkHeaderH,
    hunkBorderB,
    fileHeaderH: fileHeader.getBoundingClientRect().height,
    noteH: note.getBoundingClientRect().height,
    sectionGap:
      sections[1].getBoundingClientRect().top - sections[0].getBoundingClientRect().bottom,
  };
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
  let height = 0;
  model.sections.forEach((section, i) => {
    if (i > 0) height += sizes.sectionGap;
    if (withHeaders && section.filePath !== null) height += sizes.fileHeaderH;
    height += section.notes.length * sizes.noteH;
    section.hunks.forEach((hunk, j) => {
      height += sizes.hunkHeaderH + hunk.rows.length * sizes.rowH;
      if (j < section.hunks.length - 1) height += sizes.hunkBorderB;
    });
  });
  return height;
}

/** Inline contain-intrinsic-size value: exact when possible, else estimate. */
function bodyIntrinsicSize(item: StackFile): string {
  return `${exactBodyHeight(item) ?? estimateBodyHeight(item)}px`;
}

// --- Scroll anchoring (the sandwich) ---

/**
 * The file set the CURRENT DOM was rendered from: prepare() must build
 * its candidates against the old world while props.files already holds
 * the new one. Updated post-flush. (Callers must replace `files`, never
 * mutate it in place — both views feed a computed, which does.)
 */
let committedFiles: StackFile[] = props.files;

/** True while phase 1's smooth tween animates; it absorbs shifts itself. */
const tweenActive = ref(false);

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
    if (item.collapsed || !item.diff) continue;
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
  if (!sectionEl || !item?.diff || item.collapsed) return null;
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
  isTweenActive: () => tweenActive.value,
});

/** Every anchor key (file + hunk) the NEXT file set will render. */
function survivingKeys(next: StackFile[]): Set<string> {
  const keys = new Set<string>();
  for (const item of next) {
    keys.add(item.key);
    if (!item.diff || item.collapsed) continue; // collapsed hunks are unmeasurable
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
    } else if (prev.diff !== item.diff || !!prev.collapsed !== !!item.collapsed) {
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

// Pre-flush: DOM still old — pick and measure the anchor.
watch(
  () => props.files,
  (next) => {
    const changes = diffChanges(next);
    pendingChangedKeys = changes.changedKeys;
    anchor.prepare({ survivingKeys: survivingKeys(next), changedEls: changes.els });
  },
  { flush: 'pre' }
);

// Post-flush: DOM patched, same task, before paint — compensate.
watch(
  () => props.files,
  (next) => {
    anchor.restore();
    committedFiles = next;
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
        const scroller = scrollerEl.value;
        for (const entry of entries) {
          const el = entry.target as HTMLElement;
          const height =
            entry.borderBoxSize?.[0]?.blockSize ?? el.getBoundingClientRect().height;
          const previous = bodyHeights.get(el);
          bodyHeights.set(el, height);
          if (previous === undefined || previous === height || !scroller) continue;
          // Only a body ENTIRELY above the viewport can silently move
          // the content the user is looking at. Below or intersecting:
          // nothing to compensate.
          if (el.getBoundingClientRect().bottom > scroller.getBoundingClientRect().top) continue;
          const delta = height - previous;
          anchor.nudge(delta);
          if (import.meta.env.DEV) {
            console.warn(
              `[DiffStack] out-of-flush body height delta ${delta}px compensated — exact intrinsic size drifted`
            );
          }
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
    if (item.collapsed) continue;
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

// --- Programmatic scrolling ---

/**
 * Sticky chrome above the sections inside the scroller. The target
 * section's own header is its first child (it sticks AT the landing
 * position, not above it), so this is 0 today; phase 1 revisits it if
 * the stack gains pinned chrome.
 */
const STICKY_OFFSET = 0;

function scrollToFile(key: string, _opts?: { smooth?: boolean }): void {
  const scroller = scrollerEl.value;
  const section = sectionEls.get(key);
  if (!scroller || !section) return;
  // offsetTop is scroller-relative: .stack-scroller is position:relative,
  // making it the sections' offsetParent.
  scroller.scrollTo({ top: section.offsetTop - STICKY_OFFSET });
  emit('active-file', key);
}

function scrollToHunk(key: string, hunkIndex: number): void {
  const scroller = scrollerEl.value;
  const section = sectionEls.get(key);
  if (!scroller || !section) return;
  const hunk = section.querySelectorAll<HTMLElement>('[data-testid="hunk-header"]')[hunkIndex];
  if (!hunk) return;
  // A collapsed section's body is v-show-hidden: the hunk's rect is
  // zeroed and the scroll would land wrong. offsetParent is null inside
  // display:none — bail out (collapse is parent-owned, not toggled here).
  if (hunk.offsetParent === null) return;
  // The section's sticky file header overlays the top of the scrollport,
  // so the hunk lands just below it.
  const headerH = section.querySelector<HTMLElement>('.file-diff-header')?.offsetHeight ?? 0;
  const top =
    hunk.getBoundingClientRect().top -
    scroller.getBoundingClientRect().top +
    scroller.scrollTop -
    STICKY_OFFSET -
    headerH;
  scroller.scrollTo({ top });
  emit('active-file', key);
}

defineExpose({ scrollToFile, scrollToHunk, scrollerEl });
</script>

<template>
  <div ref="scrollerEl" class="stack-scroller">
    <!-- Hidden size probe: a real DiffView (so DiffView's scoped styles
         apply) whose row/header/note/gap heights feed the exact
         contain-intrinsic-size computation. Zero-height wrapper: it
         never affects layout or scrollHeight. -->
    <div ref="probeEl" class="size-probe" aria-hidden="true">
      <DiffView :diff="probeDiff" show-file-headers />
    </div>
    <section
      v-for="item in files"
      :key="item.key"
      :ref="(el) => setSectionEl(item.key, el)"
      class="file-diff"
      :class="{ selected: item.key === activeKey }"
      :data-key="item.key"
      data-testid="file-diff"
    >
      <header class="file-diff-header" :class="{ uncommitted: item.uncommitted }">
        <button
          class="collapse-btn mono"
          :aria-expanded="!item.collapsed"
          :aria-label="`${item.collapsed ? 'Expand' : 'Collapse'} ${item.path}`"
          @click="emit('toggle-collapse', item.key)"
        >
          {{ item.collapsed ? '▸' : '▾' }}
        </button>
        <span class="letter mono" :data-status="item.status">{{ statusLetter(item.status) }}</span>
        <span class="path mono">{{ item.path }}</span>
        <span v-if="item.uncommitted" class="uncommitted-tag mono">[uncommitted]</span>
        <span class="stats mono">
          <span v-if="item.stats.insertions" class="count-add">+{{ item.stats.insertions }}</span>
          <span v-if="item.stats.deletions" class="count-del"
            >&minus;{{ item.stats.deletions }}</span
          >
        </span>
      </header>
      <!-- Exact computed height, never `auto <px>`: the browser's
           remembered size goes stale when a skipped subtree is patched
           (§3 of the diff-stream doc). Falls back to the stats estimate
           only where no exact height exists (placeholder, empty diff,
           probe not measured). -->
      <div
        v-show="!item.collapsed"
        :ref="(el) => setBodyEl(item.key, el)"
        class="file-diff-body"
        :style="{ containIntrinsicSize: bodyIntrinsicSize(item) }"
      >
        <DiffView v-if="item.diff" :diff="item.diff" :file-path="item.path" />
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

/* Probe rows must never be c-v-skipped: the measurements (and the
   ResizeObserver re-probe) need them permanently laid out. */
.size-probe :deep(.row) {
  content-visibility: visible;
}

.file-diff + .file-diff {
  margin-top: 0.75rem;
}

/* Sticky per-file header inside the stack scroller; each .file-diff
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
</style>
