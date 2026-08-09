/**
 * Repository discovery, daemon-side: keep a live list of the git repos
 * under the configured watch directories.
 *
 * Discovery LISTS repos, it does not open them. Opening is what starts a
 * watcher and a git state per repo, so a root with fifty projects would
 * otherwise cost fifty of each on startup. A discovered repo is a name, a
 * path and a branch until a client asks for it by POST /repos.
 *
 * Each root gets one chokidar watcher at depth 1, which is exactly the
 * reach of the scan (a child, and one level inside a child): a clone into
 * the root, or into a grouping directory in it, shows up without anyone
 * reloading. Only directory add/remove events are acted on — a build
 * writing files inside a project changes nothing about which projects
 * exist — and they are debounced into one rescan of that root.
 *
 * What the watcher deliberately does NOT see is a repo's `.git` (a dot
 * directory, ignored), so a branch label can be stale after a checkout
 * elsewhere. Clients that care re-ask with POST /discovered/rescan, which
 * is a filesystem walk and no git processes.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { watch, FSWatcher } from 'chokidar';
import { discoverRepos, type DiscoveredRepo } from '@diffstalker/core/git/discoverRepos';
import { isUnwatchable } from '@diffstalker/core/utils/watchGuards';
import type { DaemonEventHub } from './sse.js';

/** How long directory churn must settle before a root is rescanned. */
const RESCAN_DEBOUNCE_MS = 300;

export interface WatchRootState {
  /** The configured directory, absolute and normalized. */
  path: string;
  repos: DiscoveredRepo[];
  /**
   * Why this root has no repos, when the reason is the root itself
   * (removed, unreadable, not a directory any more). Null when the scan
   * worked — including when it worked and found nothing.
   */
  error: string | null;
  /** The scan stopped at its cap: there are more repos than are listed. */
  capped: boolean;
}

export interface DiscoveryState {
  roots: WatchRootState[];
}

interface RootEntry {
  state: WatchRootState;
  watcher: FSWatcher | null;
  timer: ReturnType<typeof setTimeout> | null;
}

/** Never descend into these while watching (the scan skips them too). */
function ignoredByWatcher(filePath: string, stats?: fs.Stats): boolean {
  const name = path.basename(filePath);
  if (name.startsWith('.') && name !== '.') return true;
  if (name === 'node_modules') return true;
  return isUnwatchable(filePath, stats);
}

export class DiscoveryController {
  /** Keyed by root path; iteration order is the configured order. */
  private roots = new Map<string, RootEntry>();
  private disposed = false;

  constructor(private hub: DaemonEventHub) {}

  get state(): DiscoveryState {
    return { roots: [...this.roots.values()].map((entry) => entry.state) };
  }

  /**
   * Apply a new list of watch directories: roots that are gone stop being
   * watched, new ones are scanned and watched, and the ones that stay keep
   * the results they already have (no flicker, no re-walk). Broadcasts
   * once the new roots have been scanned.
   */
  async setRoots(paths: string[]): Promise<void> {
    if (this.disposed) return;

    for (const [root, entry] of this.roots) {
      if (!paths.includes(root)) {
        this.teardown(entry);
        this.roots.delete(root);
      }
    }

    const added: string[] = [];
    // Rebuild the map so its order matches the configured order.
    const ordered = new Map<string, RootEntry>();
    for (const root of paths) {
      const existing = this.roots.get(root);
      if (existing) {
        ordered.set(root, existing);
        continue;
      }
      ordered.set(root, {
        state: { path: root, repos: [], error: null, capped: false },
        watcher: null,
        timer: null,
      });
      added.push(root);
    }
    this.roots = ordered;

    await Promise.all(added.map((root) => this.scan(root)));
    for (const root of added) this.startWatching(root);
    this.broadcast();
  }

  /** Re-walk every root now (a client asking for fresh branch labels). */
  async rescan(): Promise<DiscoveryState> {
    await Promise.all([...this.roots.keys()].map((root) => this.scan(root)));
    this.broadcast();
    return this.state;
  }

  dispose(): void {
    this.disposed = true;
    for (const entry of this.roots.values()) this.teardown(entry);
    this.roots.clear();
  }

  private teardown(entry: RootEntry): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    void entry.watcher?.close();
    entry.watcher = null;
  }

  /** Walk one root, recording either its repos or the reason there are none. */
  private async scan(root: string): Promise<void> {
    const entry = this.roots.get(root);
    if (!entry) return;
    try {
      const result = await discoverRepos(root);
      entry.state = { path: root, repos: result.repos, error: null, capped: result.capped };
    } catch (err) {
      entry.state = {
        path: root,
        repos: [],
        error: err instanceof Error ? err.message : String(err),
        capped: false,
      };
    }
  }

  private startWatching(root: string): void {
    const entry = this.roots.get(root);
    if (!entry || entry.watcher) return;

    const watcher = watch(root, {
      persistent: true,
      ignoreInitial: true,
      depth: 1,
      ignored: ignoredByWatcher,
    });
    // An unhandled 'error' on an EventEmitter takes the daemon down; a
    // watch that fails records itself like a failed scan and stays quiet.
    watcher.on('error', (err: unknown) => {
      entry.state = {
        ...entry.state,
        error: err instanceof Error ? err.message : String(err),
      };
      this.broadcast();
    });
    watcher.on('addDir', () => this.scheduleRescan(root));
    watcher.on('unlinkDir', () => this.scheduleRescan(root));
    entry.watcher = watcher;
  }

  /** Coalesce a burst of directory churn into one rescan of that root. */
  private scheduleRescan(root: string): void {
    const entry = this.roots.get(root);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timer = null;
      void this.scan(root).then(() => this.broadcast());
    }, RESCAN_DEBOUNCE_MS);
    entry.timer.unref?.();
  }

  private broadcast(): void {
    if (this.disposed) return;
    this.hub.broadcast('discovery-change', this.state);
  }
}
