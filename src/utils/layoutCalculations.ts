import { FileEntry } from '../git/status.js';

export interface PaneHeights {
  topPaneHeight: number;
  bottomPaneHeight: number;
}

/**
 * Calculate the heights of the top (file list) and bottom (diff/commit/etc) panes
 * based on the number of files and available content area.
 *
 * The top pane grows to fit files up to 40% of content height.
 * The bottom pane gets the remaining space.
 */
export function calculatePaneHeights(
  files: FileEntry[],
  contentHeight: number,
  maxTopRatio: number = 0.4
): PaneHeights {
  const unstagedCount = files.filter(f => !f.staged).length;
  const stagedCount = files.filter(f => f.staged).length;

  // Calculate content rows needed for staging area
  // 1 for "STAGING AREA" header
  // unstaged header + files (if any)
  // spacer (if both sections exist)
  // staged header + files (if any)
  let neededRows = 1; // "STAGING AREA" header
  if (unstagedCount > 0) neededRows += 1 + unstagedCount; // header + files
  if (stagedCount > 0) neededRows += 1 + stagedCount; // header + files
  if (unstagedCount > 0 && stagedCount > 0) neededRows += 1; // spacer

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
 */
export function getRowForFileIndex(
  selectedIndex: number,
  unstagedCount: number,
  stagedCount: number
): number {
  if (selectedIndex < unstagedCount) {
    // In unstaged section: header (0) + file rows
    return 1 + selectedIndex;
  } else {
    // In staged section
    const stagedIdx = selectedIndex - unstagedCount;
    return (unstagedCount > 0 ? 1 + unstagedCount : 0) // unstaged section
      + (unstagedCount > 0 && stagedCount > 0 ? 1 : 0) // spacer
      + 1 // staged header
      + stagedIdx;
  }
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
