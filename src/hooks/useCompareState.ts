import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { CompareDiff } from '../git/diff.js';
import { CompareListSelection, getCompareListTotalRows } from '../components/CompareListView.js';
import { getCompareItemIndexFromRow, getFileScrollOffset } from '../utils/rowCalculations.js';
import {
  buildCompareDisplayRows,
  getDisplayRowsLineNumWidth,
  getWrappedRowCount,
} from '../utils/displayRows.js';

interface UseCompareStateProps {
  repoPath: string;
  isActive: boolean; // bottomTab === 'compare'
  compareDiff: CompareDiff | null;
  refreshCompareDiff: (includeUncommitted: boolean) => Promise<void>;
  getCandidateBaseBranches: () => Promise<string[]>;
  setCompareBaseBranch: (branch: string, includeUncommitted: boolean) => void;
  selectCompareCommit: (index: number) => void;
  topPaneHeight: number;
  compareScrollOffset: number;
  setCompareScrollOffset: (offset: number) => void;
  setDiffScrollOffset: (offset: number) => void;
  status: unknown; // Trigger refresh when status changes
  wrapMode: boolean;
  terminalWidth: number;
}

export interface UseCompareStateResult {
  // State
  includeUncommitted: boolean;
  compareListSelection: CompareListSelection | null;
  compareSelectedIndex: number;
  baseBranchCandidates: string[];
  showBaseBranchPicker: boolean;
  compareTotalItems: number;
  compareListTotalRows: number;
  compareDiffTotalRows: number;

  // Setters
  setCompareSelectedIndex: React.Dispatch<React.SetStateAction<number>>;

  // Handlers
  toggleIncludeUncommitted: () => void;
  openBaseBranchPicker: () => void;
  closeBaseBranchPicker: () => void;
  selectBaseBranch: (branch: string) => void;
  navigateCompareUp: () => void;
  navigateCompareDown: () => void;
  markSelectionInitialized: () => void;

  // For click handling
  getItemIndexFromRow: (visualRow: number) => number;
}

export function useCompareState({
  repoPath,
  isActive,
  compareDiff,
  refreshCompareDiff,
  getCandidateBaseBranches,
  setCompareBaseBranch,
  selectCompareCommit,
  topPaneHeight,
  compareScrollOffset,
  setCompareScrollOffset,
  setDiffScrollOffset,
  status,
  wrapMode,
  terminalWidth,
}: UseCompareStateProps): UseCompareStateResult {
  const [includeUncommitted, setIncludeUncommitted] = useState(true);
  const [compareListSelection, setCompareListSelection] = useState<CompareListSelection | null>(
    null
  );
  const [compareSelectedIndex, setCompareSelectedIndex] = useState(0);
  const compareSelectionInitialized = useRef(false);
  const [baseBranchCandidates, setBaseBranchCandidates] = useState<string[]>([]);
  const [showBaseBranchPicker, setShowBaseBranchPicker] = useState(false);

  // Fetch compare diff when tab becomes active
  useEffect(() => {
    if (repoPath && isActive) {
      refreshCompareDiff(includeUncommitted);
    }
  }, [repoPath, isActive, status, refreshCompareDiff, includeUncommitted]);

  // Fetch base branch candidates when entering compare view
  useEffect(() => {
    if (repoPath && isActive) {
      getCandidateBaseBranches().then(setBaseBranchCandidates);
    }
  }, [repoPath, isActive, getCandidateBaseBranches]);

  // Reset compare selection state when entering compare tab
  useEffect(() => {
    if (isActive) {
      compareSelectionInitialized.current = false;
      setCompareListSelection(null);
      setDiffScrollOffset(0);
    }
  }, [isActive, setDiffScrollOffset]);

  // Update compare selection when compareSelectedIndex changes (only after user interaction)
  useEffect(() => {
    if (isActive && compareDiff && compareSelectionInitialized.current) {
      const commitCount = compareDiff.commits.length;
      const fileCount = compareDiff.files.length;

      if (compareSelectedIndex < commitCount) {
        setCompareListSelection({ type: 'commit', index: compareSelectedIndex });
        selectCompareCommit(compareSelectedIndex);
        setDiffScrollOffset(0);
      } else if (compareSelectedIndex < commitCount + fileCount) {
        const fileIndex = compareSelectedIndex - commitCount;
        setCompareListSelection({ type: 'file', index: fileIndex });
        const scrollTo = getFileScrollOffset(compareDiff, fileIndex);
        setDiffScrollOffset(scrollTo);
      }
    }
  }, [isActive, compareDiff, compareSelectedIndex, selectCompareCommit, setDiffScrollOffset]);

  // Computed values
  const compareTotalItems = useMemo(() => {
    if (!compareDiff) return 0;
    return compareDiff.commits.length + compareDiff.files.length;
  }, [compareDiff]);

  // Total rows including headers and spacers (for scroll indicator offset calculation)
  const compareListTotalRows = useMemo(() => {
    if (!compareDiff) return 0;
    return getCompareListTotalRows(compareDiff.commits, compareDiff.files);
  }, [compareDiff]);

  // When wrap mode is enabled, account for wrapped lines
  const compareDiffTotalRows = useMemo(() => {
    const displayRows = buildCompareDisplayRows(compareDiff);
    if (!wrapMode) return displayRows.length;

    const lineNumWidth = getDisplayRowsLineNumWidth(displayRows);
    const contentWidth = terminalWidth - lineNumWidth - 5;
    return getWrappedRowCount(displayRows, contentWidth, true);
  }, [compareDiff, wrapMode, terminalWidth]);

  // Handlers
  const toggleIncludeUncommitted = useCallback(() => {
    setIncludeUncommitted((prev) => !prev);
  }, []);

  const openBaseBranchPicker = useCallback(() => {
    setShowBaseBranchPicker(true);
  }, []);

  const closeBaseBranchPicker = useCallback(() => {
    setShowBaseBranchPicker(false);
  }, []);

  const selectBaseBranch = useCallback(
    (branch: string) => {
      setShowBaseBranchPicker(false);
      setCompareBaseBranch(branch, includeUncommitted);
    },
    [setCompareBaseBranch, includeUncommitted]
  );

  const markSelectionInitialized = useCallback(() => {
    compareSelectionInitialized.current = true;
  }, []);

  const navigateCompareUp = useCallback(() => {
    compareSelectionInitialized.current = true;
    setCompareSelectedIndex((prev) => {
      const newIndex = Math.max(0, prev - 1);
      if (newIndex < compareScrollOffset) setCompareScrollOffset(newIndex);
      return newIndex;
    });
  }, [compareScrollOffset, setCompareScrollOffset]);

  const navigateCompareDown = useCallback(() => {
    compareSelectionInitialized.current = true;
    setCompareSelectedIndex((prev) => {
      const newIndex = Math.min(compareTotalItems - 1, prev + 1);
      const visibleEnd = compareScrollOffset + topPaneHeight - 2;
      if (newIndex >= visibleEnd) setCompareScrollOffset(compareScrollOffset + 1);
      return newIndex;
    });
  }, [compareTotalItems, compareScrollOffset, topPaneHeight, setCompareScrollOffset]);

  const getItemIndexFromRow = useCallback(
    (visualRow: number) => {
      if (!compareDiff) return -1;
      return getCompareItemIndexFromRow(
        visualRow,
        compareDiff.commits.length,
        compareDiff.files.length
      );
    },
    [compareDiff]
  );

  return {
    includeUncommitted,
    compareListSelection,
    compareSelectedIndex,
    baseBranchCandidates,
    showBaseBranchPicker,
    compareTotalItems,
    compareListTotalRows,
    compareDiffTotalRows,
    setCompareSelectedIndex,
    toggleIncludeUncommitted,
    openBaseBranchPicker,
    closeBaseBranchPicker,
    selectBaseBranch,
    navigateCompareUp,
    navigateCompareDown,
    markSelectionInitialized,
    getItemIndexFromRow,
  };
}
