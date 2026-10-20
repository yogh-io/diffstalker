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
import { error as logError } from '@diffstalker/core/utils/logger';
import { GitStateManager } from '@diffstalker/core/managers/GitStateManager';
import { createJournalStore } from '@diffstalker/core/managers/JournalManager';
import type { JournalStore } from '@diffstalker/core/types/journal';
import { resolveRepoRoot } from '@diffstalker/core/git/worktree';

/** Stable repo id: first 12 hex chars of sha256 of the worktree root. */
export function repoId(root: string): string {
  return createHash('sha256').update(root).digest('hex').slice(0, 12);
}

/** Daemon-wide bound on retained journal stores (open repos never count out). */
export const JOURNAL_STORE_CAP = 32;

/** How long a released repo keeps its live manager before it is disposed. */
export const LINGER_MS = 10 * 60 * 1000;

/** How many released repos may linger at once; past it the oldest goes. */
export const LINGER_CAP = 4;

export interface RegistryOptions {
  lingerMs?: number;
  lingerCap?: number;
}

/**
 * Journal stores held ABOVE the manager lifecycle, keyed by repo id.
 *
 * Closing a repo's last client drops the refcount to zero (a browser
 * reload only does this because the web app releases its ref with a
 * keepalive DELETE on pagehide — nothing daemon-side detects a vanished
 * client, so an unload without that release would leak the ref). The
 * manager lingers for a while and is then disposed, but that must NOT
 * wipe the session's edit chronology — the store stays here and is
 * re-injected on reopen, where the first observation reconciles itself
 * (a HEAD moved while unobserved becomes a boundary + rebaseline). The
 * map is LRU-capped so a daemon that has touched many repos does not
 * grow without bound; the store of an open or lingering repo is never
 * evicted.
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

/**
 * A path openRepo refused, and why. `requested` is the expanded path (the
 * one that was actually looked for). Anything else openRepo throws is an
 * unexpected failure, not a refusal.
 */
export class RepoOpenRefused extends Error {
  constructor(
    readonly reason: 'not-absolute' | 'not-a-repo',
    readonly requested: string
  ) {
    super(
      reason === 'not-absolute'
        ? `Repo path must be absolute: ${requested}`
        : `Not a git repository: ${requested}`
    );
    this.name = 'RepoOpenRefused';
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
 * onOpened fires when an open makes the repo visible (a new handle, or a
 * lingering one taken back), onClosed when a close drops the refcount to
 * zero. disposeAll (daemon shutdown) is silent: the subscribers are being
 * torn down anyway.
 */
export interface RegistryEvents {
  onOpened?: (handle: RepoHandle) => void;
  onClosed?: (id: string) => void;
}

/** A released repo whose manager is kept live for a quick reopen. */
interface Lingering {
  handle: RepoHandle;
  timer: ReturnType<typeof setTimeout>;
}

export class RepoRegistry {
  private byId = new Map<string, RepoHandle>();
  private byPath = new Map<string, RepoHandle>();
  /** Keyed by root; insertion order is linger order, oldest first. */
  private lingering = new Map<string, Lingering>();
  private journalStores = new JournalStoreCache();
  private lingerMs: number;
  private lingerCap: number;

  constructor(
    private events: RegistryEvents = {},
    options: RegistryOptions = {}
  ) {
    this.lingerMs = options.lingerMs ?? LINGER_MS;
    this.lingerCap = options.lingerCap ?? LINGER_CAP;
  }

  /**
   * Open a repo by any path: a worktree root, a subdirectory, or a bare
   * container (resolved to its most recently active worktree). Opening the
   * same normalized path twice shares one manager and bumps the refcount.
   *
   * Path resolution (including `~` expansion) is `resolveRepoRoot`'s job,
   * shared with the `GET /resolve` probe so the picker's Open button and
   * this open can never disagree. Opening does NOT require the path to
   * exist: git placing a vanished subdirectory in its parent worktree is a
   * convenience worth keeping here, and only the probe needs it closed off.
   */
  async openRepo(inputPath: string): Promise<OpenResult> {
    const resolved = await resolveRepoRoot(inputPath, { mustExist: false });
    if (!resolved.ok) {
      throw new RepoOpenRefused(resolved.reason, resolved.requested);
    }
    const root = resolved.root;

    const existing = this.byPath.get(root);
    if (existing) {
      existing.refCount++;
      return { handle: existing, created: false };
    }

    const revived = this.takeLingering(root);
    if (revived) {
      revived.refCount = 1;
      this.byId.set(revived.id, revived);
      this.byPath.set(root, revived);
      this.journalStores.acquire(revived.id);
      // Served warm at once; the refresh catches anything its watchers
      // could not see while it lingered (a directory replaced, a watch lost).
      revived.manager.workingTree.scheduleRefresh();
      this.events.onOpened?.(revived);
      return { handle: revived, created: false };
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
    this.pruneJournalStores();
    this.events.onOpened?.(handle);
    return { handle, created: true };
  }

  /**
   * The lingering handle for this root, out of the linger set and with its
   * timer cancelled. A manager that lost its repo while lingering is not
   * worth reviving: it is disposed here and the open starts fresh.
   */
  private takeLingering(root: string): RepoHandle | null {
    const entry = this.lingering.get(root);
    if (!entry) return null;
    clearTimeout(entry.timer);
    this.lingering.delete(root);
    if (entry.handle.manager.workingTree.unavailable) {
      entry.handle.manager.dispose();
      return null;
    }
    return entry.handle;
  }

  /** Open and lingering repos both have a live manager writing to their store. */
  private pruneJournalStores(): void {
    const lingeringIds = new Set([...this.lingering.values()].map((entry) => entry.handle.id));
    this.journalStores.prune((storeId) => this.byId.has(storeId) || lingeringIds.has(storeId));
  }

  getRepo(id: string): RepoHandle | undefined {
    return this.byId.get(id);
  }

  listRepos(): RepoHandle[] {
    return [...this.byId.values()];
  }

  /**
   * Decrement a repo's refcount. At zero the repo is closed for every
   * client (not listed, not addressable, onClosed fires), but its core
   * manager keeps running for LINGER_MS so a reopen inside that window is
   * warm. The journal store is deliberately NOT dropped — it stays in the
   * LRU cache so a reopen resumes the same chronology. Returns true when
   * the repo was closed, false when other opens still hold it or the id
   * is unknown.
   */
  closeRepo(id: string): boolean {
    const handle = this.byId.get(id);
    if (!handle) return false;

    handle.refCount--;
    if (handle.refCount > 0) return false;

    this.byId.delete(handle.id);
    this.byPath.delete(handle.path);
    this.linger(handle);
    this.events.onClosed?.(handle.id);
    return true;
  }

  private linger(handle: RepoHandle): void {
    if (this.lingering.size >= this.lingerCap) {
      const oldest = this.lingering.keys().next().value!;
      this.disposeLingering(oldest);
    }
    const timer = setTimeout(() => this.disposeLingering(handle.path), this.lingerMs);
    timer.unref();
    this.lingering.set(handle.path, { handle, timer });
  }

  private disposeLingering(root: string): void {
    const entry = this.lingering.get(root);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.lingering.delete(root);
    entry.handle.manager.dispose();
  }

  /** Dispose every open and lingering repo regardless of refcount (daemon shutdown). */
  disposeAll(): void {
    for (const handle of this.byId.values()) {
      handle.manager.dispose();
    }
    this.byId.clear();
    this.byPath.clear();
    for (const root of [...this.lingering.keys()]) {
      this.disposeLingering(root);
    }
  }
}

/**
 * Start the first refresh of a freshly opened repo without waiting for it.
 * Git failures land in the manager's state (and its log line), so a
 * rejection here is the refresh path itself breaking — logged, never
 * dropped.
 */
export function warmUp(handle: RepoHandle): void {
  handle.manager.workingTree.refresh().catch((err: unknown) => {
    logError('First refresh threw', err, { repo: handle.path });
  });
}

/**
 * Open a repo and warm up its status/hunk counts on first open. Every
 * caller that opens a repo on behalf of a user wants this pair (POST /repos
 * and the entry point's positional paths), so it lives here in one copy.
 */
export async function openAndWarm(
  registry: RepoRegistry,
  inputPath: string
): Promise<OpenResult> {
  const opened = await registry.openRepo(inputPath);
  if (opened.created) warmUp(opened.handle);
  return opened;
}
