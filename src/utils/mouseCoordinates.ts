import { FileEntry } from '../git/status.js';
import { BottomTab } from '../hooks/useKeymap.js';

export interface PaneBoundaries {
  stagingPaneStart: number;
  fileListEnd: number;
  separatorRow: number; // The row with the separator between panes (for drag resizing)
  diffPaneStart: number;
  diffPaneEnd: number;
  footerRow: number;
}

/**
 * Calculate the row boundaries for each pane in the layout.
 * Layout: Header (headerHeight) + sep (1) + top pane + sep (1) + bottom pane + sep (1) + footer (1)
 */
export function calculatePaneBoundaries(
  topPaneHeight: number,
  bottomPaneHeight: number,
  terminalHeight: number,
  headerHeight: number = 1
): PaneBoundaries {
  // Layout (1-indexed rows):
  // Rows 1 to headerHeight: Header
  // Row headerHeight+1: Separator
  // Row headerHeight+2: Top pane header ("STAGING AREA" or "COMMITS")
  // Rows headerHeight+3 to headerHeight+1+topPaneHeight: Top pane content
  const stagingPaneStart = headerHeight + 2; // First row of top pane (the header row)
  const fileListEnd = headerHeight + 1 + topPaneHeight; // Last row of top pane
  const separatorRow = fileListEnd + 1; // Separator between panes
  const diffPaneStart = fileListEnd + 2; // First row of bottom pane content
  const diffPaneEnd = diffPaneStart + bottomPaneHeight - 1;
  const footerRow = terminalHeight;

  return {
    stagingPaneStart,
    fileListEnd,
    separatorRow,
    diffPaneStart,
    diffPaneEnd,
    footerRow,
  };
}

/**
 * Given a y-coordinate in the file list area, calculate which file index was clicked.
 * Returns -1 if the click is not on a file.
 *
 * FileList layout: Modified → Untracked → Staged (with headers and spacers)
 */
export function getClickedFileIndex(
  y: number,
  scrollOffset: number,
  files: FileEntry[],
  stagingPaneStart: number,
  fileListEnd: number
): number {
  if (y < stagingPaneStart + 1 || y > fileListEnd) return -1;

  // Calculate which row in the list was clicked (0-indexed)
  const listRow = y - 4 + scrollOffset;

  // Split files into 3 categories (same order as FileList)
  const modifiedFiles = files.filter((f) => !f.staged && f.status !== 'untracked');
  const untrackedFiles = files.filter((f) => !f.staged && f.status === 'untracked');
  const stagedFiles = files.filter((f) => f.staged);

  // Build row map (same structure as FileList builds)
  // Each section: header (1) + files (n)
  // Spacer (1) between sections if previous section exists
  let currentRow = 0;
  let currentFileIndex = 0;

  // Modified section
  if (modifiedFiles.length > 0) {
    currentRow++; // "Modified:" header
    for (let i = 0; i < modifiedFiles.length; i++) {
      if (listRow === currentRow) {
        return currentFileIndex;
      }
      currentRow++;
      currentFileIndex++;
    }
  }

  // Untracked section
  if (untrackedFiles.length > 0) {
    if (modifiedFiles.length > 0) {
      currentRow++; // spacer
    }
    currentRow++; // "Untracked:" header
    for (let i = 0; i < untrackedFiles.length; i++) {
      if (listRow === currentRow) {
        return currentFileIndex;
      }
      currentRow++;
      currentFileIndex++;
    }
  }

  // Staged section
  if (stagedFiles.length > 0) {
    if (modifiedFiles.length > 0 || untrackedFiles.length > 0) {
      currentRow++; // spacer
    }
    currentRow++; // "Staged:" header
    for (let i = 0; i < stagedFiles.length; i++) {
      if (listRow === currentRow) {
        return currentFileIndex;
      }
      currentRow++;
      currentFileIndex++;
    }
  }

  return -1;
}

export interface TabBoundaries {
  diffStart: number;
  diffEnd: number;
  commitStart: number;
  commitEnd: number;
  historyStart: number;
  historyEnd: number;
  compareStart: number;
  compareEnd: number;
}

/**
 * Calculate the x-coordinate boundaries for each tab in the footer.
 * Tab layout (right-aligned): [1]Diff [2]Commit [3]History [4]Compare (39 chars total)
 */
export function getTabBoundaries(terminalWidth: number): TabBoundaries {
  const tabsStart = terminalWidth - 39; // 1-indexed start of tabs section
  return {
    diffStart: tabsStart,
    diffEnd: tabsStart + 6,
    commitStart: tabsStart + 8,
    commitEnd: tabsStart + 16,
    historyStart: tabsStart + 18,
    historyEnd: tabsStart + 27,
    compareStart: tabsStart + 29,
    compareEnd: tabsStart + 38,
  };
}

/**
 * Given an x-coordinate in the footer row, determine which tab was clicked.
 * Returns null if no tab was clicked.
 */
export function getClickedTab(x: number, terminalWidth: number): BottomTab | null {
  const bounds = getTabBoundaries(terminalWidth);

  if (x >= bounds.diffStart && x <= bounds.diffEnd) {
    return 'diff';
  } else if (x >= bounds.commitStart && x <= bounds.commitEnd) {
    return 'commit';
  } else if (x >= bounds.historyStart && x <= bounds.historyEnd) {
    return 'history';
  } else if (x >= bounds.compareStart && x <= bounds.compareEnd) {
    return 'compare';
  }
  return null;
}

/**
 * Check if a click is in the file button area (first 6 columns for stage/unstage toggle).
 */
export function isButtonAreaClick(x: number): boolean {
  return x <= 6;
}

/**
 * Check if a y-coordinate is within a given pane.
 */
export function isInPane(y: number, paneStart: number, paneEnd: number): boolean {
  return y >= paneStart && y <= paneEnd;
}

export type FooterLeftClick = 'hotkeys' | 'mouse-mode' | 'auto-tab' | null;

/**
 * Given an x-coordinate in the footer row, determine which left indicator was clicked.
 * Layout: "? hotkeys | [scroll] | [auto-tab:on]"
 *         1         11        21
 */
export function getFooterLeftClick(x: number): FooterLeftClick {
  // "?" and "hotkeys" area: columns 1-9
  if (x >= 1 && x <= 9) {
    return 'hotkeys';
  }
  // "[scroll]" or "[select]" area: columns 13-20
  if (x >= 13 && x <= 20) {
    return 'mouse-mode';
  }
  // "[auto-tab:on/off]" area: columns 24-38
  if (x >= 24 && x <= 38) {
    return 'auto-tab';
  }
  return null;
}
