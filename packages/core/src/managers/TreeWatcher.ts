/**
 * A recursive directory watcher on fs.watch (inotify on Linux).
 *
 * It watches directories only. A directory's watch already reports every
 * change to the entries in it, so a watch per file would only cost kernel
 * memory and handles. An event costs at most one lstat, to learn whether a
 * created entry is a directory to watch; a directory is never re-read to
 * find out what changed. Symlinks are not followed, as git does not follow
 * them.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface TreeWatcherOptions {
  /** Whether to leave a directory, and all below it, unwatched. Never asked about the root. */
  skipDir: (rel: string) => boolean;
  /**
   * Something changed at a root-relative, '/'-separated path. isDir says
   * whether the path is, or was until now, a directory.
   */
  onChange: (rel: string, isDir: boolean) => void;
  /** A directory could not be watched or read, or its watch failed. */
  onError: (err: unknown, rel: string) => void;
}

function join(dir: string, name: string): string {
  return dir === '' ? name : `${dir}/${name}`;
}

/** The directory a root-relative path is in; '' for the root. */
function parentOf(rel: string): string {
  const slash = rel.lastIndexOf('/');
  return slash === -1 ? '' : rel.slice(0, slash);
}

function isBelow(rel: string, dir: string): boolean {
  return rel === dir || dir === '' || rel.startsWith(`${dir}/`);
}

export class TreeWatcher {
  private watches = new Map<string, fs.FSWatcher>();
  /** The inode each watch was put on, to tell a directory from one recreated at its path. */
  private inodes = new Map<string, number>();
  /** Directories met and skipped, so an event naming one is known to be about a directory. */
  private skipped = new Set<string>();
  /** Paths with an lstat in flight, and those that had another event meanwhile. */
  private inspecting = new Set<string>();
  private reinspect = new Set<string>();
  /**
   * Watched directories holding an entry with their own name (`pkg/pkg`,
   * a binary named after its folder). An event naming that entry is about
   * the entry, not the directory's own removal.
   */
  private namesakes = new Set<string>();
  private closed = false;
  private _rootGone = false;
  /** The watch limit was hit: reported once, until the next resync. */
  private limitReported = false;

  constructor(
    private root: string,
    private options: TreeWatcherOptions
  ) {}

  /** How many directories are watched. */
  get watchedDirs(): number {
    return this.watches.size;
  }

  /**
   * The root was missing, or went away: nothing is watched and nothing
   * will be until the watcher is started again.
   */
  get rootGone(): boolean {
    return this._rootGone;
  }

  /** Watch the root and every directory below it that is not skipped. */
  start(): Promise<void> {
    this._rootGone = false;
    return this.crawl('');
  }

  close(): void {
    this.closed = true;
    for (const watcher of this.watches.values()) watcher.close();
    this.watches.clear();
    this.inodes.clear();
    this.skipped.clear();
    this.namesakes.clear();
  }

  /**
   * Ask skipDir again about every directory: unwatch the ones it now
   * skips, crawl the skipped ones it no longer does. For after the rules
   * behind skipDir changed.
   */
  async resync(): Promise<void> {
    this.limitReported = false;
    for (const rel of [...this.watches.keys()]) {
      if (rel !== '' && this.watches.has(rel) && this.options.skipDir(rel)) {
        this.unwatchTree(rel);
        this.skipped.add(rel);
      }
    }
    for (const rel of [...this.skipped]) {
      if (this.closed) return;
      if (this.skipped.has(rel) && !this.options.skipDir(rel)) {
        this.skipped.delete(rel);
        await this.crawl(rel);
      }
    }
  }

  private abs(rel: string): string {
    return rel === '' ? this.root : path.join(this.root, rel);
  }

  /** Watch a directory and every directory below it that is not skipped. */
  private async crawl(start: string): Promise<void> {
    const pending = [start];
    while (pending.length > 0 && !this.closed) {
      const rel = pending.pop()!;
      if (this.watches.has(rel)) continue;
      const ino = await this.directoryInode(rel);
      if (ino === null && rel === '') this._rootGone = true;
      // A parent unwatched meanwhile (removed, or skipped by a resync)
      // takes what is below it along. Watch before reading: an entry
      // created between the two then shows up as an event, never as a gap.
      if (ino === null || this.closed || !this.parentWatched(rel) || !this.watch(rel, ino)) {
        continue;
      }
      for (const child of await this.subdirsToWatch(rel)) pending.push(child);
    }
  }

  private parentWatched(rel: string): boolean {
    return rel === '' || this.watches.has(parentOf(rel));
  }

  /** The inode of the directory at rel; null when it is not one, or is gone. */
  private async directoryInode(rel: string): Promise<number | null> {
    try {
      // The root may be reached through a symlink; nothing below it is followed.
      const stat = await (rel === '' ? fs.promises.stat : fs.promises.lstat)(this.abs(rel));
      return stat.isDirectory() ? stat.ino : null;
    } catch (err) {
      this.options.onError(err, rel);
      return null;
    }
  }

  /** The subdirectories of a watched directory still to watch; skipped ones are noted. */
  private async subdirsToWatch(rel: string): Promise<string[]> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(this.abs(rel), { withFileTypes: true });
    } catch (err) {
      this.options.onError(err, rel);
      return [];
    }
    // Closed, or removed by an event, while it was being read.
    if (this.closed || !this.watches.has(rel)) return [];
    const toWatch: string[] = [];
    const ownName = path.basename(this.abs(rel));
    for (const entry of entries) {
      if (entry.name === ownName) this.namesakes.add(rel);
      const child = join(rel, entry.name);
      if (!entry.isDirectory() || this.watches.has(child) || this.skipped.has(child)) continue;
      if (this.options.skipDir(child)) this.skipped.add(child);
      else toWatch.push(child);
    }
    return toWatch;
  }

  /** Put a watch on one directory; false when it already had one or cannot get one. */
  private watch(rel: string, ino: number): boolean {
    if (this.watches.has(rel)) return false;
    let watcher: fs.FSWatcher;
    try {
      // Not persistent: a watch must never be what keeps a process alive.
      watcher = fs.watch(this.abs(rel), { persistent: false }, (type, name) =>
        this.onEvent(rel, type, name)
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOSPC') {
        // Every watch after the first refusal fails the same way.
        if (!this.limitReported) this.options.onError(err, rel);
        this.limitReported = true;
        return false;
      }
      this.options.onError(err, rel);
      return false;
    }
    watcher.on('error', (err: unknown) => {
      if (this.watches.get(rel) === watcher) {
        this.watches.delete(rel);
        this.inodes.delete(rel);
      }
      watcher.close();
      this.options.onError(err, rel);
    });
    this.watches.set(rel, watcher);
    this.inodes.set(rel, ino);
    return true;
  }

  private onEvent(dir: string, type: string, name: string | Buffer | null): void {
    if (this.closed) return;
    if (name === null) {
      this.options.onChange(dir, true);
      return;
    }
    const rel = join(dir, name.toString());
    // 'rename' is an entry created, removed or moved: the one case where
    // the watch set may have to change.
    if (type === 'rename') {
      void this.inspect(rel);
      return;
    }
    this.options.onChange(rel, this.watches.has(rel) || this.skipped.has(rel));
  }

  private async inspect(rel: string): Promise<void> {
    if (this.inspecting.has(rel)) {
      this.reinspect.add(rel);
      return;
    }
    this.inspecting.add(rel);
    try {
      do {
        this.reinspect.delete(rel);
        const { isDir, gone } = await this.settle(rel);
        if (this.closed) return;
        await this.checkOwnEvent(rel, gone);
        if (this.closed) return;
        this.options.onChange(rel, isDir);
      } while (this.reinspect.has(rel));
    } finally {
      this.inspecting.delete(rel);
    }
  }

  /**
   * Bring the watch set in line with what is at rel now. isDir: rel is a
   * directory, or was one until it went away.
   */
  private async settle(rel: string): Promise<{ isDir: boolean; gone: boolean }> {
    let stat: fs.Stats | null = null;
    try {
      stat = await fs.promises.lstat(this.abs(rel));
    } catch {
      // Gone: the expected end of a rename event for a removed entry.
    }
    if (this.closed) return { isDir: false, gone: stat === null };
    const wasDir = this.watches.has(rel) || this.skipped.has(rel);
    if (stat === null || !stat.isDirectory()) {
      if (wasDir) this.unwatchTree(rel);
      return { isDir: stat === null && wasDir, gone: stat === null };
    }
    // Removed and made again under the same name: the old watch is on
    // the removed directory, so start over.
    if (this.watches.has(rel) && this.inodes.get(rel) !== stat.ino) this.unwatchTree(rel);
    // A new directory, and its parent is still watched (it may have gone
    // while the lstat ran).
    const parent = path.posix.dirname(rel);
    if (!this.watches.has(rel) && !this.skipped.has(rel) && this.watches.has(parent === '.' ? '' : parent)) {
      if (this.options.skipDir(rel)) this.skipped.add(rel);
      else await this.crawl(rel);
    }
    return { isDir: true, gone: false };
  }

  /**
   * A watch reports its own directory's removal or move as a rename of an
   * entry named like the directory. Unless the directory really holds such
   * an entry, check the directory itself.
   */
  private async checkOwnEvent(rel: string, gone: boolean): Promise<void> {
    const dir = parentOf(rel);
    if (path.basename(rel) !== path.basename(this.abs(dir))) return;
    if (!gone) this.namesakes.add(dir);
    else if (this.namesakes.has(dir)) this.namesakes.delete(dir);
    else await this.revalidate(dir);
  }

  /**
   * A watched directory reported itself removed, moved or changed. Watch
   * it afresh when a directory is there: it may be a new one in the old
   * one's place, even with the old inode number, and the old watch ended
   * with the old directory.
   */
  private async revalidate(dir: string): Promise<void> {
    let stat: fs.Stats | null = null;
    try {
      stat = await (dir === '' ? fs.promises.stat : fs.promises.lstat)(this.abs(dir));
    } catch {
      // Gone, as the removal's own event said.
    }
    if (this.closed) return;
    this.unwatchTree(dir);
    if (!stat?.isDirectory()) {
      if (dir === '') this._rootGone = true;
      return;
    }
    if (dir !== '' && this.options.skipDir(dir)) this.skipped.add(dir);
    else await this.crawl(dir);
  }

  private unwatchTree(rel: string): void {
    for (const [key, watcher] of this.watches) {
      if (isBelow(key, rel)) {
        watcher.close();
        this.watches.delete(key);
        this.inodes.delete(key);
      }
    }
    for (const key of this.skipped) {
      if (isBelow(key, rel)) this.skipped.delete(key);
    }
    for (const key of this.namesakes) {
      if (isBelow(key, rel)) this.namesakes.delete(key);
    }
  }
}
