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
import { GitStateManager } from '@diffstalker/core/managers/GitStateManager';
import { createJournalStore } from '@diffstalker/core/managers/JournalManager';
import type { JournalStore } from '@diffstalker/core/types/journal';
import {
  resolveWorktreeRoot,
  listWorktrees,
  pickDefaultWorktree,
} from '@diffstalker/core/git/worktree';

/** Stable repo id: first 12 hex chars of sha256 of the worktree root. */
export function repoId(root: string): string {
  return createHash('sha256').update(root).digest('hex').slice(0, 12);
}

/** Daemon-wide bound on retained journal stores (open repos never count out). */
export const JOURNAL_STORE_CAP = 32;

/**
 * Journal stores held ABOVE the manager lifecycle, keyed by repo id.
 *
 * Closing a repo's last client drops the refcount to zero (a browser
 * reload only does this because the web app releases its ref with a
 * keepalive DELETE on pagehide — nothing daemon-side detects a vanished
 * client, so an unload without that release would leak the ref) and
 * disposes the core manager but must NOT wipe the session's edit
 * chronology — the store stays here and is re-injected on reopen, where
 * the first observation reconciles itself (a HEAD moved while unobserved
 * becomes a boundary + rebaseline). The map is LRU-capped so a daemon
 * that has touched many repos does not grow without bound; a currently
 * open repo's store is never evicted.
 */
export class JournalStoreCache {
  /** Insertion order doubles as LRU order: acquire() re-inserts. */
  private stores = new Map<string, JournalStore>();

  constructor(private cap: number = JOURNAL_STORE_CAP) {}

  /** The repo's surviving store, or a fresh one; touches the LRU order. */
  acquire(id: string): JournalStore {
    let store = this.stores.get(id);
    if (store) {
      this.stores.delete(id);
    } else {
      store = createJournalStore();
    }
    this.stores.set(id, store);
    return store;
  }

  /**
   * Evict least-recently-used stores beyond the cap, skipping any id
   * `isOpen` claims (an open repo's store must survive; the map may
   * transiently exceed the cap when everything is open).
   */
  prune(isOpen: (id: string) => boolean): void {
    if (this.stores.size <= this.cap) return;
    for (const id of this.stores.keys()) {
      if (this.stores.size <= this.cap) return;
      if (isOpen(id)) continue;
      this.stores.delete(id);
    }
  }

  has(id: string): boolean {
    return this.stores.has(id);
  }

  get size(): number {
    return this.stores.size;
  }
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

/**
 * Lifecycle callbacks, injected by createDaemon (the registry must not
 * import the server or the SSE hubs — that would be a layering inversion).
 * onOpened fires only when an open CREATES the handle, onClosed only when a
 * close actually disposes it (refcount hit zero). disposeAll (daemon
 * shutdown) is silent: the subscribers are being torn down anyway.
 */
export interface RegistryEvents {
  onOpened?: (handle: RepoHandle) => void;
  onClosed?: (id: string) => void;
}

export class RepoRegistry {
  private byId = new Map<string, RepoHandle>();
  private byPath = new Map<string, RepoHandle>();
  private journalStores = new JournalStoreCache();

  constructor(private events: RegistryEvents = {}) {}

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

    // Inject the repo's surviving journal store (or mint one on first
    // open): the store lives above the manager lifecycle so a close +
    // reopen keeps the session's chronology.
    const id = repoId(root);
    const manager = new GitStateManager(root, this.journalStores.acquire(id));
    manager.workingTree.startWatching();

    const handle: RepoHandle = {
      id,
      path: root,
      manager,
      refCount: 1,
    };
    this.byId.set(handle.id, handle);
    this.byPath.set(root, handle);
    this.journalStores.prune((storeId) => this.byId.has(storeId));
    this.events.onOpened?.(handle);
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
   * only when the count reaches zero. The journal store is deliberately
   * NOT dropped — it stays in the LRU cache so a reopen resumes the same
   * chronology. Returns true when the repo was fully removed, false when
   * other opens still hold it or the id is unknown.
   */
  closeRepo(id: string): boolean {
    const handle = this.byId.get(id);
    if (!handle) return false;

    handle.refCount--;
    if (handle.refCount > 0) return false;

    this.byId.delete(handle.id);
    this.byPath.delete(handle.path);
    handle.manager.dispose();
    this.events.onClosed?.(handle.id);
    return true;
  }

  /** Dispose every open repo regardless of refcount (daemon shutdown). */
  disposeAll(): void {
    for (const handle of this.byId.values()) {
      handle.manager.dispose();
    }
    this.byId.clear();
    this.byPath.clear();
  }
}
