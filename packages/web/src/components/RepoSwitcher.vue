<script setup lang="ts">
/**
 * Repo switcher in the header: a button showing the active repo/project,
 * opening a panel that lists the daemon's open repos GROUPED BY PROJECT
 * (all worktrees of one repo collapse to a single row — e.g. "calculator"
 * — the worktree switcher beside the button picks the worktree), the
 * localStorage recents that aren't open, and the open-by-path form. Esc or
 * an outside click closes the panel.
 */

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useDaemonStore } from '../stores/daemon';
import { useUiStore } from '../stores/ui';
import { useRepoOpen } from '../composables/useRepoOpen';
import { useActiveWorktrees } from '../composables/useActiveWorktrees';
import { useWorktreeStore, type WorktreeProject } from '../stores/worktrees';
import { basename } from '../utils/format';
import RepoOpenForm from './RepoOpenForm.vue';
import type { RepoSummary } from '@diffstalker/client';

const daemon = useDaemonStore();
const ui = useUiStore();
const { openByPath, activate } = useRepoOpen();
const { hasMultiple, projectName } = useActiveWorktrees();
const worktreeStore = useWorktreeStore();

const open = ref(false);
const rootEl = ref<HTMLElement | null>(null);

const activeRepo = computed(
  () => daemon.repos.find((repo) => repo.id === daemon.activeRepoId) ?? null
);

/**
 * The trigger label: the PROJECT name when the active repo is one of
 * several worktrees (the worktree switcher beside it names the worktree),
 * otherwise the repo's own directory name. Keeps the worktree/branch name
 * from appearing twice across the picker and the switcher.
 */
const triggerLabel = computed(() => {
  if (!activeRepo.value) return 'no repo';
  return hasMultiple.value ? projectName.value : basename(activeRepo.value.path);
});

// --- Grouping, all from the one worktree store ---------------------------

/**
 * Both lists below fold a project's worktrees into ONE row, and both read
 * the same store entries — so a project reads identically in the trigger
 * label, the "Open on daemon" row, the "Recent" row, and the worktree
 * dropdown. Rows are derived from what the store knows RIGHT NOW, so the
 * panel's contents no longer depend on how recently it was opened.
 */

const recentsNotOpen = computed(() =>
  ui.recentRepos.filter((path) => !daemon.repos.some((repo) => repo.path === path))
);

/** Every path the panel needs resolved: the open repos and the recents. */
const neededPaths = computed(() => [
  ...daemon.repos.map((repo) => repo.path),
  ...recentsNotOpen.value,
]);

/**
 * Resolve while the panel is open (and re-resolve as its inputs change).
 * `ensure` skips what is already known and dedups in flight, so this is
 * one request per unknown path no matter how often it fires.
 */
watch([open, neededPaths], ([isOpen]) => {
  if (isOpen) void worktreeStore.ensure(neededPaths.value);
});

interface RepoProject {
  /** Project root: the deepest dir containing all the repo's worktrees. */
  root: string;
  name: string;
  /** The open worktrees of this project (one repo id each). */
  repos: RepoSummary[];
  /** ALL worktrees the project has, not just the open ones — the same
   * count the Recent list shows, so one project reads the same in both. */
  worktreeCount: number;
}

const openProjects = computed<RepoProject[]>(() => {
  const groups = new Map<string, RepoProject>();
  for (const repo of daemon.repos) {
    // Unresolved: the repo stands as its own project (its path, its name).
    // It folds into its family the moment the entry lands.
    const resolved = worktreeStore.projectFor(repo.path);
    const root = resolved?.root ?? repo.path;
    let group = groups.get(root);
    if (!group) {
      group = { root, name: basename(root), repos: [], worktreeCount: 0 };
      groups.set(root, group);
    }
    group.repos.push(repo);
    // Every repo in a group belongs to the same family, so they all report
    // the same count; take whichever resolved (0 while none has yet).
    group.worktreeCount = Math.max(group.worktreeCount, resolved?.worktrees.length ?? 0);
  }
  return [...groups.values()];
});

/**
 * One row per project root, folding every recent path that resolved to the
 * same root and dropping any already shown under "Open on daemon".
 *
 * Which recents render, by entry status:
 *  - unknown / pending: held back. Several worktrees of one project each
 *    resolve to the same row, so drawing them early shows a stray row per
 *    worktree that then vanishes (the "why is my worktree listed as a
 *    repo" bug);
 *  - absent: dropped — the daemon looked and the path is not a worktree
 *    (a removed directory still in prefs);
 *  - failed: rendered by its own path. We could not ask, so the entry is
 *    not evidence the path is bad, and the list must not silently lose it
 *    because the daemon blinked.
 */
const recentProjects = computed<WorktreeProject[]>(() => {
  const openRoots = new Set(openProjects.value.map((p) => p.root));
  const seen = new Map<string, WorktreeProject>();
  for (const path of recentsNotOpen.value) {
    const entry = worktreeStore.entryFor(path);
    if (entry === undefined || entry.status === 'pending' || entry.status === 'absent') continue;
    const project =
      entry.status === 'ready'
        ? entry.project
        : { root: path, name: basename(path), worktrees: [] };
    if (openRoots.has(project.root) || seen.has(project.root)) continue;
    seen.set(project.root, project);
  }
  return [...seen.values()];
});

/** The worktree to open for a project: the most recently active one (the
 * store sorts by activity), or the root itself when nothing resolved. */
function bestWorktreePath(project: WorktreeProject): string {
  return project.worktrees[0]?.path ?? project.root;
}

/** Activate a project: keep the active worktree if it's in this project,
 * else switch to its first open worktree; the header select refines. */
function pickProject(project: RepoProject): void {
  const active = project.repos.find((repo) => repo.id === daemon.activeRepoId);
  void activate(active ?? project.repos[0]);
  open.value = false;
}

async function pickRecentProject(project: WorktreeProject): Promise<void> {
  const ok = await openByPath(bestWorktreePath(project));
  if (ok) open.value = false;
}

function onDocumentPointerDown(event: MouseEvent): void {
  if (open.value && rootEl.value && !rootEl.value.contains(event.target as Node)) {
    open.value = false;
  }
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && open.value) open.value = false;
}

onMounted(() => {
  document.addEventListener('mousedown', onDocumentPointerDown);
  document.addEventListener('keydown', onKeydown);
});

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocumentPointerDown);
  document.removeEventListener('keydown', onKeydown);
});
</script>

<template>
  <div ref="rootEl" class="repo-switcher">
    <button
      class="switch-btn"
      aria-haspopup="true"
      :aria-expanded="open"
      :title="activeRepo ? activeRepo.path : undefined"
      @click="open = !open"
    >
      <span class="repo-label mono">{{ triggerLabel }}</span>
      <span class="caret popover-caret" aria-hidden="true">&#9662;</span>
    </button>

    <div v-if="open" class="panel popover-panel">
      <RepoOpenForm @opened="open = false" />

      <div v-if="openProjects.length" class="group" data-testid="open-repos">
        <p class="group-label">Open on daemon</p>
        <button
          v-for="project in openProjects"
          :key="project.root"
          class="repo-row"
          :class="{ active: project.repos.some((r) => r.id === daemon.activeRepoId) }"
          @click="pickProject(project)"
        >
          <span class="name mono" :title="project.name">{{ project.name }}</span>
          <span
            v-if="project.worktreeCount > 1"
            class="branch mono"
            :title="`${project.worktreeCount} worktrees (${project.repos.length} open on the daemon)`"
            >{{ project.worktreeCount }} worktrees</span
          >
          <span class="path mono" :title="project.root">{{ project.root }}</span>
        </button>
      </div>

      <div v-if="recentProjects.length" class="group" data-testid="recent-repos">
        <p class="group-label">Recent</p>
        <button
          v-for="project in recentProjects"
          :key="project.root"
          class="repo-row"
          @click="pickRecentProject(project)"
        >
          <span class="name mono" :title="project.name">{{ project.name }}</span>
          <span
            v-if="project.worktrees.length > 1"
            class="branch mono"
            :title="`${project.worktrees.length} worktrees`"
            >{{ project.worktrees.length }} worktrees</span
          >
          <span class="path mono" :title="project.root">{{ project.root }}</span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.repo-switcher {
  position: relative;
}

.switch-btn {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.25rem 0.625rem;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--surface-raised);
  min-width: 0;
}

.switch-btn:hover {
  border-color: var(--text-dim);
}

/* A long repo name (e.g. a branch-named worktree dir) must ellipsize on
   ONE line, not wrap at its hyphens into a tall stack. Full name on hover
   (the button's title). */
.repo-label {
  font-size: var(--fs-base);
  font-weight: 600;
  max-width: 16rem;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.panel {
  /* Shared box in style.css (.popover-panel); only the size differs. */
  width: 24rem;
  padding: 0.75rem;
  gap: 0.75rem;
}

.group {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
}

.group-label {
  margin: 0 0 0.25rem;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--text-dim);
}

.repo-row {
  display: grid;
  /* minmax(0, 1fr), NOT 1fr: a bare 1fr floors at the name's min-content,
     so a long hyphenated name wraps hyphen-by-hyphen into a tall column
     while the branch keeps its width. Flooring at 0 lets the name shrink
     and ellipsize on one line instead. */
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 0 0.5rem;
  padding: 0.375rem 0.5rem;
  border-radius: 4px;
  text-align: left;
}

.repo-row:hover {
  background: var(--surface-raised);
}

.repo-row.active .name {
  color: var(--accent);
}

.name {
  font-size: var(--fs-base);
  font-weight: 600;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.branch {
  font-size: var(--fs-small);
  color: var(--text-dim);
  justify-self: end;
  /* Cap the branch so a long branch name can't starve the name column;
     it ellipsizes too (full value on hover). */
  max-width: 12rem;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.path {
  grid-column: 1 / -1;
  font-size: var(--fs-micro);
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
