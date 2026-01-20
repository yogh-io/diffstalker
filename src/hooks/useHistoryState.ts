import { useState, useEffect, useCallback, useMemo } from 'react';
import { CommitInfo, getCommitHistory } from '../git/status.js';
import { DiffResult } from '../git/diff.js';
import { getHistoryDiffTotalRows } from '../components/HistoryDiffView.js';
import { getHistoryTotalRows } from '../components/HistoryView.js';

interface UseHistoryStateProps {
  repoPath: string;
  isActive: boolean;  // bottomTab === 'history'
  selectHistoryCommit: (commit: CommitInfo) => void;
  historyCommitDiff: DiffResult | null;
  historySelectedCommit: CommitInfo | null;
  terminalWidth: number;
  topPaneHeight: number;
  historyScrollOffset: number;
  setHistoryScrollOffset: (offset: number) => void;
  setDiffScrollOffset: (offset: number) => void;
  status: unknown;  // Trigger refresh when status changes
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
  terminalWidth,
  topPaneHeight,
  historyScrollOffset,
  setHistoryScrollOffset,
  setDiffScrollOffset,
  status,
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
  const historyDiffTotalRows = useMemo(
    () => getHistoryDiffTotalRows(historySelectedCommit, historyCommitDiff),
    [historySelectedCommit, historyCommitDiff]
  );

  // Calculate total visual rows for scroll limits
  const historyTotalRows = useMemo(
    () => getHistoryTotalRows(commits, terminalWidth),
    [commits, terminalWidth]
  );

  // Navigation handlers
  const navigateHistoryUp = useCallback(() => {
    setHistorySelectedIndex(prev => {
      const newIndex = Math.max(0, prev - 1);
      if (newIndex < historyScrollOffset) setHistoryScrollOffset(newIndex);
      return newIndex;
    });
  }, [historyScrollOffset, setHistoryScrollOffset]);

  const navigateHistoryDown = useCallback(() => {
    setHistorySelectedIndex(prev => {
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
