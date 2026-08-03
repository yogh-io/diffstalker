<script setup lang="ts">
/**
 * Status bar: daemon connection (diff-colored dot), follow target, the
 * change count with aggregated +/−, and the running version against the
 * latest published on npm — all mono, all live.
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

/**
 * Version indicator. Shown only when the daemon knows its own version;
 * 'outdated' also names the newer version, the rest is just the running
 * one (the title line carries the detail).
 */
const version = computed(() => {
  const state = daemon.version;
  if (!state || state.current === null) return null;

  // The daemon under this tab was restarted on a different version, so this
  // page's code is older than the API it is talking to. That outranks
  // whatever npm says: a stale bundle can start failing on changed routes,
  // and no npm hint helps with that. Never reloads on its own — this is a
  // tool people leave open to keep looking at something.
  if (daemon.daemonUpgraded) {
    return {
      status: 'stale-bundle' as const,
      label: `v${daemon.servedBy} → v${state.current}`,
      title: `the daemon restarted on ${state.current}; reload to match it`,
    };
  }

  const label = `v${state.current}`;
  const titles: Record<typeof state.status, string> = {
    current: `up to date with npm (${state.latest})`,
    outdated: `update available on npm: ${state.latest}`,
    ahead: `ahead of npm (latest published: ${state.latest})`,
    unknown: 'npm version unknown — could not check',
  };

  return {
    status: state.status,
    label: state.status === 'outdated' ? `${label} → ${state.latest}` : label,
    title: titles[state.status],
  };
});
</script>

<template>
  <footer class="status-bar mono">
    <span class="conn" :data-state="daemon.connection" data-testid="connection">
      <span class="dot" aria-hidden="true"></span>{{ connectionLabel }}
    </span>

    <span
      v-if="followTarget"
      class="follow-target"
      data-testid="follow-target"
      :title="followTarget"
    >
      follow: {{ followTarget }}
    </span>

    <span class="spacer"></span>

    <span v-if="files" class="changes" data-testid="change-count">
      {{ files.length }} changed
      <span v-if="additions > 0" class="count-add">+{{ additions }}</span>
      <span v-if="deletions > 0" class="count-del">&minus;{{ deletions }}</span>
    </span>

    <span
      v-if="version"
      class="version"
      :data-state="version.status"
      :title="version.title"
      data-testid="version"
    >
      {{ version.label }}
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
  padding: 0 var(--gutter);
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

.version {
  white-space: nowrap;
  cursor: default;
}

/* Only a stale version earns attention; matching npm stays quiet. A stale
   bundle earns the same, and for a better reason: the page is older than
   the API it is calling. */
.version[data-state='outdated'],
.version[data-state='stale-bundle'] {
  color: var(--warn);
}

.version[data-state='ahead'] {
  color: var(--accent);
}
</style>
