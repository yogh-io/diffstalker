<script lang="ts">
import type { DiffResult } from '@diffstalker/core/git/diff';
import type { FileStatus } from '@diffstalker/core/git/status';

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
 * by content-visibility: auto on each body wrapper with a stats-derived
 * intrinsic-size estimate, so a far-away file skips layout and paint as
 * one unit (rows keep their own per-row c-v inside DiffView).
 * content-visibility sits on the BODY, never the section — on the
 * section it would break the sticky header inside it. (Exact computed
 * heights replace the estimate in phase 2.)
 *
 * Scrolling: scrollToFile/scrollToHunk are exposed and INSTANT for now
 * (the smooth tween is phase 1). Both use scroller.scrollTo with the
 * section's scroller-relative offsetTop — never scrollIntoView, which
 * scrolls every ancestor and ignores sticky headers. 'active-file' is
 * emitted on programmatic jumps; the real scroll-spy is phase 1.
 */

import { ref, type ComponentPublicInstance } from 'vue';
import { statusLetter } from '../utils/format';
import DiffView from './DiffView.vue';

defineProps<{
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

/**
 * Height estimate for a skipped body: changed lines at DiffView's row
 * height, plus what stats don't count — a header row per hunk and the
 * surrounding context lines (up to 3 each side), which together can
 * double a body. Hunk count is guessed from changed-line volume; it
 * stays a cheap arithmetic estimate. Used by the placeholder branch
 * and by contain-intrinsic-size whenever c-v skips the body.
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
      <!-- Plain estimate, never `auto <px>`: the browser's remembered size
           goes stale when a skipped subtree is patched (§3 of the diff-stream
           doc). Phase 2 replaces the estimate with an exact computed height. -->
      <div
        v-show="!item.collapsed"
        class="file-diff-body"
        :style="{ containIntrinsicSize: `${estimateBodyHeight(item)}px` }"
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
   sized by the inline contain-intrinsic-size estimate. NEVER move
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
