<script setup lang="ts">
/**
 * ViewFileButton: "view file" — the jump from a diff header to the file
 * itself in the Explorer. Self-contained like WrapToggle: it reads the
 * stores directly, so every diff header (DiffStack's per-file header in
 * Changes/Compare, DiffView's file sections in History, the journal's
 * entry header) drops it in with just a path.
 *
 * The path is repo-relative — the same shape revealFile takes from the
 * fuzzy finder and follow mode. Reveal walks the tree, expanding
 * ancestors, and opens the file; a path the working tree no longer has
 * (an old commit's file in History) lands in the explorer's own error
 * line, like any other failed reveal.
 */

import { useUiStore } from '../stores/ui';
import { useExplorerStore } from '../stores/explorer';

const props = defineProps<{ path: string }>();

const ui = useUiStore();
const explorer = useExplorerStore();

function open(): void {
  ui.setActiveView('explorer');
  // The store action never rejects — failures land in explorer.error.
  void explorer.revealFile(props.path);
}
</script>

<template>
  <button
    class="view-file mono"
    data-testid="view-file"
    :title="`Open ${props.path} in the Explorer`"
    @click.stop="open()"
  >
    view file
  </button>
</template>

<style scoped>
/* Low-key by default (a per-file affordance repeated down a long stack
   must not compete with the path it follows), lit on hover. Zero block
   padding and a transparent border on purpose: the button then measures
   shorter than the header's own line box, so dropping it into a header
   cannot change that header's height — which DiffStack's exact-height
   model measures once and assumes constant. */
.view-file {
  flex: none;
  padding: 0 0.375rem;
  border: 1px solid transparent;
  border-radius: 3px;
  background: transparent;
  color: var(--text-dim);
  font-size: var(--fs-micro);
  cursor: pointer;
}

.view-file:hover {
  color: var(--text);
  border-color: var(--border);
  background: var(--surface-raised);
}
</style>
