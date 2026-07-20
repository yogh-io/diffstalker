import type { FileEntry } from '@diffstalker/core/git/status';
import type { FlatFileEntry } from '@diffstalker/core/view/flatFileList';
import { getFileAtIndex } from '@diffstalker/core/view/fileCategories';
import { getFlatFileAtIndex } from '@diffstalker/core/view/flatFileList';

/**
 * Resolve a FileEntry from an index, abstracting over flat vs categorized mode.
 * In flat mode, returns the unstaged entry (preferred) or staged entry.
 * In categorized mode, returns the file at the categorized index.
 */
export function resolveFileAtIndex(
  index: number,
  flatViewMode: boolean,
  flatFiles: FlatFileEntry[],
  files: FileEntry[]
): FileEntry | null {
  if (flatViewMode) {
    const flatEntry = getFlatFileAtIndex(flatFiles, index);
    return flatEntry?.unstagedEntry ?? flatEntry?.stagedEntry ?? null;
  }
  return getFileAtIndex(files, index);
}

/**
 * Get the maximum valid file index for the current view mode.
 */
export function getFileListMaxIndex(
  flatViewMode: boolean,
  flatFiles: FlatFileEntry[],
  files: FileEntry[]
): number {
  if (flatViewMode) {
    return flatFiles.length - 1;
  }
  return files.length - 1;
}
