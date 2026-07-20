<script setup lang="ts">
/**
 * Explorer view — scaffold. The tree + file pane land in a later slice;
 * this just names the repo it will explore.
 */

import { useRepoStore } from '../stores/repo';

const repo = useRepoStore();
</script>

<template>
  <section class="view">
    <p class="view-eyebrow">explorer</p>
    <h2 class="view-title">Repository files</h2>
    <p class="view-hint">The file tree and viewer land in a later slice.</p>

    <p v-if="repo.repoPath" class="view-empty mono">{{ repo.repoPath }}</p>
  </section>
</template>
