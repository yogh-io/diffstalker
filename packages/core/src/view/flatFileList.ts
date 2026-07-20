import type { FileEntry, FileStatus } from '../git/status.js';
import type { FileHunkCounts } from '../git/diff.js';

export type StagingState = 'unstaged' | 'staged' | 'partial';

export interface FlatFileEntry {
  path: string;
  status: FileStatus;
  stagingState: StagingState;
  stagedHunks: number;
  totalHunks: number;
  insertions?: number;
  deletions?: number;
  originalPath?: string;
  stagedEntry: FileEntry | null;
  unstagedEntry: FileEntry | null;
}

/**
 * Build a deduplicated, alphabetically sorted flat file list.
 * Files that appear in both staged and unstaged are merged into one entry
 * with stagingState 'partial'.
 */
export function buildFlatFileList(
  files: FileEntry[],
  hunkCounts: FileHunkCounts | null
): FlatFileEntry[] {
  // Group by path
  const byPath = new Map<string, { staged: FileEntry | null; unstaged: FileEntry | null }>();

  for (const file of files) {
    const existing = byPath.get(file.path) ?? { staged: null, unstaged: null };
    if (file.staged) {
      existing.staged = file;
    } else {
      existing.unstaged = file;
    }
    byPath.set(file.path, existing);
  }

  const result: FlatFileEntry[] = [];

  for (const [filePath, { staged, unstaged }] of byPath) {
    const stagedHunks = hunkCounts?.staged.get(filePath) ?? 0;
    const unstagedHunks = hunkCounts?.unstaged.get(filePath) ?? 0;
    const totalHunks = stagedHunks + unstagedHunks;

    let stagingState: StagingState;
    if (staged && unstaged) {
      stagingState = 'partial';
    } else if (staged) {
      stagingState = 'staged';
    } else {
      stagingState = 'unstaged';
    }

    // Use the unstaged entry as primary (for status), fall back to staged
    const primary = unstaged ?? staged!;

    // Combine insertions/deletions from both entries
    let insertions: number | undefined;
    let deletions: number | undefined;
    if (staged?.insertions !== undefined || unstaged?.insertions !== undefined) {
      insertions = (staged?.insertions ?? 0) + (unstaged?.insertions ?? 0);
    }
    if (staged?.deletions !== undefined || unstaged?.deletions !== undefined) {
      deletions = (staged?.deletions ?? 0) + (unstaged?.deletions ?? 0);
    }

    result.push({
      path: filePath,
      status: primary.status,
      stagingState,
      stagedHunks,
      totalHunks,
      insertions,
      deletions,
      originalPath: primary.originalPath,
      stagedEntry: staged,
      unstagedEntry: unstaged,
    });
  }

  // Sort alphabetically by path
  result.sort((a, b) => a.path.localeCompare(b.path));

  return result;
}

export function getFlatFileAtIndex(
  flatFiles: FlatFileEntry[],
  index: number
): FlatFileEntry | null {
  return flatFiles[index] ?? null;
}

export function getFlatFileIndexByPath(flatFiles: FlatFileEntry[], path: string): number {
  return flatFiles.findIndex((f) => f.path === path);
}
