/**
 * Pure explorer data functions: directory listing with git status
 * annotation, and file reads for display with binary/size/truncation FLAGS
 * (no presentation prose baked into content).
 *
 * Shared by ExplorerStateManager (the TUI view-model applies its own prose
 * on top) and the daemon's stateless /tree, /file endpoints — one
 * implementation, no duplication.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getIgnoredFiles } from './ignoreUtils.js';
import type { FileStatus } from './status.js';

/** Maximum file size served for display (larger files get tooLarge). */
export const MAX_FILE_SIZE = 1024 * 1024; // 1MB

/** Maximum lines kept in content before truncation kicks in. */
export const MAX_DISPLAY_LINES = 5000;

/**
 * Thrown by readFileForDisplay when the path resolves to something other
 * than a regular file (directory, FIFO, socket, device). Reading such a
 * path must be refused up front: opening a FIFO blocks the event loop
 * until a writer appears, freezing the whole process.
 */
export class NotRegularFileError extends Error {
  constructor(relPath: string) {
    super(`Not a regular file: ${relPath}`);
    this.name = 'NotRegularFileError';
  }
}

/** One entry of a single-level directory listing. */
export interface DirEntry {
  name: string;
  /** Path relative to the repo root. */
  path: string;
  type: 'file' | 'dir';
  /** For files: working-tree git status, when a status map is supplied. */
  gitStatus?: FileStatus;
  /** For files with a gitStatus: true when the change is staged. */
  staged?: boolean;
  /** For dirs: true when the directory contains changed files. */
  hasChanges?: boolean;
}

/** Git status lookup for annotating listings: per-file status plus the set
 *  of directories that contain changes. */
export interface GitStatusMap {
  files: Map<string, { status: FileStatus; staged: boolean }>;
  directories: Set<string>; // Directories that contain changes
}

export interface ListDirectoryOptions {
  /** Skip dot-prefixed entries (default true). */
  hideHidden: boolean;
  /** Skip gitignored entries via `git check-ignore` (default true).
   *  Pass false for non-git directories to avoid the git call. */
  hideGitignored: boolean;
}

export interface FileForDisplay {
  /** File text; empty when binary or tooLarge is set. */
  content: string;
  binary: boolean;
  /** Content was cut at MAX_DISPLAY_LINES. */
  truncated: boolean;
  /** File exceeds MAX_FILE_SIZE; content not read. */
  tooLarge: boolean;
  /** File size in bytes. */
  size: number;
  /** Total line count of the file (0 when binary or tooLarge). */
  totalLines: number;
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

/**
 * List one directory level: hidden and gitignored entries filtered,
 * directories first then files, alphabetical within each group. When a
 * statusMap is given, files carry their git status and directories are
 * marked when they contain changes.
 *
 * Throws the raw fs error (ENOENT/ENOTDIR) when relDir does not exist.
 */
export async function listDirectory(
  repoPath: string,
  relDir: string,
  options?: Partial<ListDirectoryOptions>,
  statusMap?: GitStatusMap
): Promise<DirEntry[]> {
  const hideHidden = options?.hideHidden ?? true;
  const hideGitignored = options?.hideGitignored ?? true;

  const fullPath = path.join(repoPath, relDir);
  const entries = await fs.promises.readdir(fullPath, { withFileTypes: true });

  // Build list of paths for gitignore check
  const pathsToCheck = entries.map((e) => (relDir ? path.join(relDir, e.name) : e.name));
  const ignoredFiles = hideGitignored
    ? await getIgnoredFiles(repoPath, pathsToCheck)
    : new Set<string>();

  const result: DirEntry[] = [];
  for (const entry of entries) {
    // Filter dot-prefixed hidden files
    if (hideHidden && entry.name.startsWith('.')) continue;

    const entryPath = relDir ? path.join(relDir, entry.name) : entry.name;

    // Filter gitignored files
    if (hideGitignored && ignoredFiles.has(entryPath)) continue;

    const isDir = entry.isDirectory();
    const dirEntry: DirEntry = {
      name: entry.name,
      path: entryPath,
      type: isDir ? 'dir' : 'file',
    };

    if (statusMap) {
      if (isDir) {
        if (statusMap.directories.has(entryPath)) dirEntry.hasChanges = true;
      } else {
        const status = statusMap.files.get(entryPath);
        if (status) {
          dirEntry.gitStatus = status.status;
          dirEntry.staged = status.staged;
        }
      }
    }

    result.push(dirEntry);
  }

  // Sort: directories first, then alphabetically
  result.sort((a, b) => {
    if (a.type === 'dir' && b.type !== 'dir') return -1;
    if (a.type !== 'dir' && b.type === 'dir') return 1;
    return a.name.localeCompare(b.name);
  });

  return result;
}

/**
 * Check if content appears to be binary.
 */
function isBinaryContent(buffer: Buffer): boolean {
  // Check first 8KB for null bytes (common in binary files)
  const checkLength = Math.min(buffer.length, 8192);
  for (let i = 0; i < checkLength; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

/**
 * Read a file for display. Returns flags instead of baking warnings into
 * content: binary and oversized files come back with empty content and the
 * matching flag set; text longer than MAX_DISPLAY_LINES is cut there with
 * truncated set (totalLines tells the caller how much was dropped).
 *
 * Throws the raw fs error (ENOENT, ENOTDIR) when relPath is unreadable and
 * NotRegularFileError when it is not a regular file (a FIFO/socket/device
 * would block the event loop on read; a directory is not displayable).
 *
 * Note on the truncated flag: it means exactly "content was cut at
 * MAX_DISPLAY_LINES". A merely large file (over the caller's warn
 * threshold) that fits within the line limit is NOT marked truncated —
 * unlike the pre-extraction TUI code, which conflated the two.
 */
export async function readFileForDisplay(
  repoPath: string,
  relPath: string
): Promise<FileForDisplay> {
  const fullPath = path.join(repoPath, relPath);
  const stats = await fs.promises.stat(fullPath);

  if (!stats.isFile()) {
    throw new NotRegularFileError(relPath);
  }

  if (stats.size > MAX_FILE_SIZE) {
    return {
      content: '',
      binary: false,
      truncated: false,
      tooLarge: true,
      size: stats.size,
      totalLines: 0,
    };
  }

  const buffer = await fs.promises.readFile(fullPath);

  if (isBinaryContent(buffer)) {
    return {
      content: '',
      binary: true,
      truncated: false,
      tooLarge: false,
      size: stats.size,
      totalLines: 0,
    };
  }

  let content = buffer.toString('utf-8');
  const lines = content.split('\n');
  let truncated = false;
  if (lines.length > MAX_DISPLAY_LINES) {
    content = lines.slice(0, MAX_DISPLAY_LINES).join('\n');
    truncated = true;
  }

  return {
    content,
    binary: false,
    truncated,
    tooLarge: false,
    size: stats.size,
    totalLines: lines.length,
  };
}
