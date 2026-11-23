<script setup lang="ts">
/**
 * The PR draft of one branch, edited from the Work page. The draft routes
 * need the repo open in the daemon, so this opens it (without making it
 * the active repo), edits through its own draft session, and on close
 * sends what is left to save before it lets the repo go.
 */

import { onMounted, onUnmounted, shallowRef } from 'vue';
import PrDraftPanel from './PrDraftPanel.vue';
import { DiffstalkerClient } from '../api/client';
import { errorMessage } from '../api/errors';
import { logFailure } from '../stores/failureLog';
import { createDraftSession } from '../composables/draftSession';
import type { DraftSession } from '../composables/draftSession';

const props = defineProps<{ path: string; branch: string }>();

const client = new DiffstalkerClient();
const repoId = shallowRef<string | null>(null);
const error = shallowRef<string | null>(null);
const session: DraftSession = createDraftSession(() =>
  repoId.value === null ? null : { id: repoId.value, branch: props.branch }
);
let closed = false;

onMounted(async () => {
  try {
    const ref = await client.openRepo(props.path);
    if (closed) {
      await client.closeRepo(ref.id);
      return;
    }
    repoId.value = ref.id;
  } catch (err) {
    logFailure('open a repo for its PR draft', err, { path: props.path });
    error.value = `Could not open the repo: ${errorMessage(err)}`;
  }
});

onUnmounted(() => {
  closed = true;
  const id = repoId.value;
  void (async () => {
    await session.dispose();
    if (id === null) return;
    try {
      await client.closeRepo(id);
    } catch (err) {
      logFailure('release a repo after its PR draft', err, { path: props.path });
    }
  })();
});
</script>

<template>
  <p v-if="error" class="view-error" data-testid="work-draft-error">{{ error }}</p>
  <PrDraftPanel v-else-if="repoId" :session="session" />
  <p v-else class="loading">Opening the draft…</p>
</template>

<style scoped>
.loading {
  margin: 0;
  font-size: var(--fs-small);
  color: var(--text-dim);
}
</style>
