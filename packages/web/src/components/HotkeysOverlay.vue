<script setup lang="ts">
/**
 * HotkeysOverlay: the keyboard-shortcut reference (`?`) — the web
 * analog of the CLI's HotkeysModal. Static content, interface voice.
 * Esc, `?`, the close button, or a click outside closes it (Esc and
 * `?` are handled by the global key layer). Focus is trapped and
 * returns on close.
 */

import { ref } from 'vue';
import { useUiStore, VIEWS } from '../stores/ui';
import { useFocusTrap } from '../composables/useFocusTrap';

const ui = useUiStore();

const dialogEl = ref<HTMLElement | null>(null);
useFocusTrap(dialogEl);

interface HotkeyGroup {
  title: string;
  entries: { keys: string; description: string }[];
}

const GROUPS: HotkeyGroup[] = [
  {
    title: 'Global',
    entries: [
      { keys: 'Ctrl P / ⌘ P', description: 'Find file by name' },
      { keys: 'Ctrl ⇧ F / ⌘ ⇧ F', description: 'Search file contents' },
      { keys: 'F', description: 'Search file contents (no chord)' },
      // Digit rows derived from the rail order, like useGlobalKeys.
      ...VIEWS.map((view, index) => ({
        keys: String(index + 1),
        description: `${view.label} view`,
      })),
      { keys: 'a', description: 'Toggle auto mode (jump to the newest change)' },
      { keys: 's', description: 'Toggle diff syntax highlighting' },
      { keys: 'd', description: 'Toggle split / unified diff' },
      { keys: 'f', description: 'Toggle follow mode' },
      { keys: '/', description: 'Filter the changed-file list' },
      { keys: 'e', description: 'Expand every large diff (so Ctrl F finds it)' },
      { keys: '?', description: 'This help' },
      { keys: 'Esc', description: 'Close dialog' },
    ],
  },
  {
    title: 'Lists (files, commits)',
    entries: [
      { keys: '↑ ↓', description: 'Move selection' },
      { keys: 'Enter / Space', description: 'Select entry' },
      { keys: 'Tab', description: 'Next focus target' },
    ],
  },
  {
    title: 'Explorer tree',
    entries: [
      { keys: '→', description: 'Expand directory / step in' },
      { keys: '←', description: 'Collapse directory / go to parent' },
      { keys: 'Home / End', description: 'First / last row' },
    ],
  },
  {
    title: 'Find file',
    entries: [
      { keys: '↑ ↓ / Ctrl j k', description: 'Move selection' },
      { keys: 'Tab / Shift Tab', description: 'Cycle results' },
      { keys: 'Enter', description: 'Reveal in Explorer' },
    ],
  },
  {
    title: 'Search file contents',
    entries: [
      { keys: '↑ ↓ / Ctrl j k', description: 'Move selection' },
      { keys: 'Enter', description: 'Open the file at that line' },
      { keys: 'Esc', description: 'Close' },
    ],
  },
  {
    title: 'Filter (/)',
    entries: [
      { keys: '/', description: 'Open, or return the caret to it' },
      { keys: 'Esc', description: 'Clear and close' },
    ],
  },
];
</script>

<template>
  <div class="overlay-scrim" data-testid="hotkeys-overlay" @click.self="ui.closeOverlay()">
    <div
      ref="dialogEl"
      class="overlay-dialog hotkeys"
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
      tabindex="-1"
    >
      <header class="hotkeys-header">
        <h2 class="hotkeys-title">Keyboard shortcuts</h2>
        <button
          class="hotkeys-close"
          data-autofocus
          data-testid="hotkeys-close"
          aria-label="Close"
          @click="ui.closeOverlay()"
        >
          ×
        </button>
      </header>

      <div class="hotkeys-groups">
        <section v-for="group in GROUPS" :key="group.title" class="hotkeys-group">
          <h3 class="group-title eyebrow">{{ group.title }}</h3>
          <dl class="group-entries">
            <template v-for="entry in group.entries" :key="entry.keys">
              <dt><kbd class="mono">{{ entry.keys }}</kbd></dt>
              <dd>{{ entry.description }}</dd>
            </template>
          </dl>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.hotkeys {
  width: min(46rem, calc(100vw - 2rem));
  max-height: min(36rem, calc(100vh - 4rem));
  display: flex;
  flex-direction: column;
}

.hotkeys-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--border);
}

.hotkeys-title {
  margin: 0;
  font-size: var(--fs-title);
  font-weight: 600;
}

.hotkeys-close {
  padding: 0 0.375rem;
  font-size: var(--fs-title);
  line-height: 1;
  color: var(--text-dim);
  border-radius: 4px;
}

.hotkeys-close:hover {
  color: var(--text);
}

.hotkeys-groups {
  overflow-y: auto;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
  gap: 0.75rem 2rem;
  padding: 1rem;
}

.group-title {
  margin: 0 0 0.375rem;
  font-weight: 500;
}

.group-entries {
  margin: 0;
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0.25rem 0.875rem;
  align-items: baseline;
}

.group-entries dt {
  justify-self: start;
}

.group-entries dd {
  margin: 0;
  font-size: var(--fs-base);
  color: var(--text);
}

kbd {
  display: inline-block;
  padding: 0 0.375rem;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: var(--surface-raised);
  font-size: var(--fs-small);
  color: var(--text-dim);
  white-space: nowrap;
}
</style>
