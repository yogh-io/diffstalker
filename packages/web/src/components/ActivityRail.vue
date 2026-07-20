<script setup lang="ts">
/**
 * Activity rail: switches the primary view. Four entries — Changes,
 * History, Compare, Explorer (Commit lives inside Changes). The active
 * entry carries the add-green indicator bar: the diff palette speaking
 * in the chrome. Collapses to icons on narrow screens.
 */

import { useUiStore, VIEWS } from '../stores/ui';
import type { ViewName } from '../prefs';

const ui = useUiStore();

/** Minimal 16x16 stroke icons, one per view. */
const ICON_PATHS: Record<ViewName, string> = {
  changes: 'M8 1.5v5M5.5 4h5M4.5 11.5h7',
  history: 'M8 4.5V8l2.4 1.5M14 8A6 6 0 1 1 8 2a6 6 0 0 1 6 6Z',
  compare: 'M5 13V3.5M2.8 5.7 5 3.5l2.2 2.2M11 3v9.5M8.8 10.3 11 12.5l2.2-2.2',
  explorer: 'M2 4h4l1.5 1.5H14V13H2Z',
};
</script>

<template>
  <nav class="rail" aria-label="Views">
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
  </nav>
</template>

<style scoped>
.rail {
  grid-area: rail;
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
  width: 10.5rem;
  padding: 0.5rem 0;
  background: var(--surface);
  border-right: 1px solid var(--border);
}

.rail-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 0.625rem;
  padding: 0.5rem 1rem;
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

/* The signature: the active view's indicator is the theme's add-green. */
.rail-item.active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0.375rem;
  bottom: 0.375rem;
  width: 2px;
  background: var(--accent);
}

.rail-item.active svg {
  color: var(--accent);
}

.rail-label {
  white-space: nowrap;
}

@media (max-width: 56rem) {
  .rail {
    width: 3rem;
    align-items: center;
  }

  .rail-item {
    padding: 0.5rem;
  }

  .rail-label {
    display: none;
  }
}
</style>
