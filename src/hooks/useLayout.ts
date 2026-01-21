import { useState, useEffect, useMemo, useCallback } from 'react';
import { FileEntry } from '../git/status.js';
import { DiffResult } from '../git/diff.js';
import { BottomTab } from './useKeymap.js';
import {
  getRowForFileIndex,
  calculateScrollOffset,
  getFileListSectionCounts,
  getFileListTotalRows,
} from '../utils/layoutCalculations.js';
import { calculatePaneBoundaries, PaneBoundaries } from '../utils/mouseCoordinates.js';

// Layout constants (compact: single-line separators)
// Header (1) + sep (1) + sep (1) + sep (1) + footer (1) = 5 lines overhead
// Note: Header can be 2 lines when follow indicator causes branch to wrap
export const LAYOUT_OVERHEAD = 5;

// Default split ratios for different modes
const DEFAULT_SPLIT_RATIOS: Record<BottomTab, number> = {
  diff: 0.4, // 40% top pane for staging area
  commit: 0.4, // 40% top pane for staging area
  history: 0.5, // 50% top pane for commit list (larger default)
  compare: 0.5, // 50% top pane for compare list (larger default)
};

// Step size for keyboard-based pane resizing (5% per keypress)
export const SPLIT_RATIO_STEP = 0.05;

export interface UseLayoutResult {
  // Pane dimensions
  topPaneHeight: number;
  bottomPaneHeight: number;
  contentHeight: number;

  // Pane boundaries for mouse handling
  paneBoundaries: PaneBoundaries;

  // Split ratio control
  splitRatio: number;
  setSplitRatio: (ratio: number) => void;
  adjustSplitRatio: (delta: number) => void;

  // Scroll state
  fileListScrollOffset: number;
  diffScrollOffset: number;
  historyScrollOffset: number;
  compareScrollOffset: number;

  // Scroll setters
  setFileListScrollOffset: React.Dispatch<React.SetStateAction<number>>;
  setDiffScrollOffset: React.Dispatch<React.SetStateAction<number>>;
  setHistoryScrollOffset: React.Dispatch<React.SetStateAction<number>>;
  setCompareScrollOffset: React.Dispatch<React.SetStateAction<number>>;

  // Scroll helpers
  scrollDiff: (direction: 'up' | 'down', amount?: number, maxRows?: number) => void;
  scrollFileList: (direction: 'up' | 'down', amount?: number) => void;
  scrollHistory: (direction: 'up' | 'down', amount?: number, totalItems?: number) => void;
  scrollCompare: (direction: 'up' | 'down', totalRows: number, amount?: number) => void;
}

export function useLayout(
  terminalHeight: number,
  terminalWidth: number,
  files: FileEntry[],
  selectedIndex: number,
  diff: DiffResult | null,
  mode: BottomTab = 'diff',
  historySelectedIndex?: number,
  initialSplitRatio?: number,
  extraOverhead: number = 0
): UseLayoutResult {
  // Calculate content height (terminal minus overhead)
  const contentHeight = terminalHeight - LAYOUT_OVERHEAD - extraOverhead;

  // Custom split ratio state (null means use default for mode)
  const [customSplitRatio, setCustomSplitRatio] = useState<number | null>(
    initialSplitRatio ?? null
  );

  // Get the effective split ratio
  const effectiveSplitRatio = customSplitRatio ?? DEFAULT_SPLIT_RATIOS[mode];

  // Calculate pane heights based on custom ratio or mode default
  const { topPaneHeight, bottomPaneHeight } = useMemo(() => {
    // Apply the split ratio directly
    const minHeight = 5;
    const maxHeight = contentHeight - minHeight; // Leave at least minHeight for bottom pane
    const targetHeight = Math.floor(contentHeight * effectiveSplitRatio);
    const topHeight = Math.max(minHeight, Math.min(targetHeight, maxHeight));
    const bottomHeight = contentHeight - topHeight;
    return { topPaneHeight: topHeight, bottomPaneHeight: bottomHeight };
  }, [contentHeight, effectiveSplitRatio]);

  // Setter for split ratio with bounds checking
  const setSplitRatio = useCallback((ratio: number) => {
    // Clamp ratio between 0.15 and 0.85 to ensure both panes remain usable
    const clampedRatio = Math.max(0.15, Math.min(0.85, ratio));
    setCustomSplitRatio(clampedRatio);
  }, []);

  // Adjust split ratio by delta (for keyboard-based resizing)
  const adjustSplitRatio = useCallback(
    (delta: number) => {
      const currentRatio = customSplitRatio ?? DEFAULT_SPLIT_RATIOS[mode];
      const newRatio = Math.max(0.15, Math.min(0.85, currentRatio + delta));
      setCustomSplitRatio(newRatio);
    },
    [customSplitRatio, mode]
  );

  // Expose current split ratio
  const splitRatio = effectiveSplitRatio;

  // Calculate pane boundaries for mouse handling
  // extraOverhead = headerHeight - 1, so headerHeight = extraOverhead + 1
  const headerHeight = extraOverhead + 1;
  const paneBoundaries = useMemo(
    () => calculatePaneBoundaries(topPaneHeight, bottomPaneHeight, terminalHeight, headerHeight),
    [topPaneHeight, bottomPaneHeight, terminalHeight, headerHeight]
  );

  // Scroll state
  const [fileListScrollOffset, setFileListScrollOffset] = useState(0);
  const [diffScrollOffset, setDiffScrollOffset] = useState(0);
  const [historyScrollOffset, setHistoryScrollOffset] = useState(0);
  const [compareScrollOffset, setCompareScrollOffset] = useState(0);

  // Reset file list scroll when files change
  useEffect(() => {
    setFileListScrollOffset(0);
  }, [files.length]);

  // Reset diff scroll when diff changes
  useEffect(() => {
    setDiffScrollOffset(0);
  }, [diff]);

  // Auto-scroll file list to keep selected item visible (only when selection changes)
  useEffect(() => {
    const { modifiedCount, untrackedCount, stagedCount } = getFileListSectionCounts(files);

    const selectedRow = getRowForFileIndex(
      selectedIndex,
      modifiedCount,
      untrackedCount,
      stagedCount
    );
    const visibleHeight = topPaneHeight - 1;

    setFileListScrollOffset((prev) => {
      const newOffset = calculateScrollOffset(selectedRow, prev, visibleHeight);
      return newOffset;
    });
  }, [selectedIndex, files, topPaneHeight]);

  // Scroll helpers
  const scrollDiff = useCallback(
    (direction: 'up' | 'down', amount: number = 3, maxRows?: number) => {
      // Use provided maxRows or fall back to diff line count
      const totalRows = maxRows ?? diff?.lines.length ?? 0;
      const maxOffset = Math.max(0, totalRows - (bottomPaneHeight - 4));
      setDiffScrollOffset((prev) => {
        if (direction === 'up') {
          return Math.max(0, prev - amount);
        } else {
          return Math.min(maxOffset, prev + amount);
        }
      });
    },
    [diff?.lines.length, bottomPaneHeight]
  );

  const scrollFileList = useCallback(
    (direction: 'up' | 'down', amount: number = 3) => {
      const totalRows = getFileListTotalRows(files);
      const visibleRows = topPaneHeight - 1;
      const maxScroll = Math.max(0, totalRows - visibleRows);

      setFileListScrollOffset((prev) => {
        if (direction === 'up') {
          return Math.max(0, prev - amount);
        } else {
          return Math.min(maxScroll, prev + amount);
        }
      });
    },
    [files, topPaneHeight]
  );

  const scrollHistory = useCallback(
    (direction: 'up' | 'down', totalItems: number = 0, amount: number = 3) => {
      // History is in top pane, so use topPaneHeight - 1 for visible area
      const maxOffset = Math.max(0, totalItems - (topPaneHeight - 1));
      setHistoryScrollOffset((prev) => {
        if (direction === 'up') {
          return Math.max(0, prev - amount);
        } else {
          return Math.min(maxOffset, prev + amount);
        }
      });
    },
    [topPaneHeight]
  );

  const scrollCompare = useCallback(
    (direction: 'up' | 'down', totalRows: number, amount: number = 3) => {
      // Compare list is in top pane, so use topPaneHeight - 1 for visible area
      const maxOffset = Math.max(0, totalRows - (topPaneHeight - 1));
      setCompareScrollOffset((prev) => {
        if (direction === 'up') {
          return Math.max(0, prev - amount);
        } else {
          return Math.min(maxOffset, prev + amount);
        }
      });
    },
    [topPaneHeight]
  );

  return {
    topPaneHeight,
    bottomPaneHeight,
    contentHeight,
    paneBoundaries,
    splitRatio,
    setSplitRatio,
    adjustSplitRatio,
    fileListScrollOffset,
    diffScrollOffset,
    historyScrollOffset,
    compareScrollOffset,
    setFileListScrollOffset,
    setDiffScrollOffset,
    setHistoryScrollOffset,
    setCompareScrollOffset,
    scrollDiff,
    scrollFileList,
    scrollHistory,
    scrollCompare,
  };
}
