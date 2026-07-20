<script setup lang="ts">
/**
 * Changes view — scaffold. Plain rows from repoStore.shared.status.files
 * (path + status letter + staged tag + per-file stats), proving the
 * daemon → store → view wiring. The real three-column source-control
 * panel (files / diff / commit) replaces this in a later slice.
 */

import { computed } from 'vue';
import { useRepoStore } from '../stores/repo';
import { statusLetter } from '../utils/format';

const repo = useRepoStore();

const status = computed(() => repo.shared.status);
</script>

<template>
  <section class="view">
    <p class="view-eyebrow">changes</p>
    <h2 class="view-title">Working tree</h2>
    <p class="view-hint">Scaffold readout — staging and diffs land in a later slice.</p>

    <p v-if="repo.shared.isLoading" class="view-empty">Loading status…</p>
    <p v-else-if="!status" class="view-empty">No status yet.</p>
    <p v-else-if="status.files.length === 0" class="view-empty">Working tree clean.</p>
    <ul v-else class="file-list mono" data-testid="file-list">
      <li v-for="file in status.files" :key="`${file.path}:${file.staged ? 's' : 'u'}`">
        <span class="letter" :data-status="file.status">{{ statusLetter(file.status) }}</span>
        <span class="path">{{ file.path }}</span>
        <span v-if="file.staged" class="staged-tag">staged</span>
        <span class="stats">
          <span v-if="file.insertions" class="count-add">+{{ file.insertions }}</span>
          <span v-if="file.deletions" class="count-del">&minus;{{ file.deletions }}</span>
        </span>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.file-list {
  list-style: none;
  margin: 0;
  padding: 0;
  font-size: var(--fs-base);
}

.file-list li {
  display: flex;
  align-items: baseline;
  gap: 0.625rem;
  padding: 0.25rem 0.5rem;
  border-radius: 3px;
}

.file-list li:hover {
  background: var(--surface);
}

.letter {
  width: 1ch;
  font-weight: 700;
}

.letter[data-status='modified'] {
  color: var(--status-modified);
}

.letter[data-status='added'] {
  color: var(--status-added);
}

.letter[data-status='deleted'] {
  color: var(--status-deleted);
}

.letter[data-status='untracked'] {
  color: var(--status-untracked);
}

.letter[data-status='renamed'] {
  color: var(--status-renamed);
}

.letter[data-status='copied'] {
  color: var(--status-copied);
}

.path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.staged-tag {
  font-size: var(--fs-micro);
  color: var(--add);
  border: 1px solid var(--add);
  border-radius: 3px;
  padding: 0 0.25rem;
}

.stats {
  margin-left: auto;
  display: inline-flex;
  gap: 0.375rem;
  font-size: var(--fs-small);
}
</style>
