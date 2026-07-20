<script setup lang="ts">
/**
 * Global header: wordmark, repo switcher, branch + tracking + ahead/behind
 * (mono, diff-colored counts), one calm error line, follow indicator,
 * stubbed remote-op / finder controls (wired in later slices), theme
 * switcher.
 */

import { computed } from 'vue';
import { useDaemonStore } from '../stores/daemon';
import { useRepoStore } from '../stores/repo';
import RepoSwitcher from './RepoSwitcher.vue';
import ThemeSwitcher from './ThemeSwitcher.vue';

const daemon = useDaemonStore();
const repo = useRepoStore();

const branch = computed(() => repo.shared.status?.branch ?? null);

/**
 * One error line. With a repo active, the repo's error (incl. the calm
 * reconnect line) wins — a stale daemon-scope error must not mask it.
 * daemon.error only shows when no repo is active.
 */
const errorLine = computed(() =>
  daemon.activeRepoId !== null ? repo.shared.error : (daemon.error ?? repo.shared.error)
);

/**
 * Real, loaded daemon-side follow state only. The web does not
 * auto-switch on follow-change yet (that lands in a later slice), so the
 * indicator only reports what the daemon does.
 */
const followOn = computed(() => daemon.follow?.enabled ?? false);
</script>

<template>
  <header class="app-header">
    <div class="brand" aria-hidden="true">
      <span class="mark">
        <span class="cell add"></span>
        <span class="cell del"></span>
      </span>
      <span class="brand-name mono">diffstalker</span>
    </div>

    <RepoSwitcher />

    <div v-if="branch" class="branch mono" data-testid="branch-info">
      <span class="branch-name">{{ branch.current }}</span>
      <template v-if="branch.tracking">
        <span class="arrow" aria-hidden="true">&rarr;</span>
        <span class="tracking">{{ branch.tracking }}</span>
      </template>
      <span v-if="branch.ahead > 0" class="count-add">&uarr;{{ branch.ahead }}</span>
      <span v-if="branch.behind > 0" class="count-del">&darr;{{ branch.behind }}</span>
    </div>

    <p v-if="errorLine" class="error-line mono" data-testid="header-error">{{ errorLine }}</p>

    <div class="spacer"></div>

    <span v-if="followOn" class="follow mono" title="Follow mode is enabled on the daemon; the web UI does not auto-switch repos yet">
      <span class="dot"></span>follow
    </span>

    <div class="stub-actions" aria-label="Remote operations (land in a later slice)">
      <button disabled title="Lands in a later slice">fetch</button>
      <button disabled title="Lands in a later slice">pull</button>
      <button disabled title="Lands in a later slice">push</button>
    </div>

    <button class="finder-stub" disabled title="Lands in a later slice">
      Find file <kbd class="mono">Ctrl P</kbd>
    </button>

    <ThemeSwitcher />
  </header>
</template>

<style scoped>
.app-header {
  grid-area: header;
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 0 1rem;
  height: 3rem;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
}

.brand {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

/* The identity mark: a two-cell diff gutter — one add, one del. */
.mark {
  display: inline-flex;
  flex-direction: column;
  gap: 2px;
}

.cell {
  width: 0.875rem;
  height: 0.3125rem;
  border-radius: 1px;
}

.cell.add {
  background: var(--add);
}

.cell.del {
  background: var(--del);
  width: 0.625rem;
}

.brand-name {
  font-size: var(--fs-content);
  font-weight: 700;
  letter-spacing: -0.02em;
}

.branch {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  font-size: var(--fs-base);
  /* Clamp inside the header row: never force horizontal page scroll. */
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.branch-name {
  font-weight: 600;
  white-space: nowrap;
}

.arrow,
.tracking {
  color: var(--text-dim);
  white-space: nowrap;
}

.error-line {
  margin: 0;
  font-size: var(--fs-small);
  color: var(--warn);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.spacer {
  flex: 1;
}

.follow {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  font-size: var(--fs-small);
  color: var(--text-dim);
}

.follow .dot {
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 50%;
  background: var(--add);
}

.stub-actions {
  display: flex;
  gap: 0.25rem;
}

.stub-actions button,
.finder-stub {
  padding: 0.25rem 0.5rem;
  border: 1px solid var(--border);
  border-radius: 4px;
  font-size: var(--fs-small);
  color: var(--text-dim);
  background: transparent;
}

.finder-stub kbd {
  font-size: var(--fs-micro);
  padding: 0 0.25rem;
  border: 1px solid var(--border);
  border-radius: 3px;
}

@media (max-width: 56rem) {
  .stub-actions,
  .finder-stub,
  .follow {
    display: none;
  }
}
</style>
