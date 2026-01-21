import { FileEntry } from '../git/status.js';

/**
 * Categorize files into Modified, Untracked, and Staged sections.
 * Order: Modified → Untracked → Staged (consistent throughout the app)
 */
export interface CategorizedFiles {
  modified: FileEntry[];
  untracked: FileEntry[];
  staged: FileEntry[];
  /** All files in display order: modified → untracked → staged */
  ordered: FileEntry[];
}

/**
 * Categorize files into the three FileList sections.
 * This is the single source of truth for file categorization.
 */
export function categorizeFiles(files: FileEntry[]): CategorizedFiles {
  const modified = files.filter((f) => !f.staged && f.status !== 'untracked');
  const untracked = files.filter((f) => !f.staged && f.status === 'untracked');
  const staged = files.filter((f) => f.staged);

  return {
    modified,
    untracked,
    staged,
    ordered: [...modified, ...untracked, ...staged],
  };
}

/**
 * Get file counts for the 3 FileList sections.
 */
export function getFileListSectionCounts(files: FileEntry[]): {
  modifiedCount: number;
  untrackedCount: number;
  stagedCount: number;
} {
  const { modified, untracked, staged } = categorizeFiles(files);
  return {
    modifiedCount: modified.length,
    untrackedCount: untracked.length,
    stagedCount: staged.length,
  };
}
