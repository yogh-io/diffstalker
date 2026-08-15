<script setup lang="ts">
/**
 * ShowChangesButton: "show changes" — the jump from a file in the
 * Explorer to that file's diff in Changes. The exact mirror of
 * ViewFileButton, pointed the other way, and self-contained the same way:
 * it reads the stores directly and takes only a path.
 *
 * It exists because the Explorer is a SINK. Every deliberate cross-view
 * jump in this app points AT it — view-file from three diff headers, the
 * fuzzy finder, search, follow mode — and until now nothing pointed out.
 * A reader who opened a file to read it whole and then wanted to know
 * what they had changed in it had to leave by the activity rail and find
 * the file again.
 *
 * It renders NO diff, holds NO ref, and reads no diff data. It is a
 * setActiveView plus a selection — which is what keeps the Explorer free
 * of diff rendering (docs/whole-file-mode.md §4).
 *
 * It renders only when the path is actually in the working-tree status,
 * so it is never a dead control: no probe request, no daemon roundtrip,
 * and no dependence on whether any other view happens to be warm.
 */

import { computed } from 'vue';
import { beginUserNav } from '../composables/useUrlSync';
import { useRepoStore, workingDiffKey } from '../stores/repo';
import { useUiStore } from '../stores/ui';

const props = defineProps<{ path: string }>();

const repo = useRepoStore();
const ui = useUiStore();

/**
 * The row to aim at. A partially staged file has TWO rows; pick the
 * unstaged one, because its new side is the working-tree bytes the
 * Explorer was just showing.
 */
const target = computed(() => {
  const files = repo.shared.status?.files ?? [];
  const mine = files.filter((f) => f.path === props.path);
  if (mine.length === 0) return null;
  return mine.find((f) => !f.staged) ?? mine[0];
});

function open(): void {
  const file = target.value;
  if (!file) return;
  const key = workingDiffKey(file);
  // One gesture: the view change and the selection it implies land in the
  // same history entry.
  beginUserNav({ view: 'changes' });
  ui.setActiveView('changes');
  // The full selection path, not just the stack key: setting the key
  // alone leaves repo.selection pointing at whatever was picked last,
  // which is what the media pulls and the post-status refresh read.
  repo.selectFile(file);
  ui.setActiveStackKey(key);
  ui.requestStackScroll(key);
}
</script>

<template>
  <button
    v-if="target"
    class="show-changes mono"
    data-testid="show-changes"
    :title="`Show what changed in ${props.path}`"
    @click.stop="open()"
  >
    show changes
  </button>
</template>

<style scoped>
/* Same contract as ViewFileButton, which this mirrors: low-key until
   hovered, zero block padding and a transparent border so it can never
   make its header taller than the header's own line box. */
.show-changes {
  flex: none;
  padding: 0 0.375rem;
  border: 1px solid transparent;
  border-radius: 3px;
  background: transparent;
  color: var(--text-dim);
  font-size: var(--fs-micro);
  cursor: pointer;
  white-space: nowrap;
}

.show-changes:hover {
  color: var(--text);
  border-color: var(--border);
  background: var(--surface-raised);
}
</style>
