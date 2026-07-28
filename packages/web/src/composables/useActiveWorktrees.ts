/**
 * useActiveWorktrees: the active repo's worktree view, derived from the
 * one worktree store. Shared by the repo picker (which shows the PROJECT
 * name when the repo is one of several worktrees), the worktree switcher,
 * and the header.
 *
 * Everything here is derived from the ACTIVE PATH, so a repo switch of any
 * kind changes all of it in the same tick: there is no window in which the
 * previous repo's worktrees can be read against the new repo, and no
 * "waiting for a fetch to land" state that can be missed. Until the new
 * repo resolves, `worktrees` is empty and `projectName` falls back to the
 * repo's own directory name — never another project's.
 */

import { computed } from 'vue';
import type { ComputedRef } from 'vue';
import { useDaemonStore } from '../stores/daemon';
import { useWorktreeStore } from '../stores/worktrees';
import { basename } from '../utils/format';
import type { WorktreeInfo } from '@diffstalker/client';

export interface ActiveWorktrees {
  /** The active repo's path, null when no repo is active. */
  activePath: ComputedRef<string | null>;
  worktrees: ComputedRef<WorktreeInfo[]>;
  /** True when there is more than one worktree to switch between. */
  hasMultiple: ComputedRef<boolean>;
  /** The project name: basename of the deepest dir containing every
   * worktree (…/calculator/<branch> -> calculator), else the repo name. */
  projectName: ComputedRef<string>;
}

export function useActiveWorktrees(): ActiveWorktrees {
  const daemon = useDaemonStore();
  const store = useWorktreeStore();

  const activePath = computed(() => store.activePath);
  const worktrees = computed(() => store.activeProject?.worktrees ?? []);
  const hasMultiple = computed(() => worktrees.value.length > 1);

  const projectName = computed(() => {
    const project = store.activeProject;
    if (project) return project.name;
    // Unresolved (or a repo the daemon has not listed yet): the repo's own
    // name is the only honest answer.
    const active = daemon.repos.find((repo) => repo.id === daemon.activeRepoId);
    return active ? basename(active.path) : '';
  });

  return { activePath, worktrees, hasMultiple, projectName };
}
