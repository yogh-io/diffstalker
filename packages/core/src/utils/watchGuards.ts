/**
 * Guards every chokidar watcher in the project shares.
 *
 * Lives in utils/ rather than beside one watcher because the rule below
 * is about the runtime, not about what any one watcher is looking at: any
 * watched tree can grow a pipe.
 */

import * as fs from 'node:fs';

/**
 * Whether a watcher must not touch this path: anything that is neither a
 * regular file nor a directory, so a FIFO, socket, or device.
 *
 * Opening a FIFO blocks until someone opens the other end to write. Under bun
 * that block lands on the main thread, so a pipe appearing in a watched tree
 * freezes the whole daemon — every request, /health included, not just the one
 * that touched it. Node walks the same path without trouble, which makes this a
 * workaround for a runtime difference rather than for chokidar. `ignored` is
 * the only hook that runs BEFORE chokidar opens anything, so the check has to
 * live there; by the time an event handler sees the path it is already too late.
 *
 * Two things make the obvious version wrong:
 *  - chokidar calls `ignored` twice per path, once with stats and once without,
 *    so `stats` cannot be relied on being there.
 *  - the stats it does pass describe the LINK, not its target. Rejecting
 *    everything that fails isFile() would quietly stop every symlink in the
 *    tree being watched, so symlinks get resolved here instead. statSync
 *    follows the link and is safe on a pipe: stat never blocks, only open does.
 *
 * What this guard cannot reach: on bun 1.3, fs.watch(dir) lists the directory
 * on a pool thread AFTER it returns and opens every entry with a plain
 * blocking open while holding bun's watcher mutex. `ignored` never sees those
 * entries. A FIFO already in a directory at that moment parks the pool thread,
 * and the next fs.watch() call deadlocks the main thread. Bun 1.4 opens with
 * O_PATH, which never blocks, so once the pin moves past 1.3 this guard can go.
 */
export function isUnwatchable(filePath: string, stats?: fs.Stats): boolean {
  let st = stats;
  if (!st || st.isSymbolicLink()) {
    try {
      st = fs.statSync(filePath);
    } catch {
      // Vanished, or unreadable. Leave it to chokidar, as before.
      return false;
    }
  }
  return !st.isFile() && !st.isDirectory();
}
