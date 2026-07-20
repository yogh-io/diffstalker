/**
 * Pure explorer status helpers — no simple-git, no filesystem.
 *
 * Split out from `explorerData.ts` so the CLI can build a git-status map for
 * the explorer without pulling `listDirectory`'s `git check-ignore` call
 * (which reaches simple-git). `explorerData.ts` re-exports these so the
 * daemon's existing imports keep working.
 */

import type { FileStatus } from './status.js';

/** Git status lookup for annotating listings: per-file status plus the set
 *  of directories that contain changes. */
export interface GitStatusMap {
  files: Map<string, { status: FileStatus; staged: boolean }>;
  directories: Set<string>; // Directories that contain changes
}

/**
 * Build a GitStatusMap from status file entries: every file keyed by path,
 * and every ancestor directory (plus the root '') marked as containing
 * changes.
 */
export function buildGitStatusMap(
  files: ReadonlyArray<{ path: string; status: FileStatus; staged: boolean }>
): GitStatusMap {
  const statusMap: GitStatusMap = {
    files: new Map(),
    directories: new Set(),
  };

  for (const file of files) {
    statusMap.files.set(file.path, { status: file.status, staged: file.staged });

    // Mark all parent directories as having changed children
    const parts = file.path.split('/');
    let dirPath = '';
    for (let i = 0; i < parts.length - 1; i++) {
      dirPath = dirPath ? `${dirPath}/${parts[i]}` : parts[i];
      statusMap.directories.add(dirPath);
    }
    // Also mark root as having changes
    statusMap.directories.add('');
  }

  return statusMap;
}
