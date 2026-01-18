import { useState, useEffect, useMemo, useCallback } from 'react';
import { FileEntry } from '../git/status.js';
import { DiffResult } from '../git/diff.js';
import {
  calculatePaneHeights,
  getRowForFileIndex,
  calculateScrollOffset,
} from '../utils/layoutCalculations.js';
import {
  calculatePaneBoundaries,
  PaneBoundaries,
} from '../utils/mouseCoordinates.js';

// Layout constants (compact: single-line separators)
// Header (1) + sep (1) + sep (1) + sep (1) + footer (1) = 5 lines overhead
export const LAYOUT_OVERHEAD = 5;

export interface UseLayoutResult {
  // Pane dimensions
  topPaneHeight: number;
  bottomPaneHeight: number;
  contentHeight: number;

  // Pane boundaries for mouse handling
  paneBoundaries: PaneBoundaries;

  // Scroll state
  fileListScrollOffset: number;
  diffScrollOffset: number;
  historyScrollOffset: number;
  prScrollOffset: number;

  // Scroll setters
  setFileListScrollOffset: React.Dispatch<React.SetStateAction<number>>;
  setDiffScrollOffset: React.Dispatch<React.SetStateAction<number>>;
  setHistoryScrollOffset: React.Dispatch<React.SetStateAction<number>>;
  setPRScrollOffset: React.Dispatch<React.SetStateAction<number>>;

  // Scroll helpers
  scrollDiff: (direction: 'up' | 'down', amount?: number) => void;
  scrollFileList: (direction: 'up' | 'down', amount?: number) => void;
  scrollHistory: (direction: 'up' | 'down', amount?: number, totalItems?: number) => void;
  scrollPR: (direction: 'up' | 'down', totalRows: number, amount?: number) => void;
}

export function useLayout(
  terminalHeight: number,
  terminalWidth: number,
  files: FileEntry[],
  selectedIndex: number,
  diff: DiffResult | null,
  historySelectedIndex?: number
): UseLayoutResult {
  // Calculate content height (terminal minus overhead)
  const contentHeight = terminalHeight - LAYOUT_OVERHEAD;

  // Calculate pane heights based on files
  const { topPaneHeight, bottomPaneHeight } = useMemo(
    () => calculatePaneHeights(files, contentHeight),
    [files, contentHeight]
  );

  // Calculate pane boundaries for mouse handling
  const paneBoundaries = useMemo(
    () => calculatePaneBoundaries(topPaneHeight, bottomPaneHeight, terminalHeight),
    [topPaneHeight, bottomPaneHeight, terminalHeight]
  );

  // Scroll state
  const [fileListScrollOffset, setFileListScrollOffset] = useState(0);
  const [diffScrollOffset, setDiffScrollOffset] = useState(0);
  const [historyScrollOffset, setHistoryScrollOffset] = useState(0);
  const [prScrollOffset, setPRScrollOffset] = useState(0);

  // Reset file list scroll when files change
  useEffect(() => {
    setFileListScrollOffset(0);
  }, [files.length]);

  // Reset diff scroll when diff changes
  useEffect(() => {
    setDiffScrollOffset(0);
  }, [diff]);

  // Auto-scroll file list to keep selected item visible
  useEffect(() => {
    const unstagedCount = files.filter(f => !f.staged).length;
    const stagedCount = files.filter(f => f.staged).length;

    const selectedRow = getRowForFileIndex(selectedIndex, unstagedCount, stagedCount);
    const visibleHeight = topPaneHeight - 1;

    const newOffset = calculateScrollOffset(selectedRow, fileListScrollOffset, visibleHeight);
    if (newOffset !== fileListScrollOffset) {
      setFileListScrollOffset(newOffset);
    }
  }, [selectedIndex, files, topPaneHeight, fileListScrollOffset]);

  // Scroll helpers
  const scrollDiff = useCallback((direction: 'up' | 'down', amount: number = 3) => {
    const maxOffset = Math.max(0, (diff?.lines.length ?? 0) - (bottomPaneHeight - 4));
    setDiffScrollOffset(prev => {
      if (direction === 'up') {
        return Math.max(0, prev - amount);
      } else {
        return Math.min(maxOffset, prev + amount);
      }
    });
  }, [diff?.lines.length, bottomPaneHeight]);

  const scrollFileList = useCallback((direction: 'up' | 'down', amount: number = 3) => {
    const unstagedCount = files.filter(f => !f.staged).length;
    const stagedCount = files.filter(f => f.staged).length;

    let totalRows = 0;
    if (unstagedCount > 0) totalRows += 1 + unstagedCount;
    if (stagedCount > 0) totalRows += 1 + stagedCount;
    if (unstagedCount > 0 && stagedCount > 0) totalRows += 1;

    const visibleRows = topPaneHeight - 1;
    const maxScroll = Math.max(0, totalRows - visibleRows);

    setFileListScrollOffset(prev => {
      if (direction === 'up') {
        return Math.max(0, prev - amount);
      } else {
        return Math.min(maxScroll, prev + amount);
      }
    });
  }, [files, topPaneHeight]);

  const scrollHistory = useCallback((direction: 'up' | 'down', totalItems: number = 0, amount: number = 3) => {
    const maxOffset = Math.max(0, totalItems - (bottomPaneHeight - 2));
    setHistoryScrollOffset(prev => {
      if (direction === 'up') {
        return Math.max(0, prev - amount);
      } else {
        return Math.min(maxOffset, prev + amount);
      }
    });
  }, [bottomPaneHeight]);

  const scrollPR = useCallback((direction: 'up' | 'down', totalRows: number, amount: number = 3) => {
    const maxOffset = Math.max(0, totalRows - (bottomPaneHeight - 4));
    setPRScrollOffset(prev => {
      if (direction === 'up') {
        return Math.max(0, prev - amount);
      } else {
        return Math.min(maxOffset, prev + amount);
      }
    });
  }, [bottomPaneHeight]);

  return {
    topPaneHeight,
    bottomPaneHeight,
    contentHeight,
    paneBoundaries,
    fileListScrollOffset,
    diffScrollOffset,
    historyScrollOffset,
    prScrollOffset,
    setFileListScrollOffset,
    setDiffScrollOffset,
    setHistoryScrollOffset,
    setPRScrollOffset,
    scrollDiff,
    scrollFileList,
    scrollHistory,
    scrollPR,
  };
}
