import { FileEntry } from '../git/status.js';
import { getFileListSectionCounts } from './fileCategories.js';

export interface PaneHeights {
  topPaneHeight: number;
  bottomPaneHeight: number;
}

// Re-export for backwards compatibility
export { getFileListSectionCounts } from './fileCategories.js';

/**
 * Calculate total rows for the FileList component.
 * Accounts for headers and spacers between sections.
 */
export function getFileListTotalRows(files: FileEntry[]): number {
  const { modifiedCount, untrackedCount, stagedCount } = getFileListSectionCounts(files);

  let rows = 0;

  // Modified section
  if (modifiedCount > 0) {
    rows += 1 + modifiedCount; // header + files
  }

  // Untracked section
  if (untrackedCount > 0) {
    if (modifiedCount > 0) rows += 1; // spacer
    rows += 1 + untrackedCount; // header + files
  }

  // Staged section
  if (stagedCount > 0) {
    if (modifiedCount > 0 || untrackedCount > 0) rows += 1; // spacer
    rows += 1 + stagedCount; // header + files
  }

  return rows;
}

/**
 * Calculate the heights of the top (file list) and bottom (diff/commit/etc) panes
 * based on the number of files and available content area.
 *
 * The top pane grows to fit files up to 40% of content height.
 * The bottom pane gets the remaining space.
 *
 * When flatRowCount is provided (flat view mode), uses that directly instead
 * of computing row count from categorized file list.
 */
export function calculatePaneHeights(
  files: FileEntry[],
  contentHeight: number,
  maxTopRatio: number = 0.4,
  flatRowCount?: number
): PaneHeights {
  // Calculate content rows needed for staging area
  const neededRows = flatRowCount !== undefined ? flatRowCount : getFileListTotalRows(files);

  // Minimum height of 3 (header + 2 lines for empty state)
  const minHeight = 3;
  // Maximum is maxTopRatio of content area
  const maxHeight = Math.floor(contentHeight * maxTopRatio);
  // Use the smaller of needed or max, but at least min
  const topHeight = Math.max(minHeight, Math.min(neededRows, maxHeight));
  const bottomHeight = contentHeight - topHeight;

  return { topPaneHeight: topHeight, bottomPaneHeight: bottomHeight };
}

/**
 * Calculate which row in the file list a file at a given index occupies.
 * This accounts for headers and spacers in the list.
 * File order: Modified → Untracked → Staged (matches FileList.tsx)
 */
export function getRowForFileIndex(
  selectedIndex: number,
  modifiedCount: number,
  untrackedCount: number,
  _stagedCount: number
): number {
  let row = 0;

  // Modified section
  if (selectedIndex < modifiedCount) {
    // In modified section: header + file rows
    return 1 + selectedIndex;
  }
  if (modifiedCount > 0) {
    row += 1 + modifiedCount; // header + files
  }

  // Untracked section
  const untrackedStart = modifiedCount;
  if (selectedIndex < untrackedStart + untrackedCount) {
    // In untracked section
    const untrackedIdx = selectedIndex - untrackedStart;
    if (modifiedCount > 0) row += 1; // spacer
    return row + 1 + untrackedIdx; // header + file position
  }
  if (untrackedCount > 0) {
    if (modifiedCount > 0) row += 1; // spacer
    row += 1 + untrackedCount; // header + files
  }

  // Staged section
  const stagedStart = modifiedCount + untrackedCount;
  const stagedIdx = selectedIndex - stagedStart;
  if (modifiedCount > 0 || untrackedCount > 0) row += 1; // spacer
  return row + 1 + stagedIdx; // header + file position
}

/**
 * Calculate the scroll offset needed to keep a selected row visible.
 */
export function calculateScrollOffset(
  selectedRow: number,
  currentScrollOffset: number,
  visibleHeight: number
): number {
  // Scroll up if selected is above visible area
  if (selectedRow < currentScrollOffset) {
    return Math.max(0, selectedRow - 1);
  }
  // Scroll down if selected is below visible area
  else if (selectedRow >= currentScrollOffset + visibleHeight) {
    return selectedRow - visibleHeight + 1;
  }
  return currentScrollOffset;
}
