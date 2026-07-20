<script setup lang="ts">
/**
 * DiffView: renders ONE DiffResult as a DOM diff. Self-contained and
 * data-driven — Changes uses it now; History and Compare reuse it later.
 *
 * Layout: per hunk, a sticky header (readable ranges + relative edit
 * time) and a run of grid rows: old line number | new line number |
 * marker | content. All color comes from the --diff-* theme vars.
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
 * Syntax highlighting is a later slice — the content cell (.content)
 * is the seam: swap its text interpolation for highlighted spans.
 */

import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { DiffResult } from '@diffstalker/core/git/diff';
import { formatRelativeTime } from '@diffstalker/core/view/formatDate';
import { buildDiffModel } from '../utils/diffRows';
import type { DiffContentRow, DiffHunkGroup } from '../utils/diffRows';

const props = defineProps<{
  diff: DiffResult | null;
  /** Selected file's path — reserved for the syntax-highlighting seam. */
  filePath?: string;
  /** Unified is the only mode this slice; side-by-side comes with Compare. */
  mode?: 'unified';
}>();

/** Hunks edited within this window get the flash background (CLI parity). */
const HUNK_FLASH_MS = 1500;

const model = computed(() => buildDiffModel(props.diff));

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
    data-testid="diff-view"
    :style="{ '--ln-w': `${model.lineNumWidth}ch` }"
  >
    <section v-for="s in model.sections" :key="s.key" class="file-section">
      <div v-if="s.filePath" class="file-header">
        <span class="pin-x">{{ s.filePath }}</span>
      </div>
      <div v-for="(note, i) in s.notes" :key="i" class="file-note">
        <span class="pin-x">{{ note }}</span>
      </div>

      <section
        v-for="h in s.hunks"
        :key="h.key"
        class="hunk"
        :data-edited-at="h.editedAt"
      >
        <div class="hunk-header" :class="{ flash: isFresh(h) }" data-testid="hunk-header">
          <span class="pin-x">
            <span v-if="h.oldRange" class="ranges">Lines {{ h.oldRange }} → {{ h.newRange }}</span>
            <span v-else class="ranges">{{ h.raw }}</span>
            <span v-if="h.context" class="hunk-context">{{ h.context }}</span>
            <span v-if="h.editedAt !== undefined" class="hunk-time" data-testid="hunk-time">{{
              hunkTime(h)
            }}</span>
          </span>
        </div>

        <div v-for="row in h.rows" :key="row.key" class="row" :class="row.kind">
          <span class="ln old">{{ row.oldLineNum ?? '' }}</span
          ><span class="ln new">{{ row.newLineNum ?? '' }}</span
          ><span class="marker">{{ marker(row) }}</span
          ><span class="content"
            ><template v-if="row.segments"
              ><span
                v-for="(seg, i) in row.segments"
                :key="i"
                :class="{ 'word-hl': seg.type === 'changed' }"
                >{{ seg.text }}</span
              ></template
            ><template v-else>{{ row.content }}</template></span
          >
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
  height: 100%;
  overflow: auto;
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

/* Not sticky: the hunk header is the one sticky line (the file path is
   also in the pane chrome above the diff), so hunk info never hides. */
.file-header {
  padding: 0.25rem 0.75rem;
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
   the next hunk's header instead of piling up. */
.hunk {
  border-bottom: 1px solid var(--border);
}

.hunk:last-child {
  border-bottom: none;
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

.hunk-header.flash {
  animation: hunk-flash 1.4s ease-out;
}

@keyframes hunk-flash {
  0% {
    background: var(--flash);
    color: #000;
  }
  100% {
    background: var(--surface);
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
     intrinsic-size estimate only matters until a row is rendered once. */
  content-visibility: auto;
  contain-intrinsic-size: auto 1.26rem;
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
</style>
