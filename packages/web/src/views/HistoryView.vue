<script setup lang="ts">
/**
 * History view — scaffold. "Load history" pulls the commit list on
 * demand (repoStore.loadHistory); the count and plain hash+subject rows
 * prove the wiring. The three-column commit browser replaces this in a
 * later slice.
 */

import { ref } from 'vue';
import { useRepoStore } from '../stores/repo';

const repo = useRepoStore();
const loadError = ref<string | null>(null);

async function load(): Promise<void> {
  loadError.value = null;
  try {
    await repo.loadHistory();
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : String(err);
  }
}
</script>

<template>
  <section class="view">
    <p class="view-eyebrow">history</p>
    <h2 class="view-title">Commits</h2>
    <p class="view-hint">Scaffold readout — the commit browser lands in a later slice.</p>

    <button class="view-action" :disabled="repo.history.isLoading" @click="load">
      {{ repo.history.isLoading ? 'Loading…' : 'Load history' }}
    </button>

    <p v-if="loadError" class="view-error">{{ loadError }}</p>

    <template v-if="repo.history.commits.length">
      <p class="count mono" data-testid="history-count">
        {{ repo.history.commits.length }} commits loaded
      </p>
      <ul class="commit-list mono">
        <li v-for="commit in repo.history.commits" :key="commit.hash">
          <span class="hash">{{ commit.shortHash }}</span>
          <span class="subject">{{ commit.message }}</span>
        </li>
      </ul>
    </template>
  </section>
</template>

<style scoped>
.count {
  margin: 1rem 0 0.5rem;
  font-size: var(--fs-small);
  color: var(--text-dim);
}

.commit-list {
  list-style: none;
  margin: 0;
  padding: 0;
  font-size: var(--fs-base);
}

.commit-list li {
  display: flex;
  gap: 0.75rem;
  padding: 0.1875rem 0;
}

.hash {
  color: var(--warn);
  flex-shrink: 0;
}

.subject {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
