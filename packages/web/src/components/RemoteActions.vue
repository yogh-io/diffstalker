<script setup lang="ts">
/**
 * Header remote actions: real fetch / pull / push buttons over the repo
 * store's remote-operation machine (RemoteOperationState, synthesized
 * client-side around each call — no remote SSE channel).
 *
 * The machine renders as ONE compact status slot next to the buttons:
 * - inProgress: the operation label ("pushing…") with a subtle spinner,
 *   all action buttons disabled (the store also guards re-entry);
 * - error: a calm red line — the daemon's 409/500 message is already
 *   actionable ("Push rejected: …", "A push operation is already in
 *   progress") — dismissed by click (clearRemoteState);
 * - lastResult: the op summary in dim ink, dismissable and auto-cleared
 *   after a few seconds so the header returns to rest on its own.
 *
 * Push/pull reflect the branch's ahead/behind counts in diff colors.
 */

import { computed, onBeforeUnmount, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useRepoStore } from '../stores/repo';
import { condenseGitError, REMOTE_OP_LABELS } from '../utils/remoteOps';

/** How long a finished op's summary lingers before it clears itself. */
const RESULT_TTL_MS = 6000;

const repo = useRepoStore();
const { remote, shared } = storeToRefs(repo);

const branch = computed(() => shared.value.status?.branch ?? null);
const ahead = computed(() => branch.value?.ahead ?? 0);
const behind = computed(() => branch.value?.behind ?? 0);

const disabled = computed(() => !repo.isRepo || remote.value.inProgress);

const progressLabel = computed(() => {
  const state = remote.value;
  if (!state.inProgress || state.operation === null) return null;
  return REMOTE_OP_LABELS[state.operation];
});

/** Displayable error: git's multi-line stderr collapses to the meat. */
const errorLine = computed(() =>
  remote.value.error === null ? null : condenseGitError(remote.value.error)
);

const pushTitle = computed(() => {
  const tracking = branch.value?.tracking;
  if (!tracking) return 'Push (sets upstream on first push)';
  return ahead.value > 0
    ? `Push ${ahead.value} commit(s) to ${tracking}`
    : `Push to ${tracking}`;
});

const pullTitle = computed(() => {
  const tracking = branch.value?.tracking;
  if (!tracking) return 'Pull (rebase) from the tracked branch';
  return behind.value > 0
    ? `Pull (rebase) ${behind.value} commit(s) from ${tracking}`
    : `Pull (rebase) from ${tracking}`;
});

// A finished op's summary clears itself; errors stay until dismissed.
let resultTimer: ReturnType<typeof setTimeout> | null = null;

function cancelResultTimer(): void {
  if (resultTimer) {
    clearTimeout(resultTimer);
    resultTimer = null;
  }
}

watch(remote, (state) => {
  cancelResultTimer();
  if (!state.inProgress && state.error === null && state.lastResult !== null) {
    resultTimer = setTimeout(() => {
      resultTimer = null;
      repo.clearRemoteState();
    }, RESULT_TTL_MS);
  }
});

onBeforeUnmount(cancelResultTimer);
</script>

<template>
  <div class="remote-actions" aria-label="Remote operations">
    <span
      v-if="progressLabel"
      class="op-status progress mono"
      data-testid="remote-progress"
      role="status"
    >
      <span class="spinner" aria-hidden="true"></span>{{ progressLabel }}
    </span>
    <button
      v-else-if="errorLine"
      class="op-status error mono"
      data-testid="remote-error"
      :title="`${remote.error} — click to dismiss`"
      @click="repo.clearRemoteState()"
    >
      {{ errorLine }}
    </button>
    <button
      v-else-if="remote.lastResult"
      class="op-status result mono"
      data-testid="remote-result"
      :title="`${remote.lastResult} — click to dismiss`"
      @click="repo.clearRemoteState()"
    >
      {{ remote.lastResult }}
    </button>

    <div class="buttons">
      <button
        class="action mono"
        data-testid="remote-fetch"
        :disabled="disabled"
        title="Fetch from the remote"
        @click="repo.fetchRemote()"
      >
        fetch
      </button>
      <button
        class="action mono"
        data-testid="remote-pull"
        :disabled="disabled"
        :title="pullTitle"
        @click="repo.pull()"
      >
        pull<span v-if="behind > 0" class="count-del">&darr;{{ behind }}</span>
      </button>
      <button
        class="action mono"
        data-testid="remote-push"
        :disabled="disabled"
        :title="pushTitle"
        @click="repo.push()"
      >
        push<span v-if="ahead > 0" class="count-add">&uarr;{{ ahead }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.remote-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
}

.buttons {
  display: flex;
  gap: 0.25rem;
}

.action {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.25rem 0.5rem;
  border: 1px solid var(--border);
  border-radius: 4px;
  font-size: var(--fs-small);
  color: var(--text);
  white-space: nowrap;
}

.action:hover:not(:disabled) {
  border-color: var(--text-dim);
}

.action:disabled {
  color: var(--text-dim);
}

.op-status {
  min-width: 0;
  max-width: 18rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-small);
  text-align: left;
}

.op-status.progress {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  color: var(--warn);
}

.op-status.error {
  color: var(--del);
}

.op-status.result {
  color: var(--text-dim);
}

.spinner {
  flex: none;
  width: 0.625rem;
  height: 0.625rem;
  border: 1.5px solid var(--warn);
  border-top-color: transparent;
  border-radius: 50%;
  animation: remote-spin 700ms linear infinite;
}

@keyframes remote-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
