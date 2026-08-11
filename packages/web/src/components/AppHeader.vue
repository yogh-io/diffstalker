<script setup lang="ts">
/**
 * Global header: wordmark, repo switcher, branch + tracking + ahead/behind
 * (mono, diff-colored counts — read-only text), one calm error line, the
 * search trigger, settings. No git controls: the web UI is a viewer.
 * The theme picker lives in the settings panel only — it is a set-once
 * choice, and a select sitting in the chrome forever costs more room than
 * it earns. The four display toggles (auto / syntax / split / follow) live
 * in the tab band (HeaderToggles, rendered by ActivityRail), NOT here —
 * keeping them off the header saves it a row.
 */

import { computed } from 'vue';
import { useDaemonStore } from '../stores/daemon';
import { useRepoStore } from '../stores/repo';
import { useUiStore } from '../stores/ui';
import { useActiveWorktrees } from '../composables/useActiveWorktrees';
import { basename } from '../utils/format';
import RepoSwitcher from './RepoSwitcher.vue';
import WorktreeSwitcher from './WorktreeSwitcher.vue';

const daemon = useDaemonStore();
const repo = useRepoStore();
const ui = useUiStore();
const { hasMultiple } = useActiveWorktrees();

const branch = computed(() => repo.shared.status?.branch ?? null);

/**
 * What the worktree select's trigger actually displays: the active
 * worktree's DIRECTORY name.
 *
 * This used to be computed as `branch ?? dir`, which is what the select's
 * ROWS showed — not its trigger. When a worktree's directory and branch
 * differ (a `main` worktree with a feature branch checked out) the
 * breadcrumb then suppressed the branch name believing the select already
 * displayed it, and the current branch appeared nowhere in plain text.
 */
const activeWorktreeLabel = computed<string | null>(() => {
  const activePath = daemon.activeRepoPath;
  return activePath === null ? null : basename(activePath);
});

/**
 * Show the branch name in the breadcrumb UNLESS the worktree select is up
 * and already shows that exact name — then it would be a duplicate, so
 * drop it and let the breadcrumb read "→ <upstream>". Only drop it when
 * there IS an upstream to show, so the breadcrumb is never empty.
 */
const showBranchName = computed(
  () =>
    !(
      hasMultiple.value &&
      branch.value?.tracking != null &&
      branch.value.current === activeWorktreeLabel.value
    )
);

/**
 * The upstream, shortened to just the remote when it is the same branch
 * name there (`aer-4569-x` → `origin/aer-4569-x` reads as "→ origin").
 * A DIFFERENT upstream branch is spelled out in full — that is the case
 * worth reading. The title carries the full ref either way.
 */
const trackingLabel = computed(() => {
  const current = branch.value?.current;
  const tracking = branch.value?.tracking;
  if (!tracking || !current) return tracking ?? '';
  const suffix = `/${current}`;
  return tracking.endsWith(suffix) ? tracking.slice(0, -suffix.length) : tracking;
});

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
        <span v-if="showBranchName" class="branch-name">{{ branch.current }}</span>
        <template v-if="branch.tracking">
          <span class="arrow" aria-hidden="true">&rarr;</span>
          <span class="tracking" :title="branch.tracking">{{ trackingLabel }}</span>
        </template>
        <span v-if="branch.ahead > 0" class="count-add">&uarr;{{ branch.ahead }}</span>
        <span v-if="branch.behind > 0" class="count-del">&darr;{{ branch.behind }}</span>
      </div>

      <p v-if="errorLine" class="error-line mono" data-testid="header-error" :title="errorLine">
        {{ errorLine }}
      </p>
    </div>

    <div class="header-pinned">
      <!-- The one visible way into search, and now the way into all three
           corpora: the overlay it opens names files / contents / outline
           and the key each answers to (SearchModes.vue). Labelled for the
           gesture, not for one of its modes. -->
      <button
        class="finder-btn"
        data-testid="finder-open"
        :disabled="daemon.activeRepoId === null"
        :title="
          daemon.activeRepoId === null
            ? 'Open a repository to search it'
            : 'Search this repository: file names, contents, or the open file’s outline'
        "
        @click="ui.openOverlay('finder')"
      >
        Search <kbd class="mono">Ctrl P</kbd>
      </button>

      <button
        class="settings-btn"
        data-testid="settings-open"
        title="Settings (,)"
        aria-label="Settings"
        @click="ui.toggleOverlay('settings')"
      >
        <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
          <circle cx="8" cy="8" r="2.25" />
          <path
            d="M8 1.5v1.75M8 12.75v1.75M1.5 8h1.75M12.75 8h1.75M3.4 3.4l1.24 1.24M11.36 11.36l1.24 1.24M12.6 3.4l-1.24 1.24M4.64 11.36 3.4 12.6"
          />
        </svg>
      </button>
    </div>
  </header>
</template>

<style scoped>
/* Two columns: identity (left, shrinks/ellipsizes) | pinned find-file +
   settings (right). The display toggles moved to the tab band, so the header
   no longer needs a reflow row for them. */
.app-header {
  grid-area: header;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  grid-template-areas: 'identity pinned';
  align-items: center;
  column-gap: 1rem;
  padding: 0.75rem var(--gutter);
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

/* The truncation lives on the TEXT items below, not here: text-overflow
   does nothing on a flex container, so a long branch name used to paint
   straight over the arrow and the ahead/behind counts. */
.branch {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  font-size: var(--fs-base);
  /* Clamp inside the header row: never force horizontal page scroll. */
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
}

/* min-width: 0 is the load-bearing part — a flex item's automatic minimum
   size is what forces the overflow instead of letting it shrink. */
.branch-name {
  font-weight: 600;
  white-space: nowrap;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.arrow,
.tracking {
  color: var(--text-dim);
  white-space: nowrap;
}

/* One glyph, never squeezed. */
.arrow {
  flex: none;
}

.tracking {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
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

.settings-btn {
  display: flex;
  align-items: center;
  padding: 0.25rem;
  border-radius: 4px;
  color: var(--text-dim);
}

.settings-btn:hover {
  color: var(--text);
}

.settings-btn svg {
  fill: none;
  stroke: currentColor;
  stroke-width: 1.25;
  stroke-linecap: round;
}
</style>
