<script setup lang="ts">
/**
 * Repo switcher in the header: a button showing the active repo, opening
 * a panel that lists the daemon's open repos, the localStorage recents
 * that aren't open, and the open-by-path form. Esc or an outside click
 * closes the panel.
 */

import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useDaemonStore } from '../stores/daemon';
import { useUiStore } from '../stores/ui';
import { useRepoOpen } from '../composables/useRepoOpen';
import { basename } from '../utils/format';
import RepoOpenForm from './RepoOpenForm.vue';
import type { RepoSummary } from '@diffstalker/client';

const daemon = useDaemonStore();
const ui = useUiStore();
const { openByPath, activate } = useRepoOpen();

const open = ref(false);
const rootEl = ref<HTMLElement | null>(null);

const activeRepo = computed(
  () => daemon.repos.find((repo) => repo.id === daemon.activeRepoId) ?? null
);

const recentsNotOpen = computed(() =>
  ui.recentRepos.filter((path) => !daemon.repos.some((repo) => repo.path === path))
);

function pick(repo: RepoSummary): void {
  void activate(repo);
  open.value = false;
}

async function pickRecent(path: string): Promise<void> {
  const ok = await openByPath(path);
  if (ok) open.value = false;
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
  <div ref="rootEl" class="repo-switcher">
    <button
      class="switch-btn"
      aria-haspopup="true"
      :aria-expanded="open"
      :title="activeRepo ? activeRepo.path : undefined"
      @click="open = !open"
    >
      <span class="repo-label mono">{{ activeRepo ? basename(activeRepo.path) : 'no repo' }}</span>
      <span class="caret" aria-hidden="true">&#9662;</span>
    </button>

    <div v-if="open" class="panel">
      <RepoOpenForm @opened="open = false" />

      <div v-if="daemon.repos.length" class="group" data-testid="open-repos">
        <p class="group-label">Open on daemon</p>
        <button
          v-for="repo in daemon.repos"
          :key="repo.id"
          class="repo-row"
          :class="{ active: repo.id === daemon.activeRepoId }"
          @click="pick(repo)"
        >
          <span class="name mono" :title="basename(repo.path)">{{ basename(repo.path) }}</span>
          <span v-if="repo.branch" class="branch mono" :title="repo.branch">{{ repo.branch }}</span>
          <span class="path mono" :title="repo.path">{{ repo.path }}</span>
        </button>
      </div>

      <div v-if="recentsNotOpen.length" class="group" data-testid="recent-repos">
        <p class="group-label">Recent</p>
        <button
          v-for="path in recentsNotOpen"
          :key="path"
          class="repo-row"
          @click="pickRecent(path)"
        >
          <span class="name mono" :title="basename(path)">{{ basename(path) }}</span>
          <span class="path mono" :title="path">{{ path }}</span>
        </button>
      </div>
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
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--surface-raised);
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

.caret {
  color: var(--text-dim);
  font-size: var(--fs-micro);
}

.panel {
  position: absolute;
  top: calc(100% + 0.375rem);
  left: 0;
  z-index: 20;
  width: 24rem;
  max-width: 80vw;
  padding: 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: 0 8px 24px rgb(0 0 0 / 0.35);
}

.group {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
}

.group-label {
  margin: 0 0 0.25rem;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--text-dim);
}

.repo-row {
  display: grid;
  /* minmax(0, 1fr), NOT 1fr: a bare 1fr floors at the name's min-content,
     so a long hyphenated name wraps hyphen-by-hyphen into a tall column
     while the branch keeps its width. Flooring at 0 lets the name shrink
     and ellipsize on one line instead. */
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 0 0.5rem;
  padding: 0.375rem 0.5rem;
  border-radius: 4px;
  text-align: left;
}

.repo-row:hover {
  background: var(--surface-raised);
}

.repo-row.active .name {
  color: var(--accent);
}

.name {
  font-size: var(--fs-base);
  font-weight: 600;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.branch {
  font-size: var(--fs-small);
  color: var(--text-dim);
  justify-self: end;
  /* Cap the branch so a long branch name can't starve the name column;
     it ellipsizes too (full value on hover). */
  max-width: 12rem;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.path {
  grid-column: 1 / -1;
  font-size: var(--fs-micro);
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
