<script setup lang="ts">
/**
 * DiffView: renders ONE DiffResult as a READ-ONLY DOM diff.
 * Self-contained and data-driven — shared by Changes, History (commit
 * diffs), and Compare (per-file diffs).
 *
 * Layout: per hunk, a sticky header (readable ranges + relative edit
 * time) and a run of grid rows: old line number | new line number |
 * marker | content. All color comes from the --diff-* theme vars.
 * Multi-file diffs (a commit's diff, the whole-tree staged diff) get a
 * sticky per-file section header; single-file diffs show none unless
 * `showFileHeaders` forces them.
 *
 * Mode (the `mode` prop, a global toggle): 'unified' stacks the rows as
 * above; 'split' lays each hunk out side by side — old on the left, new
 * on the right — one visual row per del/add pair (utils/diffSplit), the
 * short side padded. Both sides render the same split rows at equal
 * heights so they stay aligned; the sides size to their content (a 50/50
 * fill when lines are short) and the whole body scrolls horizontally via
 * the pane's one .diff-scroll — long lines are reachable there, and no
 * per-side scrollbar means no extra height for the exact-body-height
 * model. splitRowCount is the single source of truth for the row count,
 * shared with DiffStack's height model.
 *
 * Virtualization: rows get `content-visibility: auto` with a
 * `contain-intrinsic-size` estimate, so off-screen rows skip layout and
 * paint. That keeps multi-thousand-line diffs responsive without a
 * virtual-scroll dependency — the row model stays fully in the DOM
 * (find-in-page and text selection keep working), the browser just
 * doesn't render what isn't visible.
 *
 * Word-level highlighting: rows carry precomputed segments from
 * core/view/wordDiff (via buildDiffModel); changed segments render as
 * .word-hl spans on the add/del highlight background.
 *
 * Syntax highlighting (the `syntax` prop, a global toggle): when on, the
 * content cell renders tokenized "pieces" (utils/diffHighlight) instead
 * of plain text — each piece carries an hljs class (foreground color,
 * mapped by the global theme/hljs.css) AND the word-hl background, so the
 * two layers compose. Off, or for a language hljs doesn't know, the cell
 * keeps its plain / word-hl-only render. Language is resolved per file
 * section, so a multi-file diff highlights each file in its own language.
 */

import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { DiffResult } from '@diffstalker/core/git/diff';
import { formatRelativeTime } from '@diffstalker/core/view/formatDate';
import { buildDiffModel } from '../utils/diffRows';
import type { DiffContentRow, DiffFileSection, DiffHunkGroup } from '../utils/diffRows';
import { diffLanguage, syntaxPieces } from '../utils/diffHighlight';
import { splitRows } from '../utils/diffSplit';
import DiffLineContent from './DiffLineContent.vue';

const props = defineProps<{
  diff: DiffResult | null;
  /** Selected file's path — fallback language source for single-file diffs. */
  filePath?: string;
  /** Unified (stacked) or split (old | new, side by side). Global toggle. */
  mode?: 'unified' | 'split';
  /** Syntax-highlight content lines (global toggle). Off by default. */
  syntax?: boolean;
  /**
   * Force per-file section headers on (History's commit diffs). Left
   * off, headers still show automatically when the diff spans more
   * than one file (a whole-tree diff); a single-file diff shows none —
   * the pane chrome above the diff already names the file.
   */
  showFileHeaders?: boolean;
}>();

/**
 * hljs language per file section (null = plain), memoized by section
 * key so a multi-file diff resolves each file once. A headerless
 * single-file diff falls back to the filePath prop (the pane names it).
 */
const sectionLang = computed(() => {
  const map = new Map<string, string | null>();
  for (const section of model.value.sections) {
    map.set(section.key, diffLanguage(section.filePath ?? props.filePath));
  }
  return map;
});

/**
 * Tokenized pieces for a content row, or null when the plain / word-hl
 * path should render instead (syntax off, unknown language, huge line).
 */
function pieces(row: DiffContentRow, section: DiffFileSection): ReturnType<typeof syntaxPieces> {
  return syntaxPieces(row, sectionLang.value.get(section.key) ?? null, props.syntax === true);
}

/** Pieces for one side of a split row (null cell = empty padding). */
function sidePieces(
  row: DiffContentRow | null,
  section: DiffFileSection
): ReturnType<typeof syntaxPieces> {
  return row ? pieces(row, section) : null;
}

const isSplit = computed(() => props.mode === 'split');

/** Hunks edited within this window get the flash background (CLI parity). */
const HUNK_FLASH_MS = 1500;

const model = computed(() => buildDiffModel(props.diff));

/**
 * Header policy: the prop forces them on; otherwise only multi-file
 * diffs show them. (An absent boolean prop arrives as false — Vue's
 * boolean casting — so this is force-on OR auto, not a tri-state.)
 */
const showHeaders = computed(
  () => props.showFileHeaders || model.value.sections.filter((s) => s.filePath !== null).length > 1
);

// Relative hunk times tick: one light 1s interval, only while the
// newest editedAt stamp is in the sub-minute range — that is the only
// window where the label changes every second. Older stamps ("5
// minutes ago") need no ticker; the interval also stops itself once
// the stamp ages past the window. Cleared on unmount.
const TICK_WINDOW_MS = 60_000;

const now = ref(Date.now());
let ticker: ReturnType<typeof setInterval> | null = null;

function needsTick(): boolean {
  const latest = model.value.latestEditedAt;
  return latest !== undefined && Date.now() - latest < TICK_WINDOW_MS;
}

function stopTicker(): void {
  if (ticker !== null) {
    clearInterval(ticker);
    ticker = null;
  }
}

function syncTicker(): void {
  if (needsTick()) {
    if (ticker === null) {
      ticker = setInterval(() => {
        now.value = Date.now();
        if (!needsTick()) stopTicker(); // stamp aged out — last label sticks
      }, 1000);
    }
  } else {
    stopTicker();
  }
}

watch(() => model.value.latestEditedAt, syncTicker, { immediate: true });

onBeforeUnmount(stopTicker);

function hunkTime(hunk: DiffHunkGroup): string {
  return hunk.editedAt !== undefined ? formatRelativeTime(hunk.editedAt, now.value) : '';
}

function isFresh(hunk: DiffHunkGroup): boolean {
  return hunk.editedAt !== undefined && now.value - hunk.editedAt < HUNK_FLASH_MS;
}

function marker(row: DiffContentRow): string {
  if (row.kind === 'add') return '+';
  if (row.kind === 'del') return '-';
  return '';
}

const hasNotes = computed(() => model.value.sections.some((s) => s.notes.length > 0));
</script>

<template>
  <div v-if="model.rowCount === 0" class="diff-empty" data-testid="diff-empty">
    <p v-if="model.isBinary">Binary file — no text diff to show.</p>
    <template v-else-if="hasNotes">
      <p
        v-for="(note, i) in model.sections.flatMap((s) => s.notes)"
        :key="i"
        class="empty-note mono"
      >
        {{ note }}
      </p>
      <p>No text changes to show.</p>
    </template>
    <p v-else>No changes to show.</p>
  </div>

  <div
    v-else
    class="diff-scroll mono"
    :class="{ 'with-file-headers': showHeaders }"
    data-testid="diff-view"
    :style="{ '--ln-w': `${model.lineNumWidth}ch` }"
  >
    <section v-for="s in model.sections" :key="s.key" class="file-section">
      <div v-if="showHeaders && s.filePath" class="file-header" data-testid="file-section-header">
        <span class="pin-x">{{ s.filePath }}</span>
      </div>
      <div v-for="(note, i) in s.notes" :key="i" class="file-note">
        <span class="pin-x">{{ note }}</span>
      </div>

      <section
        v-for="h in s.hunks"
        :key="h.key"
        class="hunk"
        :class="{ flash: isFresh(h) }"
        :data-edited-at="h.editedAt"
      >
        <div class="hunk-header" data-testid="hunk-header">
          <span class="pin-x">
            <span v-if="h.oldRange" class="ranges">Lines {{ h.oldRange }} → {{ h.newRange }}</span>
            <span v-else class="ranges">{{ h.raw }}</span>
            <span v-if="h.context" class="hunk-context">{{ h.context }}</span>
            <span v-if="h.editedAt !== undefined" class="hunk-time" data-testid="hunk-time">{{
              hunkTime(h)
            }}</span>
          </span>
        </div>

        <!-- Unified: one stacked stream of rows. -->
        <template v-if="!isSplit">
          <div v-for="row in h.rows" :key="row.key" class="row" :class="row.kind">
            <span class="ln old">{{ row.oldLineNum ?? '' }}</span
            ><span class="ln new">{{ row.newLineNum ?? '' }}</span
            ><span class="marker">{{ marker(row) }}</span
            ><span class="content"><DiffLineContent :row="row" :pieces="pieces(row, s)" /></span>
          </div>
        </template>

        <!-- Split: old on the left, new on the right, one visual row per
             pair (unbalanced runs pad the short side). Each side is its
             own horizontal scroller; the rows keep equal heights, so the
             two columns stay aligned and share the vertical scroll. -->
        <div v-else class="split-body">
          <div class="split-side left">
            <div
              v-for="sr in splitRows(h.rows)"
              :key="sr.key"
              class="split-line"
              :class="[sr.left ? sr.left.kind : 'empty']"
            >
              <span class="ln">{{ sr.left?.oldLineNum ?? '' }}</span
              ><span class="marker">{{ sr.left && sr.left.kind === 'del' ? '-' : '' }}</span
              ><span class="content"
                ><DiffLineContent v-if="sr.left" :row="sr.left" :pieces="sidePieces(sr.left, s)"
              /></span>
            </div>
          </div>
          <div class="split-side right">
            <div
              v-for="sr in splitRows(h.rows)"
              :key="sr.key"
              class="split-line"
              :class="[sr.right ? sr.right.kind : 'empty']"
            >
              <span class="ln">{{ sr.right?.newLineNum ?? '' }}</span
              ><span class="marker">{{ sr.right && sr.right.kind === 'add' ? '+' : '' }}</span
              ><span class="content"
                ><DiffLineContent v-if="sr.right" :row="sr.right" :pieces="sidePieces(sr.right, s)"
              /></span>
            </div>
          </div>
        </div>
      </section>
    </section>
  </div>
</template>

<style scoped>
.diff-empty {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.25rem;
  color: var(--text-dim);
  font-size: var(--fs-content);
}

.diff-empty p {
  margin: 0;
}

.empty-note {
  font-size: var(--fs-small);
}

.diff-scroll {
  /* File-section header height — fixed so the hunk headers below can
     stick exactly underneath it in multi-file mode. */
  --fh-h: 1.75rem;
  height: 100%;
  overflow-y: auto;
  /* Deterministic horizontal scrollbar: always show the track, so a
     wide line realizing under content-visibility can never ADD a
     scrollbar (and ~15px of height) that the exact-height model didn't
     count — DiffStack probes the track height once (scrollbarH) and
     bakes it into every computed body height. `scrollbar-gutter` is no
     help here: it only reserves inline-axis space for the VERTICAL
     scrollbar. */
  overflow-x: scroll;
  background: var(--bg);
  font-size: var(--fs-base);
  line-height: 1.55;
}

/* Sections span the full horizontal scroll width so header/hunk
   backgrounds and hairlines don't stop at the viewport edge; the
   sticky .pin-x keeps their text readable while scrolled. */
.file-section,
.hunk {
  width: max-content;
  min-width: 100%;
}

.file-section + .file-section {
  margin-top: 0.75rem;
}

/* Multi-file mode only (single-file diffs render no file header — the
   pane chrome names the file). Sticky above the hunk headers: within
   its own section it pins to the top; the next section's header pushes
   it away. Fixed height so .hunk-header can stick right below it. */
.file-header {
  position: sticky;
  top: 0;
  z-index: 3;
  display: flex;
  align-items: center;
  height: var(--fh-h);
  padding: 0 0.75rem;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  font-weight: 600;
  white-space: nowrap;
}

.file-note {
  padding: 0.125rem 0.75rem;
  color: var(--text-dim);
  font-size: var(--fs-small);
  white-space: nowrap;
}

/* Keeps header/hunk text readable while horizontally scrolled. */
.pin-x {
  position: sticky;
  left: 0;
  display: inline-block;
  max-width: 100%;
}

/* Each hunk is its own section so its sticky header is pushed away by
   the next hunk's header instead of piling up. position:relative
   anchors the fresh-hunk flash overlay. */
.hunk {
  position: relative;
  border-bottom: 1px solid var(--border);
}

.hunk:last-child {
  border-bottom: none;
}

/* With file headers shown, hunk headers stick just below them. */
.with-file-headers .hunk-header {
  top: var(--fh-h);
}

.hunk-header {
  position: sticky;
  top: 0;
  z-index: 2;
  padding: 0.1875rem 0.75rem;
  background: var(--surface);
  border-top: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
  font-size: var(--fs-small);
  white-space: nowrap;
}

.hunk-header .ranges {
  color: var(--selection);
}

.hunk-header .hunk-context {
  color: var(--text-dim);
  margin-left: 1ch;
}

.hunk-header .hunk-context::before {
  content: '· ';
}

.hunk-header .hunk-time {
  color: var(--text-dim);
  margin-left: 1ch;
}

.hunk-header .hunk-time::before {
  content: '· ';
}

/* Fresh-hunk flash: a translucent overlay across the WHOLE hunk —
   header and rows — that fades out. An overlay (::after) rather than a
   background because the rows paint their own backgrounds, which would
   cover a background on the group. z-index 2 with later document order:
   above the sticky hunk header (so the header flashes too — but the
   overlay is translucent, keeping it readable) and below the z-3
   file-section headers. pointer-events off so text selection keeps
   working. */
.hunk.flash::after {
  content: '';
  position: absolute;
  inset: 0;
  z-index: 2;
  pointer-events: none;
  background: var(--flash);
  opacity: 0;
  animation: hunk-flash 1.4s ease-out;
}

@keyframes hunk-flash {
  0% {
    opacity: 0.3;
  }
  100% {
    opacity: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  /* No animation — a static highlight that simply goes away when the
     flash window closes (isFresh flips off). */
  .hunk.flash::after {
    animation: none;
    opacity: 0.18;
  }
}

/* --- Rows --- */

.row {
  display: grid;
  grid-template-columns: var(--ln-w, 3ch) var(--ln-w, 3ch) 2ch 1fr;
  column-gap: 0.75ch;
  width: max-content;
  min-width: 100%;
  background: var(--bg);
  /* Virtualization: skip layout+paint for off-screen rows. The
     intrinsic size uses the PROBED row height (--row-h, published by
     DiffStack's measureProbe) so a skipped row occupies exactly the
     height the exact-body-height model computed — a hardcoded second
     constant here would drift from the probe and make realization
     shift offsets (the freeze fuel). The rem value is only the
     fallback until the probe lands; the `auto` keyword lets the
     browser's remembered size win once a row has been realized. */
  content-visibility: auto;
  contain-intrinsic-size: auto var(--row-h, 1.26rem);
}

.ln {
  text-align: right;
  padding-left: 0.75ch;
  color: var(--diff-context-line-num);
  user-select: none;
}

.marker {
  text-align: center;
  user-select: none;
}

.content {
  white-space: pre;
  tab-size: 4;
  padding-right: 1.5ch;
  color: var(--diff-text);
  /* Real content: opt back in against the body-wide non-selectable
     default so the diff text is copyable. The line-number and marker
     gutters stay user-select:none, so a selection copies clean code
     without the leading numbers or +/- symbols. */
  user-select: text;
  -webkit-user-select: text;
}

.row.add {
  background: var(--diff-add-bg);
}

.row.add .ln {
  color: var(--diff-add-line-num);
}

.row.add .marker {
  color: var(--diff-add-symbol);
  font-weight: 700;
}

.row.del {
  background: var(--diff-del-bg);
}

.row.del .ln {
  color: var(--diff-del-line-num);
}

.row.del .marker {
  color: var(--diff-del-symbol);
  font-weight: 700;
}

.row.add .word-hl {
  background: var(--diff-add-highlight);
  border-radius: 2px;
}

.row.del .word-hl {
  background: var(--diff-del-highlight);
  border-radius: 2px;
}

/* --- Split view (old | new, side by side) --- */

/* Old on the left, new on the right, sharing one horizontal scroller (the
   pane's own .diff-scroll, whose always-on track the exact-body-height
   model already counts). The two sides size to their content — short
   lines fall back to a 50/50 fill via the flex basis, long lines widen
   their side so the whole body overflows .diff-scroll and scrolls there.
   Crucially the sides do NOT clip: an earlier per-side overflow hid long
   lines behind a scrollbar-less edge (unreachable). No per-side scrollbar
   means no extra height, so the height model stays exact. */
.split-body {
  display: flex;
  align-items: stretch;
  width: max-content;
  min-width: 100%;
}

.split-side {
  /* No min-width:0 and no own overflow: the side's min-content is its
     widest line (white-space: pre), so content is never clipped — it
     widens the side and scrolls via .diff-scroll instead. */
  flex: 1 1 50%;
}

.split-side.left {
  border-right: 1px solid var(--border);
}

.split-line {
  display: grid;
  grid-template-columns: var(--ln-w, 3ch) 2ch 1fr;
  column-gap: 0.75ch;
  width: max-content;
  min-width: 100%;
  /* Floor empty (padding) rows to a full row so both sides line up; a
     realized content row is naturally this tall (the probed --row-h),
     so this never resizes a non-empty line. */
  min-height: var(--row-h, 1.26rem);
  background: var(--bg);
  /* Same virtualization contract as unified .row — the height model
     counts split rows at this same --row-h. */
  content-visibility: auto;
  contain-intrinsic-size: auto var(--row-h, 1.26rem);
}

.split-line .ln {
  text-align: right;
  padding-left: 0.75ch;
  color: var(--diff-context-line-num);
  user-select: none;
}

.split-line .marker {
  text-align: center;
  user-select: none;
}

.split-line.add {
  background: var(--diff-add-bg);
}

.split-line.add .ln {
  color: var(--diff-add-line-num);
}

.split-line.add .marker {
  color: var(--diff-add-symbol);
  font-weight: 700;
}

.split-line.del {
  background: var(--diff-del-bg);
}

.split-line.del .ln {
  color: var(--diff-del-line-num);
}

.split-line.del .marker {
  color: var(--diff-del-symbol);
  font-weight: 700;
}

/* Padding cell opposite a lone add/del — a muted "nothing here" filler. */
.split-line.empty {
  background: var(--surface);
}

.split-line.add .word-hl {
  background: var(--diff-add-highlight);
  border-radius: 2px;
}

.split-line.del .word-hl {
  background: var(--diff-del-highlight);
  border-radius: 2px;
}
</style>
