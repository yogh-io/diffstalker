import { useState, useEffect, useCallback, useRef } from 'react';
import {
  GitStateManager,
  getManagerForRepo,
  removeManagerForRepo,
  GitState,
  PRState,
  HistoryState,
  PRSelectionState,
} from '../core/GitStateManager.js';
import { GitStatus, FileEntry, CommitInfo } from '../git/status.js';
import { DiffResult, PRDiff } from '../git/diff.js';

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
  // PR diff state
  prDiff: PRDiff | null;
  prBaseBranch: string | null;
  prLoading: boolean;
  prError: string | null;
  refreshPRDiff: (includeUncommitted?: boolean) => Promise<void>;
  getCandidateBaseBranches: () => Promise<string[]>;
  setPRBaseBranch: (branch: string, includeUncommitted?: boolean) => Promise<void>;
  // History state
  historySelectedCommit: CommitInfo | null;
  historyCommitDiff: DiffResult | null;
  selectHistoryCommit: (commit: CommitInfo | null) => Promise<void>;
  // PR selection state
  prSelectionType: 'commit' | 'file' | null;
  prSelectionIndex: number;
  prSelectionDiff: DiffResult | null;
  selectPRCommit: (index: number) => Promise<void>;
  selectPRFile: (index: number) => void;
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

  const [prState, setPRState] = useState<PRState>({
    prDiff: null,
    prBaseBranch: null,
    prLoading: false,
    prError: null,
  });

  const [historyState, setHistoryState] = useState<HistoryState>({
    selectedCommit: null,
    commitDiff: null,
  });

  const [prSelectionState, setPRSelectionState] = useState<PRSelectionState>({
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

    const handlePRStateChange = (state: PRState) => {
      setPRState(state);
    };

    const handleHistoryStateChange = (state: HistoryState) => {
      setHistoryState(state);
    };

    const handlePRSelectionChange = (state: PRSelectionState) => {
      setPRSelectionState(state);
    };

    manager.on('state-change', handleStateChange);
    manager.on('pr-state-change', handlePRStateChange);
    manager.on('history-state-change', handleHistoryStateChange);
    manager.on('pr-selection-change', handlePRSelectionChange);

    // Start watching and do initial refresh
    manager.startWatching();
    manager.refresh();

    return () => {
      manager.off('state-change', handleStateChange);
      manager.off('pr-state-change', handlePRStateChange);
      manager.off('history-state-change', handleHistoryStateChange);
      manager.off('pr-selection-change', handlePRSelectionChange);
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

  const refreshPRDiff = useCallback(async (includeUncommitted: boolean = false) => {
    await managerRef.current?.refreshPRDiff(includeUncommitted);
  }, []);

  const getCandidateBaseBranches = useCallback(async (): Promise<string[]> => {
    return managerRef.current?.getCandidateBaseBranches() ?? [];
  }, []);

  const setPRBaseBranch = useCallback(async (branch: string, includeUncommitted: boolean = false) => {
    await managerRef.current?.setPRBaseBranch(branch, includeUncommitted);
  }, []);

  const selectHistoryCommit = useCallback(async (commit: CommitInfo | null) => {
    await managerRef.current?.selectHistoryCommit(commit);
  }, []);

  const selectPRCommit = useCallback(async (index: number) => {
    await managerRef.current?.selectPRCommit(index);
  }, []);

  const selectPRFile = useCallback((index: number) => {
    managerRef.current?.selectPRFile(index);
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
    prDiff: prState.prDiff,
    prBaseBranch: prState.prBaseBranch,
    prLoading: prState.prLoading,
    prError: prState.prError,
    refreshPRDiff,
    getCandidateBaseBranches,
    setPRBaseBranch,
    // History state
    historySelectedCommit: historyState.selectedCommit,
    historyCommitDiff: historyState.commitDiff,
    selectHistoryCommit,
    // PR selection state
    prSelectionType: prSelectionState.type,
    prSelectionIndex: prSelectionState.index,
    prSelectionDiff: prSelectionState.diff,
    selectPRCommit,
    selectPRFile,
  };
}
