import { useState, useEffect, useCallback, useRef } from 'react';
import {
  GitStateManager,
  getManagerForRepo,
  removeManagerForRepo,
  GitState,
  CompareState,
  HistoryState,
  CompareSelectionState,
} from '../core/GitStateManager.js';
import { GitStatus, FileEntry, CommitInfo } from '../git/status.js';
import { DiffResult, CompareDiff } from '../git/diff.js';

export interface UseGitResult {
  status: GitStatus | null;
  diff: DiffResult | null;
  stagedDiff: string;
  selectedFile: FileEntry | null;
  isLoading: boolean;
  error: string | null;
  selectFile: (file: FileEntry | null) => void;
  stage: (file: FileEntry) => Promise<void>;
  unstage: (file: FileEntry) => Promise<void>;
  discard: (file: FileEntry) => Promise<void>;
  stageAll: () => Promise<void>;
  unstageAll: () => Promise<void>;
  commit: (message: string, amend?: boolean) => Promise<void>;
  refresh: () => Promise<void>;
  getHeadCommitMessage: () => Promise<string>;
  // Compare diff state
  compareDiff: CompareDiff | null;
  compareBaseBranch: string | null;
  compareLoading: boolean;
  compareError: string | null;
  refreshCompareDiff: (includeUncommitted?: boolean) => Promise<void>;
  getCandidateBaseBranches: () => Promise<string[]>;
  setCompareBaseBranch: (branch: string, includeUncommitted?: boolean) => Promise<void>;
  // History state
  historySelectedCommit: CommitInfo | null;
  historyCommitDiff: DiffResult | null;
  selectHistoryCommit: (commit: CommitInfo | null) => Promise<void>;
  // Compare selection state
  compareSelectionType: 'commit' | 'file' | null;
  compareSelectionIndex: number;
  compareSelectionDiff: DiffResult | null;
  selectCompareCommit: (index: number) => Promise<void>;
  selectCompareFile: (index: number) => void;
}

/**
 * React hook that wraps GitStateManager.
 * Subscribes to state changes and provides React-friendly interface.
 */
export function useGit(repoPath: string | null): UseGitResult {
  const [gitState, setGitState] = useState<GitState>({
    status: null,
    diff: null,
    stagedDiff: '',
    selectedFile: null,
    isLoading: false,
    error: null,
  });

  const [compareState, setCompareState] = useState<CompareState>({
    compareDiff: null,
    compareBaseBranch: null,
    compareLoading: false,
    compareError: null,
  });

  const [historyState, setHistoryState] = useState<HistoryState>({
    selectedCommit: null,
    commitDiff: null,
  });

  const [compareSelectionState, setCompareSelectionState] = useState<CompareSelectionState>({
    type: null,
    index: 0,
    diff: null,
  });

  const managerRef = useRef<GitStateManager | null>(null);

  // Setup manager and subscribe to events
  useEffect(() => {
    if (!repoPath) {
      setGitState({
        status: null,
        diff: null,
        stagedDiff: '',
        selectedFile: null,
        isLoading: false,
        error: null,
      });
      return;
    }

    const manager = getManagerForRepo(repoPath);
    managerRef.current = manager;

    // Subscribe to state changes
    const handleStateChange = (state: GitState) => {
      setGitState(state);
    };

    const handleCompareStateChange = (state: CompareState) => {
      setCompareState(state);
    };

    const handleHistoryStateChange = (state: HistoryState) => {
      setHistoryState(state);
    };

    const handleCompareSelectionChange = (state: CompareSelectionState) => {
      setCompareSelectionState(state);
    };

    manager.on('state-change', handleStateChange);
    manager.on('compare-state-change', handleCompareStateChange);
    manager.on('history-state-change', handleHistoryStateChange);
    manager.on('compare-selection-change', handleCompareSelectionChange);

    // Start watching and do initial refresh
    manager.startWatching();
    manager.refresh();

    return () => {
      manager.off('state-change', handleStateChange);
      manager.off('compare-state-change', handleCompareStateChange);
      manager.off('history-state-change', handleHistoryStateChange);
      manager.off('compare-selection-change', handleCompareSelectionChange);
      removeManagerForRepo(repoPath);
      managerRef.current = null;
    };
  }, [repoPath]);

  // Wrapped methods that delegate to manager
  const selectFile = useCallback((file: FileEntry | null) => {
    managerRef.current?.selectFile(file);
  }, []);

  const stage = useCallback(async (file: FileEntry) => {
    await managerRef.current?.stage(file);
  }, []);

  const unstage = useCallback(async (file: FileEntry) => {
    await managerRef.current?.unstage(file);
  }, []);

  const discard = useCallback(async (file: FileEntry) => {
    await managerRef.current?.discard(file);
  }, []);

  const stageAll = useCallback(async () => {
    await managerRef.current?.stageAll();
  }, []);

  const unstageAll = useCallback(async () => {
    await managerRef.current?.unstageAll();
  }, []);

  const commit = useCallback(async (message: string, amend: boolean = false) => {
    await managerRef.current?.commit(message, amend);
  }, []);

  const refresh = useCallback(async () => {
    await managerRef.current?.refresh();
  }, []);

  const getHeadCommitMessage = useCallback(async (): Promise<string> => {
    return managerRef.current?.getHeadCommitMessage() ?? '';
  }, []);

  const refreshCompareDiff = useCallback(async (includeUncommitted: boolean = false) => {
    await managerRef.current?.refreshCompareDiff(includeUncommitted);
  }, []);

  const getCandidateBaseBranches = useCallback(async (): Promise<string[]> => {
    return managerRef.current?.getCandidateBaseBranches() ?? [];
  }, []);

  const setCompareBaseBranch = useCallback(async (branch: string, includeUncommitted: boolean = false) => {
    await managerRef.current?.setCompareBaseBranch(branch, includeUncommitted);
  }, []);

  const selectHistoryCommit = useCallback(async (commit: CommitInfo | null) => {
    await managerRef.current?.selectHistoryCommit(commit);
  }, []);

  const selectCompareCommit = useCallback(async (index: number) => {
    await managerRef.current?.selectCompareCommit(index);
  }, []);

  const selectCompareFile = useCallback((index: number) => {
    managerRef.current?.selectCompareFile(index);
  }, []);

  return {
    status: gitState.status,
    diff: gitState.diff,
    stagedDiff: gitState.stagedDiff,
    selectedFile: gitState.selectedFile,
    isLoading: gitState.isLoading,
    error: gitState.error,
    selectFile,
    stage,
    unstage,
    discard,
    stageAll,
    unstageAll,
    commit,
    refresh,
    getHeadCommitMessage,
    compareDiff: compareState.compareDiff,
    compareBaseBranch: compareState.compareBaseBranch,
    compareLoading: compareState.compareLoading,
    compareError: compareState.compareError,
    refreshCompareDiff,
    getCandidateBaseBranches,
    setCompareBaseBranch,
    // History state
    historySelectedCommit: historyState.selectedCommit,
    historyCommitDiff: historyState.commitDiff,
    selectHistoryCommit,
    // Compare selection state
    compareSelectionType: compareSelectionState.type,
    compareSelectionIndex: compareSelectionState.index,
    compareSelectionDiff: compareSelectionState.diff,
    selectCompareCommit,
    selectCompareFile,
  };
}
