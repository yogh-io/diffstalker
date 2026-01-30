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

export type CategoryName = 'modified' | 'untracked' | 'staged';

/**
 * Which category does flat index `i` fall in, and what's the position within it?
 * Flat order is: modified → untracked → staged.
 */
export function getCategoryForIndex(
  files: FileEntry[],
  index: number
): { category: CategoryName; categoryIndex: number } {
  const { modified, untracked } = categorizeFiles(files);
  const modLen = modified.length;
  const untLen = untracked.length;

  if (index < modLen) {
    return { category: 'modified', categoryIndex: index };
  }
  if (index < modLen + untLen) {
    return { category: 'untracked', categoryIndex: index - modLen };
  }
  return { category: 'staged', categoryIndex: index - modLen - untLen };
}

/**
 * Convert category + position back to a flat index (clamped).
 * If the target category is empty, falls back to last file overall, or 0 if no files.
 */
export function getIndexForCategoryPosition(
  files: FileEntry[],
  category: CategoryName,
  categoryIndex: number
): number {
  const { modified, untracked, staged, ordered } = categorizeFiles(files);
  if (ordered.length === 0) return 0;

  const categories = { modified, untracked, staged };
  const catFiles = categories[category];

  if (catFiles.length === 0) {
    return ordered.length - 1;
  }

  const clampedIndex = Math.min(categoryIndex, catFiles.length - 1);
  const offsets = {
    modified: 0,
    untracked: modified.length,
    staged: modified.length + untracked.length,
  };

  return offsets[category] + clampedIndex;
}
