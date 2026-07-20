<script setup lang="ts">
/**
 * Empty state: no repository is active. Prompts for an absolute path
 * (the browser can't browse the daemon's filesystem) and offers the
 * recent repos from localStorage.
 */

import { useUiStore } from '../stores/ui';
import { useRepoOpen } from '../composables/useRepoOpen';
import { basename } from '../utils/format';
import RepoOpenForm from './RepoOpenForm.vue';

const ui = useUiStore();
const { openByPath } = useRepoOpen();
</script>

<template>
  <div class="empty-state" data-testid="empty-state">
    <div class="card">
      <span class="mark" aria-hidden="true">
        <span class="cell add"></span>
        <span class="cell del"></span>
        <span class="cell ctx"></span>
      </span>
      <h1>Open a repository</h1>
      <p class="copy">
        diffstalker follows a repository on the daemon's machine. Enter the absolute path of a git
        repository to start watching it.
      </p>
      <RepoOpenForm />

      <div v-if="ui.recentRepos.length" class="recents" data-testid="empty-recents">
        <p class="recents-label">Recent</p>
        <button
          v-for="path in ui.recentRepos"
          :key="path"
          class="recent-row"
          @click="openByPath(path)"
        >
          <span class="name mono">{{ basename(path) }}</span>
          <span class="path mono">{{ path }}</span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.empty-state {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2rem 1rem;
}

.card {
  width: 30rem;
  max-width: 100%;
}

/* Three gutter cells: add, del, context — the app's subject in 24px. */
.mark {
  display: flex;
  flex-direction: column;
  gap: 3px;
  margin-bottom: 1rem;
}

.cell {
  height: 0.375rem;
  border-radius: 1px;
}

.cell.add {
  width: 1.75rem;
  background: var(--add);
}

.cell.del {
  width: 1.25rem;
  background: var(--del);
}

.cell.ctx {
  width: 2.25rem;
  background: var(--border);
}

h1 {
  margin: 0 0 0.5rem;
  font-size: var(--fs-display);
  font-weight: 650;
  letter-spacing: -0.01em;
}

.copy {
  margin: 0 0 1.25rem;
  font-size: var(--fs-content);
  color: var(--text-dim);
}

.recents {
  margin-top: 1.5rem;
}

.recents-label {
  margin: 0 0 0.375rem;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--text-dim);
}

.recent-row {
  display: flex;
  align-items: baseline;
  gap: 0.625rem;
  /* The row bleeds 0.5rem into both side margins; widen it by the same
     1rem so the bleed is even instead of lopsided. */
  width: calc(100% + 1rem);
  padding: 0.375rem 0.5rem;
  margin: 0 -0.5rem;
  border-radius: 4px;
  text-align: left;
}

.recent-row:hover {
  background: var(--surface);
}

.name {
  font-size: var(--fs-base);
  font-weight: 600;
}

.path {
  font-size: var(--fs-micro);
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
