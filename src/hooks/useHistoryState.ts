import { useState, useEffect, useCallback, useMemo } from 'react';
import { CommitInfo, getCommitHistory } from '../git/status.js';
import { DiffResult } from '../git/diff.js';
import {
  buildHistoryDisplayRows,
  getDisplayRowsLineNumWidth,
  getWrappedRowCount,
} from '../utils/displayRows.js';

interface UseHistoryStateProps {
  repoPath: string;
  isActive: boolean; // bottomTab === 'history'
  selectHistoryCommit: (commit: CommitInfo) => void;
  historyCommitDiff: DiffResult | null;
  historySelectedCommit: CommitInfo | null;
  topPaneHeight: number;
  historyScrollOffset: number;
  setHistoryScrollOffset: (offset: number) => void;
  setDiffScrollOffset: (offset: number) => void;
  status: unknown; // Trigger refresh when status changes
  wrapMode: boolean;
  terminalWidth: number;
}

export interface UseHistoryStateResult {
  commits: CommitInfo[];
  historySelectedIndex: number;
  setHistorySelectedIndex: React.Dispatch<React.SetStateAction<number>>;
  historyDiffTotalRows: number;
  navigateHistoryUp: () => void;
  navigateHistoryDown: () => void;
  historyTotalRows: number;
}

export function useHistoryState({
  repoPath,
  isActive,
  selectHistoryCommit,
  historyCommitDiff,
  historySelectedCommit,
  topPaneHeight,
  historyScrollOffset,
  setHistoryScrollOffset,
  setDiffScrollOffset,
  status,
  wrapMode,
  terminalWidth,
}: UseHistoryStateProps): UseHistoryStateResult {
  const [commits, setCommits] = useState<CommitInfo[]>([]);
  const [historySelectedIndex, setHistorySelectedIndex] = useState(0);

  // Fetch commit history when tab becomes active
  useEffect(() => {
    if (repoPath && isActive) {
      getCommitHistory(repoPath, 100).then(setCommits);
    }
  }, [repoPath, isActive, status]);

  // Update selected history commit when index changes
  useEffect(() => {
    if (isActive && commits.length > 0) {
      const commit = commits[historySelectedIndex];
      if (commit) {
        selectHistoryCommit(commit);
        setDiffScrollOffset(0);
      }
    }
  }, [isActive, commits, historySelectedIndex, selectHistoryCommit, setDiffScrollOffset]);

  // Calculate history diff total rows for scrolling
  // When wrap mode is enabled, account for wrapped lines
  const historyDiffTotalRows = useMemo(() => {
    const displayRows = buildHistoryDisplayRows(historySelectedCommit, historyCommitDiff);
    if (!wrapMode) return displayRows.length;

    const lineNumWidth = getDisplayRowsLineNumWidth(displayRows);
    const contentWidth = terminalWidth - lineNumWidth - 5;
    return getWrappedRowCount(displayRows, contentWidth, true);
  }, [historySelectedCommit, historyCommitDiff, wrapMode, terminalWidth]);

  // Calculate total commits for scroll limits (1 commit = 1 row)
  const historyTotalRows = useMemo(() => commits.length, [commits]);

  // Navigation handlers
  const navigateHistoryUp = useCallback(() => {
    setHistorySelectedIndex((prev) => {
      const newIndex = Math.max(0, prev - 1);
      if (newIndex < historyScrollOffset) setHistoryScrollOffset(newIndex);
      return newIndex;
    });
  }, [historyScrollOffset, setHistoryScrollOffset]);

  const navigateHistoryDown = useCallback(() => {
    setHistorySelectedIndex((prev) => {
      const newIndex = Math.min(commits.length - 1, prev + 1);
      const visibleEnd = historyScrollOffset + topPaneHeight - 2;
      if (newIndex >= visibleEnd) setHistoryScrollOffset(historyScrollOffset + 1);
      return newIndex;
    });
  }, [commits.length, historyScrollOffset, topPaneHeight, setHistoryScrollOffset]);

  return {
    commits,
    historySelectedIndex,
    setHistorySelectedIndex,
    historyDiffTotalRows,
    navigateHistoryUp,
    navigateHistoryDown,
    historyTotalRows,
  };
}
