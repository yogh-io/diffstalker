/**
 * Repo registry: opens repositories, normalizes their path to a worktree
 * root, and refcounts opens so multiple clients share one core manager.
 *
 * Repos get short opaque ids so URLs stay clean — the raw filesystem path
 * never appears in a URL. The id is a stable hash of the normalized
 * worktree root, so a client's cached id addresses the same repo after a
 * daemon restart.
 */

import { createHash } from 'node:crypto';
import {
  getManagerForRepo,
  removeManagerForRepo,
  GitStateManager,
} from '@diffstalker/core/managers/GitStateManager';
import {
  resolveWorktreeRoot,
  listWorktrees,
  pickDefaultWorktree,
} from '@diffstalker/core/git/worktree';

/** Stable repo id: first 12 hex chars of sha256 of the worktree root. */
export function repoId(root: string): string {
  return createHash('sha256').update(root).digest('hex').slice(0, 12);
}

export interface RepoHandle {
  /** Short opaque id used in URLs: a stable hash of the worktree root. */
  id: string;
  /** Normalized worktree root. */
  path: string;
  manager: GitStateManager;
  refCount: number;
}

export interface OpenResult {
  handle: RepoHandle;
  /** True when this open created the handle (vs joining an existing one). */
  created: boolean;
}

export class RepoRegistry {
  private byId = new Map<string, RepoHandle>();
  private byPath = new Map<string, RepoHandle>();

  /**
   * Open a repo by any path: a worktree root, a subdirectory, or a bare
   * container (resolved to its most recently active worktree). Opening the
   * same normalized path twice shares one manager and bumps the refcount.
   */
  async openRepo(inputPath: string): Promise<OpenResult> {
    let root = await resolveWorktreeRoot(inputPath);
    if (!root) {
      // Bare container (or a path git can't place in a working tree):
      // fall back to the default worktree of whatever repo this is.
      const worktree = pickDefaultWorktree(await listWorktrees(inputPath));
      if (!worktree) {
        throw new Error(`Not a git repository: ${inputPath}`);
      }
      root = worktree.path;
    }

    const existing = this.byPath.get(root);
    if (existing) {
      existing.refCount++;
      return { handle: existing, created: false };
    }

    const manager = getManagerForRepo(root);
    manager.workingTree.startWatching();

    const handle: RepoHandle = {
      id: repoId(root),
      path: root,
      manager,
      refCount: 1,
    };
    this.byId.set(handle.id, handle);
    this.byPath.set(root, handle);
    return { handle, created: true };
  }

  getRepo(id: string): RepoHandle | undefined {
    return this.byId.get(id);
  }

  listRepos(): RepoHandle[] {
    return [...this.byId.values()];
  }

  /**
   * Decrement a repo's refcount; dispose the core manager (watchers, queue)
   * only when the count reaches zero. Returns true when the repo was fully
   * removed, false when other opens still hold it or the id is unknown.
   */
  closeRepo(id: string): boolean {
    const handle = this.byId.get(id);
    if (!handle) return false;

    handle.refCount--;
    if (handle.refCount > 0) return false;

    this.byId.delete(handle.id);
    this.byPath.delete(handle.path);
    removeManagerForRepo(handle.path);
    return true;
  }

  /** Dispose every open repo regardless of refcount (daemon shutdown). */
  disposeAll(): void {
    for (const handle of this.byId.values()) {
      removeManagerForRepo(handle.path);
    }
    this.byId.clear();
    this.byPath.clear();
  }
}
