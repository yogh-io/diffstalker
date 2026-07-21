<script setup lang="ts">
/**
 * OperationBanner: the unmissable-but-calm strip below the header when
 * the repo is stopped mid-operation (shared.operationInProgress:
 * rebase / cherry-pick / revert / merge — a conflicted pull, cherry-pick,
 * revert, or merge left git waiting).
 *
 * Recovery mirrors the daemon's semantics (routes/remote.ts):
 * - Abort is always offered (POST /abort works for any wedged op);
 * - Continue is rebase-only (POST /rebase-continue 409s otherwise) —
 *   a conflicted cherry-pick/revert/merge continues by resolving and
 *   committing, which the Changes view already does; the hint says so.
 *
 * The banner renders nothing when the repo is clean; it clears on its
 * own when the wire state updates (abort/continue/commit resolved it).
 * While the abort/continue call runs, its progress label replaces the
 * buttons so a second click can't race the first.
 */

import { computed } from 'vue';
import { storeToRefs } from 'pinia';
import { useRepoStore } from '../stores/repo';
import { IN_PROGRESS_LABELS, REMOTE_OP_LABELS } from '../utils/remoteOps';

const repo = useRepoStore();
const { remote, shared } = storeToRefs(repo);

const operation = computed(() => shared.value.operationInProgress);

const label = computed(() =>
  operation.value === null ? null : IN_PROGRESS_LABELS[operation.value]
);

const hint = computed(() =>
  operation.value === 'rebase'
    ? 'Resolve the conflicts, then continue — or abort to restore the previous state.'
    : 'Resolve the conflicts and commit to finish — or abort to restore the previous state.'
);

/** The in-flight recovery call, if any ("aborting…" / "continuing rebase…"). */
const recoveryProgress = computed(() => {
  const state = remote.value;
  if (!state.inProgress || state.operation === null) return null;
  if (state.operation !== 'abort' && state.operation !== 'rebaseContinue') return null;
  return REMOTE_OP_LABELS[state.operation];
});

const busy = computed(() => remote.value.inProgress);
</script>

<template>
  <div
    v-if="operation"
    class="op-banner"
    role="status"
    aria-live="polite"
    data-testid="operation-banner"
  >
    <span class="badge mono">{{ label }} in progress</span>
    <span class="hint">{{ hint }}</span>
    <span class="spacer"></span>
    <span v-if="recoveryProgress" class="progress mono" data-testid="banner-progress">
      {{ recoveryProgress }}
    </span>
    <template v-else>
      <button
        v-if="operation === 'rebase'"
        class="banner-btn mono"
        data-testid="banner-continue"
        :disabled="busy"
        title="git rebase --continue"
        @click="repo.rebaseContinue()"
      >
        continue
      </button>
      <button
        class="banner-btn danger mono"
        data-testid="banner-abort"
        :disabled="busy"
        :title="`Abort the ${label} and restore the previous state`"
        @click="repo.abort()"
      >
        abort
      </button>
    </template>
  </div>
</template>

<style scoped>
.op-banner {
  grid-area: banner;
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.375rem 1rem;
  background: var(--surface);
  border-bottom: 1px solid var(--warn);
  border-left: 3px solid var(--warn);
  font-size: var(--fs-small);
}

.badge {
  flex: none;
  color: var(--warn);
  font-weight: 600;
}

.hint {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-dim);
}

.spacer {
  flex: 1;
}

.progress {
  color: var(--warn);
}

.banner-btn {
  flex: none;
  padding: 0.1875rem 0.625rem;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--surface-raised);
  font-size: var(--fs-small);
}

.banner-btn:hover:not(:disabled) {
  border-color: var(--text-dim);
}

.banner-btn.danger {
  color: var(--del);
}

.banner-btn.danger:hover:not(:disabled) {
  border-color: var(--del);
}
</style>
