<script setup lang="ts">
/**
 * Worktree switcher: a dropdown of the active repo's worktrees, shown
 * beside the repo picker when the repo is one of several worktrees of the
 * same project. Sorted most-recently-active first; each row is labeled
 * with how many commits it's ahead of its base branch and how long ago it
 * was edited (a native <select> can't do a two-line row, so this mirrors
 * RepoSwitcher's custom button+panel instead). Picking one activates it
 * (opens it by path — the daemon refcounts, so re-picking the current one
 * is a no-op).
 *
 * The PROJECT name is shown by the repo picker (RepoSwitcher) when
 * worktrees exist, so the closed trigger shows only the worktree's own
 * name (no meta) — the name appears once, not twice, and the collapsed
 * button doesn't get cluttered with a stale-looking timestamp. Data comes
 * from the daemon store via useActiveWorktrees (one fetch, shared with the
 * picker).
 */

import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useDaemonStore } from '../stores/daemon';
import { useRepoOpen } from '../composables/useRepoOpen';
import { useActiveWorktrees } from '../composables/useActiveWorktrees';
import { basename } from '../utils/format';
import { formatRelativeTime } from '@diffstalker/core/view/formatDate';
import type { WorktreeInfo } from '@diffstalker/client';

const daemon = useDaemonStore();
const { openByPath } = useRepoOpen();
const { worktrees, hasMultiple } = useActiveWorktrees();

const open = ref(false);
const rootEl = ref<HTMLElement | null>(null);

const currentPath = computed(
  () => daemon.repos.find((r) => r.id === daemon.activeRepoId)?.path ?? ''
);

/** Most recently active first — that's usually the one being switched to. */
const sortedWorktrees = computed(() =>
  [...worktrees.value].sort((a, b) => (b.lastActivity ?? -Infinity) - (a.lastActivity ?? -Infinity))
);

/** A worktree's name: its branch, or its directory name when detached. */
function worktreeName(worktree: WorktreeInfo): string {
  return worktree.branch ?? basename(worktree.path);
}

/** The row's second line: "N commits ahead · edited N ago", either half
 * omitted when unknown (no base branch resolved / never committed). */
function worktreeMeta(worktree: WorktreeInfo): string {
  const parts: string[] = [];
  if (worktree.aheadOfBase !== null && worktree.aheadOfBase > 0) {
    parts.push(`${worktree.aheadOfBase} commit${worktree.aheadOfBase === 1 ? '' : 's'} ahead`);
  }
  if (worktree.lastActivity !== null) {
    parts.push(formatRelativeTime(worktree.lastActivity));
  }
  return parts.join(' · ');
}

function pick(worktree: WorktreeInfo): void {
  if (worktree.path !== currentPath.value) void openByPath(worktree.path);
  open.value = false;
}

function onDocumentPointerDown(event: MouseEvent): void {
  if (open.value && rootEl.value && !rootEl.value.contains(event.target as Node)) {
    open.value = false;
  }
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && open.value) open.value = false;
}

onMounted(() => {
  document.addEventListener('mousedown', onDocumentPointerDown);
  document.addEventListener('keydown', onKeydown);
});

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocumentPointerDown);
  document.removeEventListener('keydown', onKeydown);
});
</script>

<template>
  <div v-if="hasMultiple" ref="rootEl" class="wt-switcher">
    <button
      class="wt-trigger mono"
      data-testid="worktree-select"
      aria-haspopup="true"
      :aria-expanded="open"
      :title="`Switch worktree (currently ${basename(currentPath)})`"
      aria-label="Switch worktree"
      @click="open = !open"
    >
      <span class="wt-name">{{ basename(currentPath) }}</span>
      <span class="caret" aria-hidden="true">&#9662;</span>
    </button>

    <div v-if="open" class="panel" data-testid="worktree-options">
      <button
        v-for="w in sortedWorktrees"
        :key="w.path"
        class="wt-row"
        :class="{ active: w.path === currentPath }"
        :title="w.path"
        @click="pick(w)"
      >
        <span class="name mono">{{ worktreeName(w) }}</span>
        <span v-if="worktreeMeta(w)" class="meta mono">{{ worktreeMeta(w) }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.wt-switcher {
  position: relative;
}

.wt-trigger {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  min-width: 0;
  max-width: 16rem;
  padding: 0.25rem 0.625rem;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--surface-raised);
  color: var(--text);
  font-size: var(--fs-base);
  font-weight: 600;
}

.wt-trigger:hover {
  border-color: var(--text-dim);
}

.wt-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.caret {
  color: var(--text-dim);
  font-size: var(--fs-micro);
}

.panel {
  position: absolute;
  top: calc(100% + 0.375rem);
  left: 0;
  z-index: 20;
  width: 18rem;
  max-width: 80vw;
  max-height: 60vh;
  overflow-y: auto;
  padding: 0.375rem;
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: 0 8px 24px rgb(0 0 0 / 0.35);
}

.wt-row {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
  padding: 0.375rem 0.5rem;
  border-radius: 4px;
  text-align: left;
}

.wt-row:hover {
  background: var(--surface-raised);
}

.wt-row.active .name {
  color: var(--accent);
}

.name {
  font-size: var(--fs-base);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.meta {
  font-size: var(--fs-small);
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
