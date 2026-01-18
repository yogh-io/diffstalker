import { FileEntry } from '../git/status.js';
import { BottomTab } from '../hooks/useKeymap.js';

export interface PaneBoundaries {
  stagingPaneStart: number;
  fileListEnd: number;
  diffPaneStart: number;
  diffPaneEnd: number;
  footerRow: number;
}

/**
 * Calculate the row boundaries for each pane in the layout.
 * Uses compact layout: Header (1) + sep (1) + staging pane + sep (1) + bottom pane + sep (1) + footer (1)
 */
export function calculatePaneBoundaries(
  topPaneHeight: number,
  bottomPaneHeight: number,
  terminalHeight: number
): PaneBoundaries {
  // Row 1: Header, Row 2: Sep, Row 3: "STAGING AREA" header, Row 4+: FileList content
  const stagingPaneStart = 3;
  const fileListEnd = 2 + topPaneHeight; // header + sep + staging pane
  const diffPaneStart = fileListEnd + 2; // after staging pane + sep + diff header
  const diffPaneEnd = diffPaneStart + bottomPaneHeight - 1;
  const footerRow = terminalHeight;

  return {
    stagingPaneStart,
    fileListEnd,
    diffPaneStart,
    diffPaneEnd,
    footerRow,
  };
}

/**
 * Given a y-coordinate in the file list area, calculate which file index was clicked.
 * Returns -1 if the click is not on a file.
 */
export function getClickedFileIndex(
  y: number,
  scrollOffset: number,
  files: FileEntry[],
  stagingPaneStart: number,
  fileListEnd: number
): number {
  if (y < stagingPaneStart + 1 || y > fileListEnd) return -1;

  const listRow = (y - 4) + scrollOffset;
  const unstagedFiles = files.filter(f => !f.staged);
  const stagedFiles = files.filter(f => f.staged);

  if (unstagedFiles.length > 0 && stagedFiles.length > 0) {
    const firstUnstagedFileRow = 1;
    const lastUnstagedFileRow = unstagedFiles.length;
    const spacerRow = lastUnstagedFileRow + 1;
    const stagedHeaderRow = spacerRow + 1;
    const firstStagedFileRow = stagedHeaderRow + 1;

    if (listRow >= firstUnstagedFileRow && listRow <= lastUnstagedFileRow) {
      return listRow - firstUnstagedFileRow;
    } else if (listRow >= firstStagedFileRow) {
      const stagedIdx = listRow - firstStagedFileRow;
      if (stagedIdx < stagedFiles.length) {
        return unstagedFiles.length + stagedIdx;
      }
    }
  } else if (unstagedFiles.length > 0) {
    if (listRow >= 1 && listRow <= unstagedFiles.length) {
      return listRow - 1;
    }
  } else if (stagedFiles.length > 0) {
    if (listRow >= 1 && listRow <= stagedFiles.length) {
      return listRow - 1;
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
  prStart: number;
  prEnd: number;
}

/**
 * Calculate the x-coordinate boundaries for each tab in the footer.
 * Tab layout (right-aligned): [1]Diff [2]Commit [3]History [4]PR (35 chars total)
 */
export function getTabBoundaries(terminalWidth: number): TabBoundaries {
  const tabsStart = terminalWidth - 34; // 1-indexed start of tabs section
  return {
    diffStart: tabsStart,
    diffEnd: tabsStart + 7,
    commitStart: tabsStart + 8,
    commitEnd: tabsStart + 17,
    historyStart: tabsStart + 18,
    historyEnd: tabsStart + 28,
    prStart: tabsStart + 29,
    prEnd: tabsStart + 34,
  };
}

/**
 * Given an x-coordinate in the footer row, determine which tab was clicked.
 * Returns null if no tab was clicked.
 */
export function getClickedTab(
  x: number,
  terminalWidth: number
): BottomTab | null {
  const bounds = getTabBoundaries(terminalWidth);

  if (x >= bounds.diffStart && x <= bounds.diffEnd) {
    return 'diff';
  } else if (x >= bounds.commitStart && x <= bounds.commitEnd) {
    return 'commit';
  } else if (x >= bounds.historyStart && x <= bounds.historyEnd) {
    return 'history';
  } else if (x >= bounds.prStart && x <= bounds.prEnd) {
    return 'pr';
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
