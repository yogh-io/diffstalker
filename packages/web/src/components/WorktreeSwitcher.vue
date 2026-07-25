<script setup lang="ts">
/**
 * Worktree switcher: a dropdown of the active repo's worktrees, shown
 * beside the repo picker when the repo is one of several worktrees of the
 * same project. Picking one activates it (opens it by path — the daemon
 * refcounts, so re-picking the current one is a no-op).
 *
 * The PROJECT name is shown by the repo picker (RepoSwitcher) when
 * worktrees exist, so this carries only the worktree select — the name
 * appears once, not twice. Data comes from the daemon store via
 * useActiveWorktrees (one fetch, shared with the picker).
 */

import { computed } from 'vue';
import { useDaemonStore } from '../stores/daemon';
import { useRepoOpen } from '../composables/useRepoOpen';
import { useActiveWorktrees } from '../composables/useActiveWorktrees';
import { basename } from '../utils/format';
import type { WorktreeInfo } from '@diffstalker/client';

const daemon = useDaemonStore();
const { openByPath } = useRepoOpen();
const { worktrees, hasMultiple } = useActiveWorktrees();

const currentPath = computed(
  () => daemon.repos.find((r) => r.id === daemon.activeRepoId)?.path ?? ''
);

/** A worktree's label: its branch, or its directory name when detached. */
function worktreeLabel(worktree: WorktreeInfo): string {
  return worktree.branch ?? basename(worktree.path);
}

function onSelect(event: Event): void {
  const path = (event.target as HTMLSelectElement).value;
  if (path && path !== currentPath.value) void openByPath(path);
}
</script>

<template>
  <select
    v-if="hasMultiple"
    class="wt-select mono"
    data-testid="worktree-select"
    :value="currentPath"
    :title="`Switch worktree (currently ${basename(currentPath)})`"
    aria-label="Switch worktree"
    @change="onSelect"
  >
    <option v-for="w in worktrees" :key="w.path" :value="w.path" :title="w.path">
      {{ worktreeLabel(w) }}
    </option>
  </select>
</template>

<style scoped>
.wt-select {
  min-width: 0;
  max-width: 16rem;
  padding: 0.25rem 0.5rem;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--surface-raised);
  color: var(--text);
  font-size: var(--fs-base);
  font-weight: 600;
}

.wt-select:hover {
  border-color: var(--text-dim);
}
</style>
