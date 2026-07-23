<script setup lang="ts">
/**
 * Global header: wordmark, repo switcher, branch + tracking + ahead/behind
 * (mono, diff-colored counts — read-only text), one calm error line, the
 * auto-mode toggle, the diff syntax-highlighting toggle, the diff
 * unified/split toggle, the follow toggle, the fuzzy finder trigger,
 * theme switcher. No git controls: the web UI is a viewer.
 *
 * Auto: flips the client-side auto-mode policy (useAutoMode acts on
 * state changes only while it is on) — pure viewing: auto-select the
 * newest-changed file, auto-switch Changes/History. Persisted in prefs.
 *
 * Follow: the daemon owns the watcher; the button flips the CLIENT-side
 * followEnabled policy toggle (useFollowMode acts on follow-change only
 * while it is on — same split as the CLI's FollowMode). Honest states:
 * "no follow target" when the daemon runs without a hook file (the
 * toggle would do nothing — disabled), "follow off" when the client
 * toggle is off, "following <target>" when on (the followed worktree,
 * from daemon.follow, once the first hit lands).
 */

import { computed } from 'vue';
import { useDaemonStore } from '../stores/daemon';
import { useRepoStore } from '../stores/repo';
import { useUiStore } from '../stores/ui';
import RepoSwitcher from './RepoSwitcher.vue';
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

/** Daemon-side: is there a hook file to follow at all? */
const hasFollowTarget = computed(() => (daemon.follow?.targetFile ?? null) !== null);

/** The followed worktree root, once the first hook hit landed. */
const followedPath = computed(() => daemon.follow?.followedPath ?? null);

const followActive = computed(() => hasFollowTarget.value && daemon.followEnabled);

const followLabel = computed(() => {
  if (!hasFollowTarget.value) return 'no follow target';
  if (!daemon.followEnabled) return 'follow off';
  const target = followedPath.value;
  return target !== null ? `following ${target.split('/').pop()}` : 'follow on';
});

const followTitle = computed(() => {
  if (!hasFollowTarget.value) {
    return 'The daemon is not watching a follow hook file (started with --no-follow)';
  }
  const target = followedPath.value !== null ? `Following ${followedPath.value}. ` : '';
  return daemon.followEnabled
    ? `${target}Click to stop switching repos on follow changes`
    : `${target}Click to switch repos when the follow hook changes`;
});

const autoTitle = computed(() =>
  ui.autoModeEnabled
    ? 'Auto mode is on: the newest change is selected and flashed, and the view follows changes appearing or drying up. Click to turn off (a)'
    : 'Turn on auto mode: auto-select the newest-changed file and auto-switch Changes/History (a)'
);

const syntaxTitle = computed(() =>
  ui.diffSyntaxEnabled
    ? 'Syntax highlighting is on for every diff. Click to show plain text'
    : 'Turn on syntax highlighting for every diff'
);

const splitOn = computed(() => ui.diffMode === 'split');
const modeTitle = computed(() =>
  splitOn.value
    ? 'Diffs are side by side (old | new). Click for the unified view'
    : 'Show diffs side by side (old | new) instead of unified'
);
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

    <div class="spacer"></div>

    <button
      class="mode-toggle mono"
      data-testid="auto-toggle"
      :class="{ on: ui.autoModeEnabled }"
      :aria-pressed="ui.autoModeEnabled"
      :title="autoTitle"
      @click="ui.toggleAutoMode()"
    >
      <span class="dot" aria-hidden="true"></span>{{ ui.autoModeEnabled ? 'auto on' : 'auto off' }}
    </button>

    <button
      class="mode-toggle mono"
      data-testid="syntax-toggle"
      :class="{ on: ui.diffSyntaxEnabled }"
      :aria-pressed="ui.diffSyntaxEnabled"
      :title="syntaxTitle"
      @click="ui.toggleDiffSyntax()"
    >
      <span class="dot" aria-hidden="true"></span>{{ ui.diffSyntaxEnabled ? 'syntax on' : 'syntax off' }}
    </button>

    <button
      class="mode-toggle mono"
      data-testid="split-toggle"
      :class="{ on: splitOn }"
      :aria-pressed="splitOn"
      :title="modeTitle"
      @click="ui.toggleDiffMode()"
    >
      <span class="dot" aria-hidden="true"></span>{{ splitOn ? 'split' : 'unified' }}
    </button>

    <button
      v-if="daemon.follow"
      class="mode-toggle mono"
      data-testid="follow-toggle"
      :class="{ on: followActive }"
      :disabled="!hasFollowTarget"
      :aria-pressed="followActive"
      :title="followTitle"
      @click="daemon.toggleFollow()"
    >
      <span class="dot" aria-hidden="true"></span>{{ followLabel }}
    </button>

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

/* Shared style for the auto and follow policy toggles. */
.mode-toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.25rem 0.5rem;
  border: 1px solid var(--border);
  border-radius: 4px;
  font-size: var(--fs-small);
  color: var(--text-dim);
  white-space: nowrap;
}

.mode-toggle:hover:not(:disabled) {
  border-color: var(--text-dim);
}

.mode-toggle .dot {
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 50%;
  background: var(--text-dim);
}

.mode-toggle.on {
  color: var(--text);
}

.mode-toggle.on .dot {
  background: var(--add);
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

/* Landscape-only: a portrait monitor is narrow by shape, not by space —
   it keeps the full header (finder + follow). */
@media (max-width: 56rem) and (orientation: landscape) {
  .finder-btn,
  .mode-toggle {
    display: none;
  }
}
</style>
