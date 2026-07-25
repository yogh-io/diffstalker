/**
 * useActiveWorktrees: derive the active repo's worktree view from the
 * daemon store (which owns the fetch). Shared by the repo picker (to show
 * the PROJECT name when the repo is one of several worktrees) and the
 * worktree switcher (the worktree dropdown) — one fetch, one source, so
 * the two never disagree.
 */

import { computed } from 'vue';
import type { ComputedRef } from 'vue';
import { useDaemonStore } from '../stores/daemon';
import { basename } from '../utils/format';
import type { WorktreeInfo } from '@diffstalker/client';

export interface ActiveWorktrees {
  worktrees: ComputedRef<WorktreeInfo[]>;
  /** True when there is more than one worktree to switch between. */
  hasMultiple: ComputedRef<boolean>;
  /** The project name: basename of the deepest dir containing every
   * worktree (…/calculator/<branch> -> calculator), else the repo name. */
  projectName: ComputedRef<string>;
}

/** Drop trailing slashes without a regex (avoids a ReDoS lint flag). */
function stripTrailingSlashes(path: string): string {
  let end = path.length;
  while (end > 1 && path[end - 1] === '/') end--;
  return path.slice(0, end);
}

/** Longest common directory prefix of the given absolute paths. */
function commonParentDir(paths: string[]): string {
  if (paths.length === 0) return '';
  const segments = paths.map((p) => stripTrailingSlashes(p).split('/'));
  const [first] = segments;
  let i = 0;
  while (i < first.length && segments.every((s) => s[i] === first[i])) i++;
  return first.slice(0, i).join('/');
}

export function useActiveWorktrees(): ActiveWorktrees {
  const daemon = useDaemonStore();

  const worktrees = computed(() => daemon.worktrees);
  const hasMultiple = computed(() => worktrees.value.length > 1);
  const projectName = computed(() => {
    const common = commonParentDir(worktrees.value.map((w) => w.path));
    if (common && common !== '/') return basename(common);
    const active = daemon.repos.find((r) => r.id === daemon.activeRepoId);
    return active ? basename(active.path) : '';
  });

  return { worktrees, hasMultiple, projectName };
}
