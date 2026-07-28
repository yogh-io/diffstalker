<script setup lang="ts">
/**
 * WrapToggle: a small, low-key line-wrap toggle for a diff/file pane's
 * corner — deliberately NOT styled like the header's auto/syntax/split/
 * follow toggles (HeaderToggles). Those are app-wide display modes people
 * reach for constantly; wrap is closer to Notepad's/Word's "Word Wrap" —
 * an occasional, unobtrusive preference. Self-contained: reads and writes
 * ui.wrapEnabled directly, so any pane can drop this in with no props.
 */

import { useUiStore } from '../stores/ui';

const ui = useUiStore();
</script>

<template>
  <button
    class="wrap-toggle mono"
    data-testid="wrap-toggle"
    :class="{ on: ui.wrapEnabled }"
    :aria-pressed="ui.wrapEnabled"
    aria-label="Wrap long lines"
    :title="
      ui.wrapEnabled
        ? 'Wrap long lines: on. Click to scroll horizontally instead'
        : 'Wrap long lines: off. Click to wrap instead of scrolling horizontally'
    "
    @click="ui.toggleWrap()"
  >
    Wrap
  </button>
</template>

<style scoped>
.wrap-toggle {
  flex: none;
  padding: 0.125rem 0.375rem;
  border: 1px solid transparent;
  border-radius: 3px;
  font-size: var(--fs-micro);
  color: var(--text-dim);
  background: transparent;
}

.wrap-toggle:hover {
  color: var(--text);
  border-color: var(--border);
}

.wrap-toggle.on {
  color: var(--text);
  border-color: var(--border);
  background: var(--surface-raised);
}
</style>
