<script setup lang="ts">
/**
 * Repo switcher in the header: a button naming the active repo/project,
 * opening a popover that holds the RepoPicker — one input that filters
 * every repo the daemon knows about and opens a typed path, over one list
 * (open, recent, and discovered behind a control).
 *
 * The panel is the shell only. Everything inside it is RepoPicker, which
 * the empty state mounts too, so the two cannot drift apart. Esc or an
 * outside click closes.
 */

import { computed } from 'vue';
import { useDaemonStore } from '../stores/daemon';
import { useActiveWorktrees } from '../composables/useActiveWorktrees';
import { basename } from '../utils/format';
import RepoPicker from './RepoPicker.vue';
import { useDismissable } from '../composables/useDismissable';

const daemon = useDaemonStore();
const { hasMultiple, projectName } = useActiveWorktrees();

// `open` and `rootEl` must keep these exact names: Vue matches ref="rootEl"
// in the template against the setup variable name.
const { open, rootEl } = useDismissable();

const activeRepo = computed(
  () => daemon.repos.find((repo) => repo.id === daemon.activeRepoId) ?? null
);

/**
 * The trigger label: the PROJECT name when the active repo is one of
 * several worktrees (the worktree switcher beside it names the worktree),
 * otherwise the repo's own directory name. Keeps the worktree/branch name
 * from appearing twice across the picker and the switcher.
 */
const triggerLabel = computed(() => {
  if (!activeRepo.value) return 'no repo';
  return hasMultiple.value ? projectName.value : basename(activeRepo.value.path);
});
</script>

<template>
  <div ref="rootEl" class="repo-switcher">
    <button
      class="switch-btn chrome-chip"
      aria-haspopup="true"
      :aria-expanded="open"
      :title="activeRepo ? activeRepo.path : undefined"
      @click="open = !open"
    >
      <span class="repo-label mono">{{ triggerLabel }}</span>
      <span class="caret popover-caret" aria-hidden="true">&#9662;</span>
    </button>

    <!-- v-if, not v-show: mounting is what resets the picker's query,
         selection and expand state, and what re-runs its discovery scan. -->
    <div v-if="open" class="panel popover-panel">
      <RepoPicker @opened="open = false" />
    </div>
  </div>
</template>

<style scoped>
.repo-switcher {
  position: relative;
}

.switch-btn {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.25rem 0.625rem;
  min-width: 0;
}

.switch-btn:hover {
  border-color: var(--text-dim);
}

/* A long repo name (e.g. a branch-named worktree dir) must ellipsize on
   ONE line, not wrap at its hyphens into a tall stack. Full name on hover
   (the button's title). */
.repo-label {
  font-size: var(--fs-base);
  font-weight: 600;
  max-width: 16rem;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.panel {
  /* Shared box in style.css (.popover-panel); only the size differs. The
     height cap belongs to the picker's list, not here — the empty state
     mounts the same picker without this panel. */
  width: 24rem;
  padding: 0.75rem;
}
</style>
