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
import type { RepoSummary, WorktreeInfo } from '@diffstalker/client';

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
  /** ALL worktrees the project has, not just the open ones — the same
   * count the Recent list shows, so one project reads the same in both. */
  worktreeCount: number;
}

/** repoId -> its project root + total worktree count, resolved by pulling
 * each repo's worktrees once. */
const projectByRepoId = ref(new Map<string, { root: string; worktreeCount: number }>());

/** Concurrently, for the same reason as resolveRecentProjects: sequential
 * awaits leave open worktrees of one project drawn as separate rows for
 * N round-trips before they fold together. */
async function resolveProjects(): Promise<void> {
  const pending = daemon.repos.filter((repo) => !projectByRepoId.value.has(repo.id));
  if (pending.length === 0) return;

  const settled = await Promise.all(
    pending.map(async (repo) => {
      try {
        const paths = (await client.worktrees(repo.id))
          .filter((w) => !w.isBare)
          .map((w) => w.path);
        return [
          repo.id,
          { root: commonParentDir(paths) || repo.path, worktreeCount: paths.length },
        ] as const;
      } catch {
        // Keep the repo path as its own project on failure.
        return [repo.id, { root: repo.path, worktreeCount: 0 }] as const;
      }
    })
  );

  const next = new Map(projectByRepoId.value);
  for (const [id, resolved] of settled) next.set(id, resolved);
  projectByRepoId.value = next;
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
    const resolved = projectByRepoId.value.get(repo.id);
    const root = resolved?.root ?? repo.path;
    let group = groups.get(root);
    if (!group) {
      group = { root, name: basename(root), repos: [], worktreeCount: 0 };
      groups.set(root, group);
    }
    group.repos.push(repo);
    // Every repo in a group belongs to the same family, so they all report
    // the same count; take whichever resolved (0 while none has yet).
    group.worktreeCount = Math.max(group.worktreeCount, resolved?.worktreeCount ?? 0);
  }
  return [...groups.values()];
});

const recentsNotOpen = computed(() =>
  ui.recentRepos.filter((path) => !daemon.repos.some((repo) => repo.path === path))
);

// --- Group recents by project (mirrors openProjects above) -----------------

interface RecentProject {
  /** Project root: the deepest dir containing every known worktree of this
   * repo, or the recent path itself while unresolved / on failure. */
  root: string;
  name: string;
  /** Every worktree of this project the daemon reports (used to pick which
   * one to open — not just the ones that happen to be in `recentRepos`). */
  worktrees: WorktreeInfo[];
}

/**
 * What we know about a recent path. ABSENT from the map means "still
 * asking" — deliberately distinct from every settled state, because a
 * pending path must NOT render: several worktrees of one repo each
 * resolve to the same project row, so drawing them before they resolve
 * shows a stray row per worktree that then vanishes (exactly the
 * "why is my worktree listed as a repo" bug).
 */
type RecentResolution =
  /** Resolved to a real worktree family. */
  | { kind: 'project'; project: RecentProject }
  /** Resolved, but the path is no longer a worktree at all (a removed
   * worktree directory still in prefs) — drop it from the list. */
  | { kind: 'gone' }
  /** Could not ask (daemon down/restarting). Distinct from 'gone': the
   * path may well be fine, so it still renders (by its own path — the
   * best we know) and is retried the next time the panel opens. */
  | { kind: 'failed' };

const recentResolution = ref(new Map<string, RecentResolution>());

/**
 * Resolve every not-yet-known recent path CONCURRENTLY. Sequentially
 * (one await per path) the unresolved window is N x round-trip, which is
 * long enough to see stray per-worktree rows before they fold together;
 * in parallel it is one round-trip for all of them.
 */
async function resolveRecentProjects(): Promise<void> {
  const pending = recentsNotOpen.value.filter((path) => !recentResolution.value.has(path));
  if (pending.length === 0) return;

  const settled = await Promise.all(
    pending.map(async (path): Promise<[string, RecentResolution]> => {
      try {
        const worktrees = (await client.worktreesForPath(path)).filter((w) => !w.isBare);
        if (worktrees.length === 0) return [path, { kind: 'gone' }];
        const root = commonParentDir(worktrees.map((w) => w.path)) || path;
        return [path, { kind: 'project', project: { root, name: basename(root), worktrees } }];
      } catch {
        return [path, { kind: 'failed' }];
      }
    })
  );

  const next = new Map(recentResolution.value);
  for (const [path, resolution] of settled) next.set(path, resolution);
  recentResolution.value = next;
}

watch(
  [open, recentsNotOpen],
  ([isOpen]) => {
    if (!isOpen) return;
    // Reopening retries whatever we couldn't reach last time; 'gone' and
    // 'project' are settled facts and stay cached.
    for (const [path, resolution] of recentResolution.value) {
      if (resolution.kind === 'failed') recentResolution.value.delete(path);
    }
    void resolveRecentProjects();
  },
  { immediate: false }
);

/** One row per project root, folding every recent path that resolved to the
 * same root and dropping any already shown under "Open on daemon". Paths
 * still being resolved are held back entirely (see RecentResolution);
 * paths we could not reach fall back to their own path so the list never
 * silently loses an entry just because the daemon blinked. */
const recentProjects = computed<RecentProject[]>(() => {
  const openRoots = new Set(openProjects.value.map((p) => p.root));
  const seen = new Map<string, RecentProject>();
  for (const path of recentsNotOpen.value) {
    const resolution = recentResolution.value.get(path);
    if (resolution === undefined || resolution.kind === 'gone') continue;
    const project =
      resolution.kind === 'project'
        ? resolution.project
        : { root: path, name: basename(path), worktrees: [] };
    if (openRoots.has(project.root) || seen.has(project.root)) continue;
    seen.set(project.root, project);
  }
  return [...seen.values()];
});

/** The worktree to open for a project: the most recently active one, or
 * the root itself when no worktree data resolved. */
function bestWorktreePath(project: RecentProject): string {
  if (project.worktrees.length === 0) return project.root;
  return project.worktrees.reduce((best, w) =>
    (w.lastActivity ?? -Infinity) > (best.lastActivity ?? -Infinity) ? w : best
  ).path;
}

/** Activate a project: keep the active worktree if it's in this project,
 * else switch to its first open worktree; the header select refines. */
function pickProject(project: RepoProject): void {
  const active = project.repos.find((repo) => repo.id === daemon.activeRepoId);
  void activate(active ?? project.repos[0]);
  open.value = false;
}

async function pickRecentProject(project: RecentProject): Promise<void> {
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
