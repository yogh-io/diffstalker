<script setup lang="ts">
/**
 * SearchModes: the strip at the top of every search overlay, naming the
 * three search gestures and the key each one answers to.
 *
 * **It exists to be read, not to be needed.** The app has three search-type
 * keys and only the finder had a visible way in (the header button), so the
 * other two were reachable only by already knowing them. Printing all three
 * on the one surface you do open means the keys get learned by using the
 * app rather than by remembering to open the help sheet first.
 *
 * Every mode is also clickable, so the keys are never load-bearing.
 *
 * **Not a palette.** There is no prefix, no mode token in the query, and
 * nothing here parses input — each mode keeps its own corpus, its own
 * debounce and its own cost. The strip only switches which one is open,
 * which is exactly what the keys already did.
 *
 * Outline is the odd one and stays that way: it is a z20 popover beside
 * the code, not a modal, so choosing it closes the overlay and asks the
 * Explorer for it. It is never disabled — the popover owns the "No file
 * open." story, and a listed gesture that silently does nothing is worse
 * than one that explains itself.
 */

import { nextTick } from 'vue';
import { useUiStore } from '../stores/ui';
import { beginUserNav } from '../composables/useUrlSync';

/** Which corpus the overlay rendering this strip is searching. */
const props = defineProps<{ current: 'files' | 'contents' }>();

const ui = useUiStore();

function showFiles(): void {
  if (props.current === 'files') return;
  ui.openOverlay('finder');
}

function showContents(): void {
  if (props.current === 'contents') return;
  ui.openOverlay('search');
}

/**
 * The request is deferred one tick, and that is not optional: the Explorer
 * is what listens for it, and coming from another view it has not mounted
 * yet. Asking before it exists loses the request silently — you land in
 * the Explorer with no popover and no clue why.
 */
async function showOutline(): Promise<void> {
  ui.closeOverlay();
  beginUserNav({ view: 'explorer' });
  ui.setActiveView('explorer');
  await nextTick();
  ui.requestOutline();
}
</script>

<template>
  <div class="search-modes mono" data-testid="search-modes">
    <button
      type="button"
      class="mode"
      data-testid="mode-files"
      :class="{ current: current === 'files' }"
      :aria-current="current === 'files' ? 'true' : undefined"
      title="Find a file by name"
      @click="showFiles"
    >
      Files <kbd>Ctrl P</kbd>
    </button>
    <button
      type="button"
      class="mode"
      data-testid="mode-contents"
      :class="{ current: current === 'contents' }"
      :aria-current="current === 'contents' ? 'true' : undefined"
      title="Search the text inside files"
      @click="showContents"
    >
      Contents <kbd>⇧ F</kbd>
    </button>
    <button
      type="button"
      class="mode"
      data-testid="mode-outline"
      title="The symbols in the file open in Explorer"
      @click="void showOutline()"
    >
      Outline <kbd>o</kbd>
    </button>
  </div>
</template>

<style scoped>
.search-modes {
  display: flex;
  gap: 0.25rem;
  padding: 0.375rem 0.75rem;
  border-bottom: 1px solid var(--border);
}

.mode {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.25rem 0.5rem;
  border: 1px solid transparent;
  border-radius: 4px;
  background: transparent;
  color: var(--text-dim);
  font-family: inherit;
  font-size: var(--fs-small);
  cursor: pointer;
}

.mode:hover {
  color: var(--text);
  border-color: var(--text-dim);
}

/* The mode you are in is marked, not merely tinted: the strip is read as
   a list of what exists, and this says which of them you got. */
.mode.current {
  background: var(--row-selected-bg);
  border-color: var(--selection);
  color: var(--text);
}

.mode kbd {
  padding: 0 0.25rem;
  border: 1px solid var(--border);
  border-radius: 3px;
  font-family: inherit;
  font-size: var(--fs-micro);
}
</style>
