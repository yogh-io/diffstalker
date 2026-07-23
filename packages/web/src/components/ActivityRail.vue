<script setup lang="ts">
/**
 * Activity rail: switches the primary view. Five entries — Changes,
 * Journal, History, Compare, Explorer (Commit lives inside Changes). The active
 * entry carries the add-green indicator bar: the diff palette speaking
 * in the chrome. Collapses to icons on narrow screens.
 *
 * Portrait: the rail rotates into a full-width horizontal tab band
 * under the header (grid-area railband). The band is ONE flex row: the
 * tabs LEFT-aligned (justify-content: flex-start), then the
 * #view-toolbar-slot Teleport target as a right-aligned flex sibling
 * (margin-left auto) — never absolutely positioned, so lifted controls
 * (Explorer's filters, Compare's base picker) share the row with the
 * tabs instead of overlapping them; on narrow widths the row wraps and
 * the controls drop to their own line. The tabs stay left-aligned on
 * every view, toolbar or not. The slot is display:none in landscape —
 * views keep their toolbars inline (Teleport disabled), so the landscape
 * layout is untouched.
 *
 * The slot element itself lives OUT of the Vue tree (a static div in
 * index.html): a Vue-rendered Teleport target can be missing from the
 * document at the moment a teleporting view mounts (HMR remounts,
 * first-patch mounts) — the children then mount nowhere and every
 * later patch crashes on null els. The rail ADOPTS the element into
 * the band on mount and parks it back on <body> on unmount; moving a
 * DOM node keeps any teleported children alive, so views never notice.
 */

import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useUiStore, VIEWS } from '../stores/ui';
import type { ViewName } from '../prefs';

const ui = useUiStore();

const railEl = ref<HTMLElement | null>(null);

/** The adopted #view-toolbar-slot element (see the header comment). */
let slotEl: HTMLElement | null = null;

onMounted(() => {
  const rail = railEl.value;
  if (!rail) return;
  let slot = document.getElementById('view-toolbar-slot');
  if (!slot) {
    // No index.html in this document (tests mounting the rail alone).
    slot = document.createElement('div');
    slot.id = 'view-toolbar-slot';
  }
  slot.classList.add('toolbar-slot');
  rail.appendChild(slot);
  slotEl = slot;
});

onBeforeUnmount(() => {
  // Park the slot back on <body> so it stays in the document for the
  // next rail instance (and for teleports that outlive this one). Only
  // when actually in the document — detached test mounts just drop it.
  if (slotEl?.isConnected && railEl.value?.contains(slotEl)) {
    document.body.appendChild(slotEl);
  }
  slotEl = null;
});

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

    <!-- Portrait toolbar slot: the active view Teleports its toolbar
         controls into #view-toolbar-slot, which onMounted adopts from
         index.html as the last band child (right here). Hidden (and
         empty) in landscape. -->
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

/* Cramped band: drop the labels to icon-only tabs so all five fit
   without wrapping (the toolbar still shares the row on toolbar views). */
@media (max-width: 56rem) {
  .rail-item {
    padding: 0.5rem;
  }

  .rail-label {
    display: none;
  }
}
</style>

<!-- The slot element is adopted from index.html (see the script), so it
     never carries this component's scope attribute — its rules must be
     UNSCOPED. The .toolbar-slot class is only ever on that one element. -->
<style>
/* Landscape: the slot is inert — views render their toolbars inline. */
.toolbar-slot {
  display: none;
}

/* Parked on <body> (rail not mounted, e.g. mid-HMR): never render. */
body > .toolbar-slot {
  display: none;
}

@media (orientation: portrait), (max-aspect-ratio: 1/1), (max-width: 1400px) {
  /* Toolbar region for the active view's lifted controls: a flex
     SIBLING of the tabs in the same row (never absolutely positioned,
     so it cannot overlap them). margin-left:auto pushes it to the
     right edge; when the band runs out of width the row wraps and the
     controls drop to their own line. The controls themselves may wrap
     too. */
  .rail > .toolbar-slot {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 0.625rem;
    min-width: 0;
    margin-left: auto;
  }

  /* Nothing teleported (Changes/History): drop the empty slot from flow.
     The tabs are left-aligned (justify-content: flex-start) on every view,
     so all four tabs line up on the left whether or not a toolbar lifts in. */
  .rail > .toolbar-slot:empty {
    display: none;
  }
}
</style>
