<script setup lang="ts">
/**
 * ViewToolbarStrip: a full-width row under the activity rail that hosts the
 * active view's lifted toolbar (Compare's base + commits, Explorer's
 * filters) in the portrait / narrow-landscape layout. In wide landscape
 * (>1400px) views render their toolbars inline (their Teleport is
 * disabled) and this strip is empty, so the grid row collapses to 0px.
 *
 * The #view-toolbar-slot element lives OUTSIDE the Vue tree (a static div
 * in index.html): a Vue-rendered Teleport target can be missing from the
 * document at the moment a teleporting view mounts (HMR remounts,
 * first-patch mounts) — the children then mount nowhere and every later
 * patch crashes on null els. This component ADOPTS the element into the
 * strip on mount and parks it back on <body> on unmount; moving a live DOM
 * node keeps any teleported children alive, so views never notice.
 *
 * (Moved here from ActivityRail so the lifted controls get their OWN row
 * instead of sharing the rail's right group with the global display
 * toggles — which crammed view-specific controls next to global ones.)
 */
import { onBeforeUnmount, onMounted, ref } from 'vue';

const stripEl = ref<HTMLElement | null>(null);

/** The adopted #view-toolbar-slot element (see the header comment). */
let slotEl: HTMLElement | null = null;

onMounted(() => {
  const strip = stripEl.value;
  if (!strip) return;
  let slot = document.getElementById('view-toolbar-slot');
  if (!slot) {
    // No index.html in this document (unit tests mounting in isolation).
    slot = document.createElement('div');
    slot.id = 'view-toolbar-slot';
  }
  slot.classList.add('toolbar-slot');
  strip.appendChild(slot);
  slotEl = slot;
});

onBeforeUnmount(() => {
  // Park the slot back on <body> so it stays in the document for the next
  // strip instance (and for teleports that outlive this one). Check the
  // slot's own parent rather than the template ref, which Vue may null
  // during teardown.
  if (slotEl?.parentElement?.classList.contains('view-toolbar-strip')) {
    document.body.appendChild(slotEl);
  }
  slotEl = null;
});
</script>

<template>
  <div ref="stripEl" class="view-toolbar-strip"></div>
</template>

<style scoped>
.view-toolbar-strip {
  grid-area: viewtoolbar;
  min-width: 0;
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

/* Parked on <body> (strip not mounted, e.g. mid-HMR): never render. */
body > .toolbar-slot {
  display: none;
}

/* The active view's lifted controls get their OWN full-width row under
   the rail — never the rail's right group beside the global toggles. */
:root[data-split='stacked'] .view-toolbar-strip > .toolbar-slot {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.625rem;
  min-width: 0;
  padding: 0.375rem var(--gutter);
  background: var(--surface);
  border-bottom: 1px solid var(--border);
}

/* Nothing teleported (Changes / History): collapse the row to nothing. */
:root[data-split='stacked'] .view-toolbar-strip > .toolbar-slot:empty {
  display: none;
}
</style>
