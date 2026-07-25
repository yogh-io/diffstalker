<script setup lang="ts">
/**
 * Worktree switcher: when the active repo is one of several worktrees of
 * the same project, show the project name + a dropdown of its worktrees,
 * beside the repo picker. Picking one activates that worktree (opens it by
 * path — the daemon refcounts, so re-picking the current one is a no-op).
 *
 * The daemon already knows this: GET /repos/:id/worktrees returns every
 * worktree of the repo's git dir. We hide entirely for a plain
 * single-worktree repo (nothing to switch), and skip the bare entry (it
 * has no working tree to open).
 *
 * The repo picker stays for switching PROJECTS; this switches WITHIN one.
 */

import { computed, ref, watch } from 'vue';
import { useDaemonStore } from '../stores/daemon';
import { useRepoOpen } from '../composables/useRepoOpen';
import { DiffstalkerClient } from '../api/client';
import { basename } from '../utils/format';
import type { WorktreeInfo } from '@diffstalker/core/git/worktree';

const daemon = useDaemonStore();
const { openByPath } = useRepoOpen();
const client = new DiffstalkerClient();

const worktrees = ref<WorktreeInfo[]>([]);

const activeRepo = computed(() => daemon.repos.find((r) => r.id === daemon.activeRepoId) ?? null);

/** Re-pull the worktree list whenever the active repo changes. */
watch(
  () => daemon.activeRepoId,
  async (id) => {
    worktrees.value = [];
    if (id === null) return;
    try {
      const list = await client.worktrees(id);
      // Drop a stale response if the active repo changed while we waited.
      if (daemon.activeRepoId === id) worktrees.value = list.filter((w) => !w.isBare);
    } catch {
      worktrees.value = [];
    }
  },
  { immediate: true }
);

/** Only meaningful when there is more than one worktree to switch between. */
const hasMultiple = computed(() => worktrees.value.length > 1);

/**
 * The project name: the basename of the deepest directory that contains
 * every worktree (e.g. /home/u/gitRepos/calculator/<branch> -> calculator).
 * Falls back to the active repo's own name when they share no parent.
 */
const projectName = computed(() => {
  const common = commonParentDir(worktrees.value.map((w) => w.path));
  if (common && common !== '/') return basename(common);
  return activeRepo.value ? basename(activeRepo.value.path) : '';
});

const currentPath = computed(() => activeRepo.value?.path ?? '');

/** A worktree's label: its branch, or its directory name when detached. */
function worktreeLabel(worktree: WorktreeInfo): string {
  return worktree.branch ?? basename(worktree.path);
}

function onSelect(event: Event): void {
  const path = (event.target as HTMLSelectElement).value;
  if (path && path !== currentPath.value) void openByPath(path);
}

/** Drop trailing slashes without a regex (avoids a ReDoS lint flag). */
function stripTrailingSlashes(p: string): string {
  let end = p.length;
  while (end > 1 && p[end - 1] === '/') end--;
  return p.slice(0, end);
}

/** Longest common directory prefix of the given absolute paths. */
function commonParentDir(paths: string[]): string {
  if (paths.length === 0) return '';
  const segments = paths.map((p) => stripTrailingSlashes(p).split('/'));
  const [first] = segments;
  let i = 0;
  while (i < first.length && segments.every((s) => s[i] === first[i])) i++;
  return first.slice(0, i).join('/');
}
</script>

<template>
  <div v-if="hasMultiple" class="worktree-switcher">
    <span class="project mono" :title="`Project: ${projectName}`">{{ projectName }}</span>
    <span class="sep" aria-hidden="true">/</span>
    <select
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
  </div>
</template>

<style scoped>
.worktree-switcher {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  min-width: 0;
  font-size: var(--fs-base);
}

.project {
  /* Don't let the flex row squeeze the project name to an ellipsis; it's
     short and it's the whole point ("calculator"). The select shrinks
     instead. Cap only a pathologically long project name. */
  flex: 0 0 auto;
  color: var(--text-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 14rem;
}

.sep {
  color: var(--text-dim);
}

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
