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
import { DiffstalkerClient } from '../api/client';
import { basename, commonParentDir } from '../utils/format';
import RepoOpenForm from './RepoOpenForm.vue';
import type { RepoSummary } from '@diffstalker/client';

const daemon = useDaemonStore();
const ui = useUiStore();
const { openByPath, activate } = useRepoOpen();
const { hasMultiple, projectName } = useActiveWorktrees();
const client = new DiffstalkerClient();

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

// --- Group open repos by project -------------------------------------------

interface RepoProject {
  /** Project root: the deepest dir containing all the repo's worktrees. */
  root: string;
  name: string;
  /** The open worktrees of this project (one repo id each). */
  repos: RepoSummary[];
}

/** repoId -> project root, resolved by pulling each repo's worktrees once. */
const projectRootById = ref(new Map<string, string>());

async function resolveProjects(): Promise<void> {
  for (const repo of daemon.repos) {
    if (projectRootById.value.has(repo.id)) continue;
    let root = repo.path;
    try {
      const paths = (await client.worktrees(repo.id))
        .filter((w) => !w.isBare)
        .map((w) => w.path);
      root = commonParentDir(paths) || repo.path;
    } catch {
      // Keep the repo path as its own project on failure.
    }
    projectRootById.value = new Map(projectRootById.value).set(repo.id, root);
  }
}

// Resolve lazily: only while the panel is open, and again if the open-repo
// set changes while it stays open (only unseen ids are fetched).
watch(
  [open, () => daemon.repos],
  ([isOpen]) => {
    if (isOpen) void resolveProjects();
  },
  { immediate: false }
);

const openProjects = computed<RepoProject[]>(() => {
  const groups = new Map<string, RepoProject>();
  for (const repo of daemon.repos) {
    const root = projectRootById.value.get(repo.id) ?? repo.path;
    let group = groups.get(root);
    if (!group) {
      group = { root, name: basename(root), repos: [] };
      groups.set(root, group);
    }
    group.repos.push(repo);
  }
  return [...groups.values()];
});

const recentsNotOpen = computed(() =>
  ui.recentRepos.filter((path) => !daemon.repos.some((repo) => repo.path === path))
);

/** Activate a project: keep the active worktree if it's in this project,
 * else switch to its first open worktree; the header select refines. */
function pickProject(project: RepoProject): void {
  const active = project.repos.find((repo) => repo.id === daemon.activeRepoId);
  void activate(active ?? project.repos[0]);
  open.value = false;
}

async function pickRecent(path: string): Promise<void> {
  const ok = await openByPath(path);
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
      <span class="caret" aria-hidden="true">&#9662;</span>
    </button>

    <div v-if="open" class="panel">
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
            v-if="project.repos.length > 1"
            class="branch mono"
            :title="`${project.repos.length} open worktrees`"
            >{{ project.repos.length }} open</span
          >
          <span class="path mono" :title="project.root">{{ project.root }}</span>
        </button>
      </div>

      <div v-if="recentsNotOpen.length" class="group" data-testid="recent-repos">
        <p class="group-label">Recent</p>
        <button
          v-for="path in recentsNotOpen"
          :key="path"
          class="repo-row"
          @click="pickRecent(path)"
        >
          <span class="name mono" :title="basename(path)">{{ basename(path) }}</span>
          <span class="path mono" :title="path">{{ path }}</span>
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

.caret {
  color: var(--text-dim);
  font-size: var(--fs-micro);
}

.panel {
  position: absolute;
  top: calc(100% + 0.375rem);
  left: 0;
  z-index: 20;
  width: 24rem;
  max-width: 80vw;
  padding: 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: 0 8px 24px rgb(0 0 0 / 0.35);
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
