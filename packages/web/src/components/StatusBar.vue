<script setup lang="ts">
/**
 * Status bar: daemon connection (diff-colored dot), follow target, and
 * the change count with aggregated +/− — all mono, all live.
 */

import { computed } from 'vue';
import { useDaemonStore } from '../stores/daemon';
import { useRepoStore } from '../stores/repo';

const daemon = useDaemonStore();
const repo = useRepoStore();

const CONNECTION_LABELS = {
  connecting: 'connecting…',
  connected: 'daemon connected',
  disconnected: 'daemon disconnected — retrying',
} as const;

const connectionLabel = computed(() => CONNECTION_LABELS[daemon.connection]);

const followTarget = computed(() => daemon.follow?.followedPath ?? null);

const files = computed(() => repo.shared.status?.files ?? null);

const additions = computed(
  () => files.value?.reduce((sum, file) => sum + (file.insertions ?? 0), 0) ?? 0
);
const deletions = computed(
  () => files.value?.reduce((sum, file) => sum + (file.deletions ?? 0), 0) ?? 0
);
</script>

<template>
  <footer class="status-bar mono">
    <span class="conn" :data-state="daemon.connection" data-testid="connection">
      <span class="dot" aria-hidden="true"></span>{{ connectionLabel }}
    </span>

    <span v-if="followTarget" class="follow-target" data-testid="follow-target">
      follow: {{ followTarget }}
    </span>

    <span class="spacer"></span>

    <span v-if="files" class="changes" data-testid="change-count">
      {{ files.length }} changed
      <span v-if="additions > 0" class="count-add">+{{ additions }}</span>
      <span v-if="deletions > 0" class="count-del">&minus;{{ deletions }}</span>
    </span>
  </footer>
</template>

<style scoped>
.status-bar {
  grid-area: status;
  display: flex;
  align-items: center;
  gap: 1.25rem;
  height: 1.75rem;
  padding: 0 1rem;
  font-size: var(--fs-small);
  color: var(--text-dim);
  background: var(--surface);
  border-top: 1px solid var(--border);
}

.conn {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
}

.dot {
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 50%;
  background: var(--text-dim);
}

.conn[data-state='connected'] .dot {
  background: var(--add);
}

.conn[data-state='disconnected'] .dot {
  background: var(--del);
}

.conn[data-state='connecting'] .dot {
  background: var(--warn);
  animation: pulse 1.2s ease-in-out infinite;
}

@keyframes pulse {
  50% {
    opacity: 0.35;
  }
}

.follow-target {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.spacer {
  flex: 1;
}

.changes {
  display: inline-flex;
  gap: 0.375rem;
  white-space: nowrap;
}
</style>
