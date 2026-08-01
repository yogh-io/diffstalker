<script setup lang="ts">
/**
 * Worktree switcher: a dropdown of the active repo's worktrees, shown
 * beside the repo picker when the repo is one of several worktrees of the
 * same project. Each row is labeled with how many commits it's ahead of
 * its base branch and how long ago it was edited (a native <select> can't
 * do a two-line row, so this mirrors RepoSwitcher's custom button+panel
 * instead). Picking one activates it (opens it by path — the daemon
 * refcounts, so re-picking the current one is a no-op).
 *
 * Split into RECENT and STALE (sectioned like RepoSwitcher's panel),
 * because a long-lived project accumulates worktrees without bound — 34
 * on one real repo — and an unbroken 34-row list is unusable however
 * well it's sorted. Everything touched in the last week is Recent and
 * always shown; the rest is Stale, collapsed to a few rows behind an
 * "N more" reveal. Sorted most-recently-active first within each.
 *
 * Worktrees are named by their DIRECTORY, in the trigger and the rows
 * alike (see worktreeName); the branch checked out there is a separate
 * line, shown only when it differs.
 *
 * The PROJECT name is shown by the repo picker (RepoSwitcher) when
 * worktrees exist, so the closed trigger shows only the worktree's own
 * name (no meta) — the name appears once, not twice, and the collapsed
 * button doesn't get cluttered with a stale-looking timestamp. Data comes
 * from the daemon store via useActiveWorktrees (one fetch, shared with the
 * picker).
 */

import { computed, ref, watch } from 'vue';
import { beginUserNav } from '../composables/useUrlSync';
import { useRepoOpen } from '../composables/useRepoOpen';
import { useWorktreeStore } from '../stores/worktrees';
import { useActiveWorktrees } from '../composables/useActiveWorktrees';
import { basename } from '../utils/format';
import { formatRelativeTime } from '@diffstalker/core/view/formatDate';
import type { WorktreeInfo } from '@diffstalker/client';
import { useDismissable } from '../composables/useDismissable';

const { openByPath } = useRepoOpen();
const { activePath, worktrees, hasMultiple } = useActiveWorktrees();
const worktreeStore = useWorktreeStore();

// `open` and `rootEl` must keep these exact names: Vue matches ref="rootEl"
// in the template against the setup variable name.
const { open, rootEl } = useDismissable();


/** The active worktree's own path — the SAME value the list is keyed by,
 * so the trigger and the rows can never describe different repos. */
const currentPath = computed(() => activePath.value ?? '');

// Re-read on every opening: "edited N ago" and commits-ahead go stale
// while the panel sits closed, and this is the moment they are read.
watch(open, (isOpen) => {
  if (isOpen && activePath.value !== null) void worktreeStore.refresh([activePath.value]);
});

/** Past this much silence a worktree is "stale" and gets collapsed away. */
const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
/** How many stale worktrees to show before the "N more" reveal. */
const STALE_PREVIEW = 3;

const staleExpanded = ref(false);

// Each opening starts collapsed again: the reveal is for "I need that one
// old branch right now", not a preference worth remembering.
watch(open, (isOpen) => {
  if (!isOpen) staleExpanded.value = false;
});

/** Most recently active first — that's usually the one being switched to.
 * Unknown activity sorts last (it is also what makes a worktree stale).
 * The store already sorts this way; this is just the readable alias. */
const sortedWorktrees = computed(() => worktrees.value);

/** Touched within the last week. A worktree whose activity could not be
 * read counts as stale — unknown is not evidence of recent work. */
const recentWorktrees = computed(() => {
  const cutoff = Date.now() - STALE_AFTER_MS;
  return sortedWorktrees.value.filter((w) => w.lastActivity !== null && w.lastActivity >= cutoff);
});

const staleWorktrees = computed(() => {
  const cutoff = Date.now() - STALE_AFTER_MS;
  return sortedWorktrees.value.filter((w) => w.lastActivity === null || w.lastActivity < cutoff);
});

/**
 * The stale rows actually rendered: the first few, plus the active
 * worktree whenever it is stale but would fall outside that window —
 * being unable to see which worktree you are on is worse than one extra
 * row.
 */
const visibleStale = computed(() => {
  if (staleExpanded.value) return staleWorktrees.value;
  const shown = staleWorktrees.value.slice(0, STALE_PREVIEW);
  const active = staleWorktrees.value.find((w) => w.path === currentPath.value);
  if (active && !shown.includes(active)) shown.push(active);
  return shown;
});

const hiddenStaleCount = computed(() => staleWorktrees.value.length - visibleStale.value.length);

/** Label the sections only when there are actually two of them; a lone
 * "Recent" heading over every worktree of a two-worktree repo is noise. */
const showSectionLabels = computed(
  () => recentWorktrees.value.length > 0 && staleWorktrees.value.length > 0
);

/**
 * A worktree's name is its DIRECTORY name, always.
 *
 * The switcher picks a place on disk, so it names one — and the trigger
 * has always shown the directory, while the rows used to show the branch
 * (falling back to the directory when detached). Those agree only while
 * every worktree dir is named after its branch; the moment a `main`
 * worktree has a feature branch checked out, the same worktree read as
 * two different names depending on where you looked.
 *
 * What is checked out is the branch indicator's job, and the row repeats
 * it below (worktreeBranch) only when it differs from the directory.
 */
function worktreeName(worktree: WorktreeInfo): string {
  return basename(worktree.path);
}

/**
 * The row's branch line: shown only when it adds something the name does
 * not already say. A worktree dir named after its branch — the common
 * case — would otherwise read the same word twice.
 */
function worktreeBranch(worktree: WorktreeInfo): string | null {
  if (worktree.branch === null) return null;
  return worktree.branch === basename(worktree.path) ? null : worktree.branch;
}

/** The row's second line: "N commits ahead · edited N ago", either half
 * omitted when unknown (no base branch resolved / never committed). */
function worktreeMeta(worktree: WorktreeInfo): string {
  const parts: string[] = [];
  // A detached worktree has no branch line, so it says so here instead.
  if (worktree.branch === null) parts.push('detached');
  if (worktree.aheadOfBase !== null && worktree.aheadOfBase > 0) {
    parts.push(`${worktree.aheadOfBase} commit${worktree.aheadOfBase === 1 ? '' : 's'} ahead`);
  }
  if (worktree.lastActivity !== null) {
    parts.push(formatRelativeTime(worktree.lastActivity));
  }
  return parts.join(' · ');
}

function pick(worktree: WorktreeInfo): void {
  if (worktree.path !== currentPath.value) {
    beginUserNav({ repo: worktree.path });
    void openByPath(worktree.path);
  }
  open.value = false;
}
</script>

<template>
  <div v-if="hasMultiple" ref="rootEl" class="wt-switcher">
    <button
      class="wt-trigger mono chrome-chip"
      data-testid="worktree-select"
      aria-haspopup="true"
      :aria-expanded="open"
      :title="`Switch worktree (currently ${basename(currentPath)})`"
      aria-label="Switch worktree"
      @click="open = !open"
    >
      <span class="wt-name">{{ basename(currentPath) }}</span>
      <span class="caret popover-caret" aria-hidden="true">&#9662;</span>
    </button>

    <div v-if="open" class="panel popover-panel" data-testid="worktree-options">
      <template v-if="recentWorktrees.length">
        <p v-if="showSectionLabels" class="group-label eyebrow">Recent</p>
        <button
          v-for="w in recentWorktrees"
          :key="w.path"
          class="wt-row"
          :class="{ active: w.path === currentPath }"
          :title="w.path"
          @click="pick(w)"
        >
          <span class="name mono">{{ worktreeName(w) }}</span>
          <span v-if="worktreeBranch(w)" class="branch mono">{{ worktreeBranch(w) }}</span>
          <span v-if="worktreeMeta(w)" class="meta mono">{{ worktreeMeta(w) }}</span>
        </button>
      </template>

      <template v-if="staleWorktrees.length">
        <p v-if="showSectionLabels" class="group-label eyebrow">Stale</p>
        <button
          v-for="w in visibleStale"
          :key="w.path"
          class="wt-row"
          :class="{ active: w.path === currentPath }"
          :title="w.path"
          @click="pick(w)"
        >
          <span class="name mono">{{ worktreeName(w) }}</span>
          <span v-if="worktreeBranch(w)" class="branch mono">{{ worktreeBranch(w) }}</span>
          <span v-if="worktreeMeta(w)" class="meta mono">{{ worktreeMeta(w) }}</span>
        </button>
        <button
          v-if="hiddenStaleCount > 0"
          class="more-row mono"
          data-testid="worktree-more"
          @click="staleExpanded = true"
        >
          {{ hiddenStaleCount }} more
        </button>
      </template>
    </div>
  </div>
</template>

<style scoped>
.wt-switcher {
  position: relative;
}

.wt-trigger {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  min-width: 0;
  max-width: 16rem;
  padding: 0.25rem 0.625rem;
  color: var(--text);
  font-size: var(--fs-base);
  font-weight: 600;
}

.wt-trigger:hover {
  border-color: var(--text-dim);
}

.wt-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.panel {
  /* Shared box in style.css (.popover-panel); the rest is this menu's own:
     it is the one that can outgrow the viewport. */
  width: 18rem;
  max-height: 60vh;
  overflow-y: auto;
  padding: 0.375rem;
  gap: 0.125rem;
}

.group-label {
  margin: 0.25rem 0 0.125rem;
  padding: 0 0.5rem;
}

/* Deliberately not a .wt-row: it reveals rows rather than switching to
   one, so it should not look like something you can land on. */
.more-row {
  padding: 0.25rem 0.5rem;
  border-radius: 4px;
  text-align: left;
  font-size: var(--fs-small);
  color: var(--text-dim);
}

.more-row:hover {
  color: var(--text);
  background: var(--surface-raised);
}

.wt-row {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
  padding: 0.375rem 0.5rem;
  border-radius: 4px;
  text-align: left;
}

.wt-row:hover {
  background: var(--surface-raised);
}

.wt-row.active .name {
  color: var(--accent);
}

.name {
  font-size: var(--fs-base);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* The checked-out branch, when the directory name does not already say
   it. Between the name and the dim meta line in weight, since it is a
   fact about the worktree rather than a timestamp. */
.branch {
  font-size: var(--fs-small);
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.meta {
  font-size: var(--fs-small);
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
