<script setup lang="ts">
/**
 * Compare view — scaffold. "Load compare" pulls the diff against the
 * detected base branch; the base + stats readout proves the wiring. The
 * GitHub-style PR view replaces this in a later slice.
 */

import { useRepoStore } from '../stores/repo';

const repo = useRepoStore();
</script>

<template>
  <section class="view">
    <p class="view-eyebrow">compare</p>
    <h2 class="view-title">Against base</h2>
    <p class="view-hint">Scaffold readout — the PR-style view lands in a later slice.</p>

    <button class="view-action" :disabled="repo.compare.loading" @click="repo.refreshCompare()">
      {{ repo.compare.loading ? 'Loading…' : 'Load compare' }}
    </button>

    <p v-if="repo.compare.error" class="view-error">{{ repo.compare.error }}</p>
    <p v-else-if="repo.compare.noBaseBranch" class="view-empty">
      No remote base branch to compare against. Base detection uses remote refs only.
    </p>

    <div v-if="repo.compare.compareDiff" class="readout mono" data-testid="compare-stats">
      <p class="base">
        base <span class="branch">{{ repo.compare.compareDiff.baseBranch }}</span>
      </p>
      <p class="stats">
        {{ repo.compare.compareDiff.stats.filesChanged }} files
        <span class="count-add">+{{ repo.compare.compareDiff.stats.additions }}</span>
        <span class="count-del">&minus;{{ repo.compare.compareDiff.stats.deletions }}</span>
        <span class="commits">{{ repo.compare.compareDiff.commits.length }} commits</span>
      </p>
    </div>
  </section>
</template>

<style scoped>
.readout {
  margin-top: 1rem;
  font-size: var(--fs-base);
}

.readout p {
  margin: 0 0 0.375rem;
}

.base {
  color: var(--text-dim);
}

.branch {
  color: var(--text);
  font-weight: 600;
}

.stats {
  display: flex;
  gap: 0.625rem;
}

.commits {
  color: var(--text-dim);
}
</style>
