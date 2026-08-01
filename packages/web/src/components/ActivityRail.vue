<script setup lang="ts">
/**
 * Activity rail: switches the primary view. Five entries — Changes,
 * Journal, History, Compare, Explorer (Commit lives inside Changes). The active
 * entry carries the add-green indicator bar: the diff palette speaking
 * in the chrome. Collapses to icons on narrow screens.
 *
 * The band is ONE flex row: the tabs LEFT-aligned
 * (justify-content: flex-start), then the global display toggles as a
 * right-aligned flex group (.band-right, margin-left auto). The tabs stay
 * left-aligned on every view. On narrow widths the toggle group wraps to
 * its own line.
 *
 * The active view's lifted per-view toolbar (Compare's base picker,
 * Explorer's filters) does NOT live here — it goes in ViewToolbarStrip, a
 * dedicated full-width row under this rail — so view-specific controls
 * never share the row with the global toggles.
 */

import { computed } from 'vue';
import { beginUserNav } from '../composables/useUrlSync';
import { useUiStore, VIEWS } from '../stores/ui';
import { useRepoStore } from '../stores/repo';
import HeaderToggles from './HeaderToggles.vue';
import type { ViewName } from '../prefs';

const ui = useUiStore();
const repo = useRepoStore();

/**
 * Changed-file count on the Changes tab, so the tab itself says whether
 * there is anything to look at — no navigating over to find an empty
 * view. Null (no count rendered) only before a status has ever loaded;
 * once it has, 0 is shown deliberately, since "nothing to do" is exactly
 * what the number is there to tell you.
 *
 * Counts status.files, the same array the status bar's "N changed" and
 * ChangesView's clean-tree check use, so a 0 here always coincides with
 * the "working tree is clean" message rather than disagreeing with it.
 */
const changedCount = computed(() => repo.shared.status?.files.length ?? null);

/**
 * Commit count on the Compare tab, for the same reason and read the same
 * way. Unlike Changes, compare data is not streamed — the store keeps this
 * one number live off GET /compare/count, so the badge is there before the
 * view has ever been opened. Null (nothing rendered) while it is unknown or
 * there is no base branch to compare against; 0 is shown, since "your
 * branch matches the base" is exactly what it is there to say.
 */
const compareCommitCount = computed(() => repo.compare.commitCount);

/** The count a tab shows, or null for tabs that carry none. */
function countFor(name: ViewName): number | null {
  if (name === 'changes') return changedCount.value;
  if (name === 'compare') return compareCommitCount.value;
  return null;
}

/** Tooltip: the tab's name, plus what its count means when it has one. */
function titleFor(name: ViewName, label: string): string {
  const count = countFor(name);
  if (count === null) return label;
  if (name === 'changes') {
    return `${label} — ${count} changed file${count === 1 ? '' : 's'}`;
  }
  return `${label} — ${count} commit${count === 1 ? '' : 's'} vs the base branch`;
}

/** Minimal 16x16 stroke icons, one per view. */
const ICON_PATHS: Record<ViewName, string> = {
  changes: 'M8 1.5v5M5.5 4h5M4.5 11.5h7',
  journal: 'M2.5 3.5h11M2.5 7h5.5M2.5 10.5h4M13.5 11a2.75 2.75 0 1 1-5.5 0 2.75 2.75 0 0 1 5.5 0ZM10.75 9.6V11l1 .75',
  history: 'M8 4.5V8l2.4 1.5M14 8A6 6 0 1 1 8 2a6 6 0 0 1 6 6Z',
  compare: 'M5 13V3.5M2.8 5.7 5 3.5l2.2 2.2M11 3v9.5M8.8 10.3 11 12.5l2.2-2.2',
  explorer: 'M2 4h4l1.5 1.5H14V13H2Z',
};

/** A tab click is a navigation: it gets its own history entry. */
function chooseView(view: ViewName): void {
  beginUserNav({ view });
  ui.setActiveView(view);
}
</script>

<template>
  <nav ref="railEl" class="rail" aria-label="Views">
    <button
      v-for="view in VIEWS"
      :key="view.name"
      class="rail-item"
      :class="{ active: ui.activeView === view.name }"
      :aria-current="ui.activeView === view.name ? 'page' : undefined"
      :title="titleFor(view.name, view.label)"
      @click="chooseView(view.name)"
    >
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
        <path
          :d="ICON_PATHS[view.name]"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
      <span class="rail-label">{{ view.label }}</span>
      <!-- Sibling of the label, not a child: the cramped band hides
           .rail-label for icon-only tabs, and the count is precisely what
           should survive that — it is the reason not to open the tab. -->
      <span
        v-if="countFor(view.name) !== null"
        class="rail-count"
        :data-testid="`${view.name}-count`"
        >({{ countFor(view.name) }})</span
      >
    </button>

    <!-- Right group, pinned to the band's right edge: the global display
         toggles. (Per-view toolbars live in ViewToolbarStrip, their own row.) -->
    <div class="band-right">
      <HeaderToggles />
    </div>
  </nav>
</template>

<style scoped>
/* The rail is a full-width horizontal tab band under the header at every
   width — one layout, no reflow to a left sidebar (which would eat
   horizontal room from the diff). */
.rail {
  grid-area: railband;
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: flex-start;
  flex-wrap: wrap;
  gap: 0.25rem;
  width: auto;
  min-height: 2.75rem;
  padding: 0.25rem var(--gutter);
  background: var(--surface);
  border-bottom: 1px solid var(--border);
}

.rail-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 0.625rem;
  padding: 0.375rem 0.75rem;
  color: var(--text-dim);
  font-size: var(--fs-base);
  text-align: left;
}

.rail-item:hover {
  color: var(--text);
}

.rail-item.active {
  color: var(--text);
}

/* The signature: the active view's indicator is the theme's add-green —
   a bar under the active tab in the horizontal band. */
.rail-item.active::before {
  content: '';
  position: absolute;
  left: 0.375rem;
  right: 0.375rem;
  bottom: 0;
  height: 2px;
  background: var(--accent);
}

.rail-item.active svg {
  color: var(--accent);
}

.rail-label {
  white-space: nowrap;
}

/* Dimmer than the label: the tab is still named "Changes", the count is
   an annotation on it, not part of the name. Negative margin pulls it
   off the flex gap so it reads as attached to the word, while staying a
   sibling that outlives the label in the cramped band. */
.rail-count {
  margin-left: -0.325rem;
  color: var(--text-dim);
  font-size: var(--fs-small);
  font-variant-numeric: tabular-nums;
}

.rail-item.active .rail-count {
  color: var(--text);
}

/* Right group: the view toolbar (adopted slot) + the global display
   toggles, pinned to the band's right edge (margin-left:auto). Wraps
   below the tabs when the band is too narrow. */
.band-right {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 0.625rem;
  min-width: 0;
  margin-left: auto;
  /* A hairline separates the global display toggles from the view tabs, so
     the two groups read as distinct zones of the band. */
  padding-left: 0.75rem;
  border-left: 1px solid var(--border);
}

/* Cramped band: drop the labels to icon-only tabs so all five fit
   without wrapping (the toolbar still shares the row on toolbar views). */
@media (max-width: 56rem) {
  .rail-item {
    padding: 0.5rem;
  }

  .rail-label {
    display: none;
  }

  /* The count stays: with the word gone it is the only thing telling you
     whether Changes is worth opening. Reclaim the label's flex gap. */
  .rail-count {
    /* margin-left is already -0.325rem from the base rule; only the size
       changes in the cramped band. */
    font-size: var(--fs-micro);
  }

  /* Cramped: drop the divider so the icon tabs and toggles sit flush. */
  .band-right {
    padding-left: 0;
    border-left: none;
  }
}
</style>

