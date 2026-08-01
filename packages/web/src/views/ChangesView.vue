<script setup lang="ts">
/**
 * Changes view: the working-tree viewer as a GitHub-style stacked diff
 * surface — files | ONE DiffStack rendering every file's diff, with a
 * draggable split between them. The one write affordance is a per-row
 * stage (+) / unstage (−) button (repo.stageFile / unstageFile); there
 * is still no discard, no commit, no hunk-staging — those stay in the
 * terminal UI.
 *
 * Files column — a JUMP NAVIGATOR, not a detail switcher:
 * shared.status.files grouped by core's fileCategories into Modified /
 * Untracked / Staged. Clicking (or arrow-keying) a row smooth-scrolls
 * the stack to that file's section and OPTIMISTICALLY sets
 * ui.activeStackKey; the stack's scroll-spy writes the same key back as
 * the user scrolls, so the highlighted row always tracks what is on
 * screen. Enter focuses the target section. repo.selectFile still
 * records the active FileEntry (identity-based — rows never clone
 * entries) but fetches nothing.
 *
 * Diff column: the shared DiffStack over stackFiles — the ordered file
 * list mapped onto the store's workingDiffs cache (key `s:`/`u:` +
 * path, mirroring the list rows; a file both staged and modified gets
 * two sections). Entries whose diff hasn't landed render a stats-sized
 * placeholder. Manual per-file collapse is view-local; huge files
 * start collapsed behind DiffStack's "Load diff" gate.
 *
 * Auto mode (the AUTO-SCROLL-ONLY-IN-AUTO-MODE decision): this view
 * registers a jump target with useAutoMode. ONLY auto mode may scroll
 * the stack on live edits — with it off, churn updates in place (the
 * anchor sandwich keeps it shift-free) and the fresh hunk just flashes.
 * The jump lands on the freshest-edited hunk when one is stamped.
 */

import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { beginUserNav } from '../composables/useUrlSync';
import { useRepoStore, workingDiffKey } from '../stores/repo';
import { useUiStore } from '../stores/ui';
import { categorizeFiles } from '@diffstalker/core/view/fileCategories';
import { shortenPath } from '@diffstalker/core/view/formatPath';
import type { FileEntry } from '@diffstalker/core/git/status';
import { statusLetter } from '../utils/format';
import { nextIndex } from '../utils/listNav';
import { CHANGES_SPLIT_MIN, CHANGES_SPLIT_MAX, TOP_MIN, TOP_MAX } from '../prefs';
import { usePortrait } from '../composables/useMediaQuery';
import { useSplitDrag } from '../composables/useSplitDrag';
import { makeBandKeyHandler, portraitPayloadAttrs } from '../composables/usePortraitKeys';
import { registerStackAutoJump } from '../composables/useAutoMode';
import { useActiveRowScroll } from '../composables/useActiveRowScroll';
import DiffStack, { HUGE_FILE_CHANGED_LINES, type StackFile } from '../components/DiffStack.vue';

const repo = useRepoStore();
const ui = useUiStore();

const status = computed(() => repo.shared.status);

/**
 * Clean tree: status is in and holds no files. The whole two-column
 * layout is replaced by one centered message — a clean tree has no
 * list to navigate and no diffs to stack.
 */
const isClean = computed(
  () => !repo.shared.isLoading && status.value !== null && status.value.files.length === 0
);

/** Auto mode just landed on this file: flash its row briefly. */
function isFlashed(file: FileEntry): boolean {
  return ui.flashedFile === file.path;
}
const categories = computed(() => categorizeFiles(status.value?.files ?? []));

/** The three sections, in the app-wide order; empty ones are hidden. */
const sections = computed(() =>
  (
    [
      { name: 'Modified', files: categories.value.modified },
      { name: 'Untracked', files: categories.value.untracked },
      { name: 'Staged', files: categories.value.staged },
    ] as const
  ).filter((section) => section.files.length > 0)
);

/**
 * Row/section key. The store's own export, not a copy: it fills and prunes
 * workingDiffs.byKey with this function, so a drifted second copy would turn
 * every diff into a placeholder AND prune every cache entry.
 */
const rowKey = workingDiffKey;

function isActive(file: FileEntry): boolean {
  return ui.activeStackKey === rowKey(file);
}

/** Shortened path split into a dimmed dir prefix and emphasized basename. */
function splitPath(path: string): { dir: string; base: string } {
  const shortened = shortenPath(path, 56);
  const idx = shortened.lastIndexOf('/');
  if (idx === -1) return { dir: '', base: shortened };
  return { dir: shortened.slice(0, idx + 1), base: shortened.slice(idx + 1) };
}

/**
 * Hunk-count indicator, CLI semantics (FileList.formatHunkIndicator):
 * "●total" when every hunk is on this row's side, else "●n/total".
 */
function hunkIndicator(file: FileEntry): string {
  const counts = repo.shared.hunkCounts;
  if (!counts || file.status === 'untracked') return '';
  const staged = counts.staged[file.path] ?? 0;
  const unstaged = counts.unstaged[file.path] ?? 0;
  const total = staged + unstaged;
  if (total === 0) return '';
  const thisCount = file.staged ? staged : unstaged;
  return thisCount === total ? `●${total}` : `●${thisCount}/${total}`;
}

// --- The stack (right pane) ---

const stackEl = ref<InstanceType<typeof DiffStack> | null>(null);
/** The stack's scroll container — the portrait j/k payload target. */
const diffsEl = computed(() => stackEl.value?.scrollerEl ?? null);

/** View-local manual collapse, by row key (huge-file gate is the stack's). */
const collapsedFiles = reactive(new Set<string>());

function toggleFileCollapsed(key: string): void {
  if (collapsedFiles.has(key)) collapsedFiles.delete(key);
  else collapsedFiles.add(key);
}

// Per-repo UI state: a repo switch must not leak the previous repo's
// active/collapsed state onto a same-path file in the new repo. The
// DiffStack subtree is additionally keyed by repoId in the template,
// so its own per-key state (loaded huge files, the gate latch)
// remounts clean.
watch(
  () => repo.repoId,
  () => {
    ui.setActiveStackKey(null);
    collapsedFiles.clear();
  }
);

/**
 * The ordered file list mapped onto the stack's shape, diffs from the
 * store's workingDiffs cache (null until a fetch lands -> placeholder).
 * Unchanged files keep their DiffResult identity (the store preserves
 * it), so the stack patches only what actually changed.
 */
const stackFiles = computed<StackFile[]>(() => {
  const { byKey } = repo.workingDiffs;
  return categories.value.ordered.map((file) => {
    const key = rowKey(file);
    return {
      key,
      path: file.path,
      status: file.status,
      staged: file.staged,
      stats: { insertions: file.insertions ?? 0, deletions: file.deletions ?? 0 },
      diff: byKey.get(key)?.diff ?? null,
      collapsed: collapsedFiles.has(key),
    };
  });
});

// --- Jump navigation ---

/**
 * Epoch ms of the last explicit list-click jump. Auto mode's
 * manual-input deferral reads the max of this and the stack's own
 * lastUserScrollAt, so an auto jump can't cancel a click's glide
 * mid-flight — the click is user intent just like a wheel turn.
 */
let lastListJumpAt = 0;

/**
 * The one selection path: record the active file (identity handed to
 * the store), set the key optimistically, and glide the stack there —
 * the spy confirms (or corrects) the key when the scroll settles.
 */
function jumpToFile(file: FileEntry): void {
  lastListJumpAt = Date.now();
  repo.selectFile(file);
  ui.setActiveStackKey(rowKey(file));
  stackEl.value?.scrollToFile(rowKey(file), { smooth: true });
}

/**
 * Clicking or confirming a row: a deliberate landing, so it gets its own
 * history entry. Arrow movement calls jumpToFile directly and stays out of
 * the history — holding Down would mint one entry per row.
 */
function activateFile(file: FileEntry): void {
  beginUserNav({ view: 'changes' });
  jumpToFile(file);
}

/** Enter on a row: jump AND move focus into the target section. */
function jumpAndFocusSection(file: FileEntry): void {
  activateFile(file);
  void nextTick(() => stackEl.value?.focusFile(rowKey(file)));
}

// --- Keyboard selection (roving tabindex over the flat ordered list) ---

const listEl = ref<HTMLElement | null>(null);

/** Index of the active row: ui.activeStackKey first, selection fallback. */
function activeIndex(): number {
  const ordered = categories.value.ordered;
  const key = ui.activeStackKey;
  if (key !== null) {
    const idx = ordered.findIndex((file) => rowKey(file) === key);
    if (idx !== -1) return idx;
  }
  const selected = repo.selection.file;
  return selected ? ordered.indexOf(selected) : -1;
}

/** The row that holds tabindex 0: the active one, else the first. */
function isTabStop(file: FileEntry): boolean {
  const ordered = categories.value.ordered;
  const idx = activeIndex();
  return file === (idx >= 0 ? ordered[idx] : ordered[0]);
}

function moveSelection(delta: number): void {
  const ordered = categories.value.ordered;
  const next = nextIndex(activeIndex(), delta, ordered.length);
  if (next === -1) return;
  jumpToFile(ordered[next]);
  void nextTick(() => {
    listEl.value?.querySelectorAll<HTMLElement>('.file-row')[next]?.focus();
  });
}

// Focus recovery: if a state-change removes the row that held focus,
// focus would fall to <body>. Move it to the active row instead so
// keyboard navigation keeps working.
watch(
  () => categories.value.ordered,
  () => {
    // Default (pre) flush: the DOM still holds the old rows here.
    const hadFocus = listEl.value?.contains(document.activeElement) ?? false;
    void nextTick(() => {
      const list = listEl.value;
      if (!hadFocus || !list || list.contains(document.activeElement)) return;
      const idx = activeIndex();
      const rows = list.querySelectorAll<HTMLElement>('.file-row');
      (idx >= 0 ? rows[idx] : rows[0])?.focus();
    });
  }
);

// --- Keep the active row visible (spy-driven) ---

const filesColEl = ref<HTMLElement | null>(null);

/** Keep the active row visible in the files column (see useActiveRowScroll). */
const { onPointerEnter, onPointerLeave } = useActiveRowScroll(
  filesColEl,
  () => ui.activeStackKey,
  () => {
    const list = listEl.value;
    const idx = activeIndex();
    if (!list || idx < 0) return null;
    return list.querySelectorAll<HTMLElement>('.file-row')[idx] ?? null;
  }
);

/**
 * A URL restore asked for a file: put it on screen WITHOUT a tween — a
 * link opens at its anchor, it does not glide there from the top.
 */
watch(
  () => ui.stackScrollRequest,
  (request) => {
    if (!request) return;
    void nextTick(() => stackEl.value?.scrollToFile(request.key, { smooth: false }));
  }
);

// --- Auto mode: the registered jump target ---

/**
 * Content-stable KEY of the freshest-edited hunk in this row's cached
 * diff (max editedAt), null when nothing carries a stamp. Read LIVE
 * inside the tween's per-frame closure: a refetched diff landing
 * mid-glide re-derives the freshest hunk from the fresh model instead
 * of chasing a stale ordinal.
 */
function freshestHunkKey(key: string, staged: boolean): string | null {
  const entry = repo.workingDiffs.byKey.get(key);
  if (!entry) return null;
  const model = repo.diffModelFor(entry.diff, staged);
  let best: string | null = null;
  let bestAt = -Infinity;
  for (const section of model.sections) {
    for (const hunk of section.hunks) {
      if (hunk.editedAt !== undefined && hunk.editedAt > bestAt) {
        bestAt = hunk.editedAt;
        best = hunk.key;
      }
    }
  }
  return best;
}

/** Auto mode's jump: the freshest-changed file, ideally its fresh hunk. */
function autoJumpToPath(path: string): void {
  const entry = categories.value.ordered.find((file) => file.path === path);
  if (!entry) return;
  const key = rowKey(entry);
  ui.setActiveStackKey(key);
  // Defer the scroll one tick: a file that JUST entered the status set
  // has no mounted section yet when this fires (the jump rides the same
  // state that created the section). The optimistic key above stays
  // synchronous.
  void nextTick(() => {
    const stack = stackEl.value;
    if (!stack) return;
    // NEVER open or render a huge or binary file from an auto jump:
    // past the gate threshold the section top is the whole target (the
    // per-frame resolver would fall back there anyway — this guard also
    // skips building a huge model just to find a hunk). Binary models
    // are hunk-free, so they fall back to the section top naturally.
    if ((entry.insertions ?? 0) + (entry.deletions ?? 0) > HUGE_FILE_CHANGED_LINES) {
      stack.scrollToFile(key, { smooth: true });
      return;
    }
    stack.scrollToHunk(key, () => freshestHunkKey(key, entry.staged), { smooth: true });
  });
}

let unregisterAutoJump: (() => void) | null = null;

onMounted(() => {
  unregisterAutoJump = registerStackAutoJump({
    jump: autoJumpToPath,
    // Manual input on the stack OR an explicit list-click jump: both
    // defer an auto jump (never yank a glide the user asked for).
    lastUserScrollAt: () =>
      Math.max(stackEl.value?.lastUserScrollAt() ?? 0, lastListJumpAt),
  });
});

onBeforeUnmount(() => {
  unregisterAutoJump?.();
  unregisterAutoJump = null;
});

// --- Resizable split (column fraction in landscape, row in portrait) ---

const isPortrait = usePortrait();
const containerEl = ref<HTMLElement | null>(null);
const split = useSplitDrag({
  container: containerEl,
  isRow: isPortrait,
  column: {
    pref: 'changesSplit',
    defaultRatio: 0.32,
    min: CHANGES_SPLIT_MIN,
    max: CHANGES_SPLIT_MAX,
  },
  row: { pref: 'changesTop', defaultRatio: 0.3, min: TOP_MIN, max: TOP_MAX },
});

// --- Portrait keyboard: j/k in the band, j/k scroll in the stack ---

const onRowBandKeydown = makeBandKeyHandler(isPortrait, moveSelection);
// The stack's root is the diffs scroller — scroll it, not a nested pane.
const payloadAttrs = portraitPayloadAttrs(isPortrait, diffsEl, 'File diffs', { self: true });

/** Landscape emits exactly the pre-portrait style (only --files-col). */
const rootStyle = computed(() => ({
  '--files-col': `${(split.columnRatio.value * 100).toFixed(2)}%`,
  ...(isPortrait.value
    ? { '--changes-top': `${(split.rowRatio.value * 100).toFixed(2)}%` }
    : {}),
}));
</script>

<template>
  <div
    ref="containerEl"
    class="changes"
    :class="{ portrait: isPortrait }"
    :style="rootStyle"
  >
    <div v-if="isClean" class="clean-state" data-testid="clean-tree" role="status">
      <p class="clean-title">No changes in the staging area or untracked changes.</p>
      <p class="clean-sub">The working tree is clean.</p>
    </div>

    <aside
      v-else
      ref="filesColEl"
      class="files-col"
      aria-label="Changed files"
      @pointerenter="onPointerEnter"
      @pointerleave="onPointerLeave"
    >
      <p v-if="repo.shared.isLoading" class="panel-note">Loading status…</p>
      <p v-else-if="!status" class="panel-note">No status yet.</p>

      <div
        v-else
        ref="listEl"
        class="file-list"
        data-testid="file-list"
        role="listbox"
        aria-label="Changed files"
      >
        <section
          v-for="section in sections"
          :key="section.name"
          class="file-section"
          role="group"
          :aria-labelledby="`files-section-${section.name.toLowerCase()}`"
          :data-testid="`section-${section.name.toLowerCase()}`"
        >
          <h3 :id="`files-section-${section.name.toLowerCase()}`" class="section-header eyebrow">
            {{ section.name }} <span class="section-count">{{ section.files.length }}</span>
          </h3>
          <div
            v-for="file in section.files"
            :key="rowKey(file)"
            class="file-row mono list-row"
            :class="{ selected: isActive(file), flash: isFlashed(file) }"
            role="option"
            :aria-selected="isActive(file)"
            :tabindex="isTabStop(file) ? 0 : -1"
            :title="file.path"
            @click="activateFile(file)"
            @keydown.down.prevent="moveSelection(1)"
            @keydown.up.prevent="moveSelection(-1)"
            @keydown.enter.prevent="jumpAndFocusSection(file)"
            @keydown.space.prevent="activateFile(file)"
            @keydown="onRowBandKeydown"
          >
            <!-- Stage (+) an unstaged file, unstage (−) a staged one. At
                 the row START so it stays visible even when a long path
                 makes the row wider than the pane. Out of the
                 roving-tabindex band (tabindex -1) so it doesn't disturb
                 j/k row nav; @click.stop keeps the row's jump from firing. -->
            <button
              class="stage-btn"
              tabindex="-1"
              :data-testid="file.staged ? 'unstage-file' : 'stage-file'"
              :title="file.staged ? 'Unstage this file' : 'Stage this file'"
              :aria-label="`${file.staged ? 'Unstage' : 'Stage'} ${file.path}`"
              @click.stop="file.staged ? repo.unstageFile(file.path) : repo.stageFile(file.path)"
            >
              {{ file.staged ? '−' : '+' }}
            </button>
            <span class="letter" :data-status="file.status">{{ statusLetter(file.status) }}</span>
            <span class="path"
              ><span class="dir">{{ splitPath(file.path).dir }}</span
              ><span class="base">{{ splitPath(file.path).base }}</span></span
            >
            <span v-if="hunkIndicator(file)" class="hunks">{{ hunkIndicator(file) }}</span>
            <span class="stats">
              <span v-if="file.insertions" class="count-add">+{{ file.insertions }}</span>
              <span v-if="file.deletions" class="count-del">&minus;{{ file.deletions }}</span>
            </span>
          </div>
        </section>
      </div>
    </aside>

    <div
      v-if="!isClean"
      class="resizer"
      role="separator"
      :aria-orientation="split.ariaOrientation.value"
      aria-label="Resize file list"
      :aria-valuenow="split.ariaValueNow.value"
      :aria-valuemin="split.ariaValueMin.value"
      :aria-valuemax="split.ariaValueMax.value"
      tabindex="0"
      @pointerdown="split.onPointerDown"
      @pointermove="split.onPointerMove"
      @pointerup="split.onPointerUp"
      @pointercancel="split.onPointerCancel"
      @keydown="split.onKeydown"
    ></div>

    <!-- Keyed by repo id: a repo switch remounts the stack, clearing
         its per-key state (loaded huge files, gate latch, offsets). -->
    <DiffStack
      v-if="!isClean"
      ref="stackEl"
      :key="repo.repoId ?? ''"
      class="diff-col"
      data-testid="changes-diffs"
      :files="stackFiles"
      :active-key="ui.activeStackKey"
      :syntax="ui.diffSyntaxEnabled"
      :mode="ui.diffMode"
      :wrap="ui.wrapEnabled"
      v-bind="payloadAttrs"
      @active-file="ui.setActiveStackKey"
      @toggle-collapse="toggleFileCollapsed"
    />
  </div>
</template>

<style scoped>
.changes {
  height: 100%;
  display: grid;
  /* files | resizer | diffs */
  grid-template-columns: clamp(12rem, var(--files-col, 32%), 65%) auto minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr);
  background: var(--bg);
}

/* --- Clean tree: one centered message across the whole grid --- */

.clean-state {
  grid-column: 1 / -1;
  grid-row: 1 / -1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  padding: 2rem 1rem;
  text-align: center;
}

.clean-title {
  margin: 0;
  font-size: var(--fs-display);
  font-weight: 650;
  letter-spacing: -0.01em;
  color: var(--text);
}

.clean-sub {
  margin: 0;
  font-size: var(--fs-content);
  color: var(--text-dim);
}

/* --- Files column --- */

/* .files-col: shared panel surface, see style.css. */

.file-list {
  padding: 0.375rem 0;
}

.file-section + .file-section {
  margin-top: 0.5rem;
}

.section-header {
  margin: 0;
  padding: 0.25rem 0.75rem;
  font-weight: 500;
}

.section-count {
  color: var(--text-dim);
  opacity: 0.8;
}

.file-row {
  display: flex;
  align-items: baseline;
  gap: 0.625rem;
  width: 100%;
  padding: 0.2188rem 0.75rem;
  font-size: var(--fs-base);
  text-align: left;
}


.file-row.selected .base {
  color: var(--selection);
}

/* Auto mode: the freshly-changed row flashes briefly (the class is
   cleared on a timer in the ui store). */
.file-row.flash {
  animation: row-flash 0.9s ease-out;
}

@keyframes row-flash {
  0%,
  50% {
    box-shadow: inset 0 0 0 1px var(--flash);
    border-left-color: var(--flash);
  }

  100% {
    box-shadow: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  /* No animation — a static highlight that simply goes away when the
     flash window closes. */
  .file-row.flash {
    animation: none;
    box-shadow: inset 0 0 0 1px var(--flash);
  }
}

.path {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dir {
  color: var(--text-dim);
}

.base {
  color: var(--text);
  font-weight: 600;
}

.hunks {
  flex: none;
  margin-left: auto;
  font-size: var(--fs-small);
  color: var(--selection);
}

.stats {
  flex: none;
  display: inline-flex;
  gap: 0.375rem;
  font-size: var(--fs-small);
}

.file-row .stats {
  margin-left: auto;
}

.file-row .hunks + .stats {
  margin-left: 0;
}

/* Stage (+) / unstage (−) affordance at the row's start. Always shown but
   dim, brightening on hover, so it reads as an action without competing
   with the file name. Hover carries the semantic: staging goes add-green,
   unstaging goes deleted-red, so the direction is obvious before clicking. */
.stage-btn {
  flex: none;
  align-self: center;
  width: 1.375rem;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: var(--surface);
  color: var(--text-dim);
  font-size: var(--fs-content);
  line-height: 1.3;
  cursor: pointer;
}

.stage-btn:hover {
  color: var(--text);
  border-color: var(--text-dim);
  background: var(--surface-raised);
}

.stage-btn[data-testid='stage-file']:hover {
  color: var(--accent);
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 12%, var(--surface));
}

.stage-btn[data-testid='unstage-file']:hover {
  color: var(--status-deleted);
  border-color: var(--status-deleted);
}

/* --- Resizer --- */

.resizer {
  width: 5px;
  cursor: col-resize;
  background: transparent;
  touch-action: none;
}

.resizer:hover,
.resizer:focus-visible {
  background: var(--selection);
  opacity: 0.5;
}

/* --- Stacked diffs (right) --- */

/* Grid placement only — the stack itself (scroller, sticky headers,
   collapse, "Load diff") lives in DiffStack; this scoped rule reaches
   its root via the parent-scope attribute Vue puts on a child
   component's root. */
.diff-col {
  min-width: 0;
}

/* Portrait: rotate column → row. Full-width diffs below a bounded file
   band; the same resizer drags the row split. */
:root[data-split='stacked'] .changes {
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: minmax(6rem, var(--changes-top, 30vh)) 8px minmax(0, 1fr);
}

/* A visible divider bar (not a bare drag gap) so the file band and the
   diffs read as clearly separate, with a centered grab handle. */
:root[data-split='stacked'] .resizer {
  /* Paints BOTH its own edges, which is why the panels above and below draw
     none: with a panel border-bottom as well the boundary was three hairlines
     inside 9px. */
  display: block;
  width: auto;
  height: 8px;
  cursor: row-resize;
  background: var(--surface-raised);
  box-shadow:
    inset 0 1px 0 var(--border),
    inset 0 -1px 0 var(--border);
  position: relative;
}

:root[data-split='stacked'] .resizer::after {
  content: '';
  position: absolute;
  inset: 0;
  margin: auto;
  width: 2.25rem;
  height: 2px;
  border-radius: 1px;
  background: var(--text-dim);
  opacity: 0.5;
}

:root[data-split='stacked'] .resizer:hover,
:root[data-split='stacked'] .resizer:focus-visible {
  background: var(--selection);
}

:root[data-split='stacked'] .resizer:hover::after,
:root[data-split='stacked'] .resizer:focus-visible::after {
  background: var(--surface);
  opacity: 0.9;
}
</style>
