<script setup lang="ts">
/**
 * Open-a-repo-by-path form, shared by the repo switcher and the empty
 * state. The browser can't browse the daemon's filesystem, so the path
 * must be absolute on the machine the daemon runs on. A refused path
 * (not a repo, no such directory) surfaces the daemon's reason inline —
 * repoStore owns the open, so the reason sits in repo.shared.error while
 * the store is in not-a-repo mode.
 */

import { computed, ref, useId } from 'vue';
import { useDaemonStore } from '../stores/daemon';
import { useRepoStore } from '../stores/repo';
import { useRepoOpen } from '../composables/useRepoOpen';

const emit = defineEmits<{ opened: [] }>();

const daemon = useDaemonStore();
const repo = useRepoStore();
const { openByPath } = useRepoOpen();

/** Only a refused open (not-a-repo mode), never a live repo's error. */
const openError = computed(() => (repo.isRepo ? null : repo.shared.error));

/**
 * Prefill with the active repo's path (the working dir we're viewing), so
 * the field is a ready-to-edit starting point — tweak it to open a sibling
 * repo or worktree — not an empty box. Empty (with the placeholder) only in
 * the no-repo-open empty state. Set once at mount; the form is re-created
 * each time the switcher panel opens, so it re-seeds from the active repo.
 */
const activePath = daemon.activeRepoPath ?? '';
const path = ref(activePath);
const busy = ref(false);
const inputId = useId();

async function submit(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  const ok = await openByPath(path.value);
  busy.value = false;
  if (ok) {
    path.value = '';
    emit('opened');
  }
}
</script>

<template>
  <form class="repo-open-form" @submit.prevent="submit">
    <label class="visually-hidden" :for="inputId">Repository path on the daemon's machine</label>
    <div class="row">
      <input
        :id="inputId"
        v-model="path"
        class="mono"
        type="text"
        placeholder="/absolute/path/to/repo"
        spellcheck="false"
        autocomplete="off"
      />
      <button type="submit" class="open-btn chrome-chip" :disabled="busy || !path.trim()">Open</button>
    </div>
    <p v-if="openError" class="form-error mono">{{ openError }}</p>
  </form>
</template>

<style scoped>
.repo-open-form {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}

.row {
  display: flex;
  gap: 0.5rem;
}

input {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-base);
}

.open-btn {
  padding: 0.375rem 0.875rem;
  white-space: nowrap;
}

.open-btn:hover:not(:disabled) {
  border-color: var(--accent);
}

.open-btn:disabled {
  color: var(--text-dim);
}

.form-error {
  margin: 0;
  font-size: var(--fs-small);
  color: var(--del);
}
</style>
