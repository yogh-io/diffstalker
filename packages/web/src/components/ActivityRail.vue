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

import { useUiStore, VIEWS } from '../stores/ui';
import HeaderToggles from './HeaderToggles.vue';
import type { ViewName } from '../prefs';

const ui = useUiStore();

/** Minimal 16x16 stroke icons, one per view. */
const ICON_PATHS: Record<ViewName, string> = {
  changes: 'M8 1.5v5M5.5 4h5M4.5 11.5h7',
  journal: 'M2.5 3.5h11M2.5 7h5.5M2.5 10.5h4M13.5 11a2.75 2.75 0 1 1-5.5 0 2.75 2.75 0 0 1 5.5 0ZM10.75 9.6V11l1 .75',
  history: 'M8 4.5V8l2.4 1.5M14 8A6 6 0 1 1 8 2a6 6 0 0 1 6 6Z',
  compare: 'M5 13V3.5M2.8 5.7 5 3.5l2.2 2.2M11 3v9.5M8.8 10.3 11 12.5l2.2-2.2',
  explorer: 'M2 4h4l1.5 1.5H14V13H2Z',
};
</script>

<template>
  <nav ref="railEl" class="rail" aria-label="Views">
    <button
      v-for="view in VIEWS"
      :key="view.name"
      class="rail-item"
      :class="{ active: ui.activeView === view.name }"
      :aria-current="ui.activeView === view.name ? 'page' : undefined"
      :title="view.label"
      @click="ui.setActiveView(view.name)"
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
  padding: 0.25rem 0.75rem;
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

  /* Cramped: drop the divider so the icon tabs and toggles sit flush. */
  .band-right {
    padding-left: 0;
    border-left: none;
  }
}
</style>

