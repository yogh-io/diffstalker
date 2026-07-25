<script setup lang="ts">
/**
 * Global header: wordmark, repo switcher, branch + tracking + ahead/behind
 * (mono, diff-colored counts — read-only text), one calm error line, the
 * fuzzy finder trigger, theme switcher. No git controls: the web UI is a
 * viewer. The four display toggles (auto / syntax / split / follow) live
 * in the tab band (HeaderToggles, rendered by ActivityRail), NOT here —
 * keeping them off the header saves it a row.
 */

import { computed } from 'vue';
import { useDaemonStore } from '../stores/daemon';
import { useRepoStore } from '../stores/repo';
import { useUiStore } from '../stores/ui';
import RepoSwitcher from './RepoSwitcher.vue';
import WorktreeSwitcher from './WorktreeSwitcher.vue';
import ThemeSwitcher from './ThemeSwitcher.vue';

const daemon = useDaemonStore();
const repo = useRepoStore();
const ui = useUiStore();

const branch = computed(() => repo.shared.status?.branch ?? null);

/**
 * One error line. With a repo active, the repo's error (incl. the calm
 * reconnect line) wins — a stale daemon-scope error must not mask it.
 * daemon.error only shows when no repo is active.
 */
const errorLine = computed(() =>
  daemon.activeRepoId !== null ? repo.shared.error : (daemon.error ?? repo.shared.error)
);
</script>

<template>
  <header class="app-header">
    <div class="header-identity">
      <div class="brand" aria-hidden="true">
        <span class="mark">
          <span class="cell add"></span>
          <span class="cell del"></span>
        </span>
        <span class="brand-name mono">diffstalker</span>
      </div>

      <RepoSwitcher />

      <WorktreeSwitcher />

      <div
        v-if="branch"
        class="branch mono"
        data-testid="branch-info"
        :title="branch.tracking ? `${branch.current} → ${branch.tracking}` : branch.current"
      >
        <span class="branch-name">{{ branch.current }}</span>
        <template v-if="branch.tracking">
          <span class="arrow" aria-hidden="true">&rarr;</span>
          <span class="tracking">{{ branch.tracking }}</span>
        </template>
        <span v-if="branch.ahead > 0" class="count-add">&uarr;{{ branch.ahead }}</span>
        <span v-if="branch.behind > 0" class="count-del">&darr;{{ branch.behind }}</span>
      </div>

      <p v-if="errorLine" class="error-line mono" data-testid="header-error" :title="errorLine">
        {{ errorLine }}
      </p>
    </div>

    <div class="header-pinned">
      <button
        class="finder-btn"
        data-testid="finder-open"
        :disabled="daemon.activeRepoId === null"
        :title="
          daemon.activeRepoId === null
            ? 'Open a repository to find files'
            : 'Find a file in the active repository'
        "
        @click="ui.openOverlay('finder')"
      >
        Find file <kbd class="mono">Ctrl P</kbd>
      </button>

      <ThemeSwitcher />
    </div>
  </header>
</template>

<style scoped>
/* Two columns: identity (left, shrinks/ellipsizes) | pinned find-file +
   theme (right). The display toggles moved to the tab band, so the header
   no longer needs a reflow row for them. */
.app-header {
  grid-area: header;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  grid-template-areas: 'identity pinned';
  align-items: center;
  column-gap: 1rem;
  padding: 0.75rem 1rem;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
}

.header-identity,
.header-pinned {
  display: flex;
  align-items: center;
  min-width: 0;
}

.header-identity {
  grid-area: identity;
  gap: 1rem;
}

.header-pinned {
  grid-area: pinned;
  gap: 1rem;
  justify-self: end;
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

.finder-btn {
  padding: 0.25rem 0.5rem;
  border: 1px solid var(--border);
  border-radius: 4px;
  font-size: var(--fs-small);
  color: var(--text-dim);
  background: transparent;
}

.finder-btn:hover:not(:disabled) {
  color: var(--text);
  border-color: var(--text-dim);
}

.finder-btn kbd {
  font-size: var(--fs-micro);
  padding: 0 0.25rem;
  border: 1px solid var(--border);
  border-radius: 3px;
}
</style>
