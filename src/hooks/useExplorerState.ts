import { useState, useEffect, useCallback, useMemo, useRef, Dispatch, SetStateAction } from 'react';
import {
  ExplorerStateManager,
  ExplorerItem,
  ExplorerState,
  SelectedFile,
} from '../core/ExplorerStateManager.js';

export type { ExplorerItem, SelectedFile };

export interface UseExplorerStateProps {
  repoPath: string;
  isActive: boolean;
  topPaneHeight: number;
  explorerScrollOffset: number;
  setExplorerScrollOffset: Dispatch<SetStateAction<number>>;
  fileScrollOffset: number;
  setFileScrollOffset: Dispatch<SetStateAction<number>>;
  hideHiddenFiles: boolean;
  hideGitignored: boolean;
}

export interface UseExplorerStateResult {
  currentPath: string;
  items: ExplorerItem[];
  selectedIndex: number;
  setSelectedIndex: Dispatch<SetStateAction<number>>;
  selectedFile: SelectedFile | null;
  fileScrollOffset: number;
  setFileScrollOffset: Dispatch<SetStateAction<number>>;

  // Navigation
  navigateUp: () => void;
  navigateDown: () => void;
  enterDirectory: () => void;
  goUp: () => void;

  // Loading state
  isLoading: boolean;
  error: string | null;

  // Content info
  explorerTotalRows: number;
}

export function useExplorerState({
  repoPath,
  isActive,
  topPaneHeight,
  explorerScrollOffset,
  setExplorerScrollOffset,
  fileScrollOffset,
  setFileScrollOffset,
  hideHiddenFiles,
  hideGitignored,
}: UseExplorerStateProps): UseExplorerStateResult {
  const managerRef = useRef<ExplorerStateManager | null>(null);
  const [state, setState] = useState<ExplorerState>({
    currentPath: '',
    items: [],
    selectedIndex: 0,
    selectedFile: null,
    isLoading: false,
    error: null,
  });

  // Create/recreate manager when repo changes
  useEffect(() => {
    if (!repoPath) return;

    const manager = new ExplorerStateManager(repoPath, {
      hideHidden: hideHiddenFiles,
      hideGitignored,
    });

    manager.on('state-change', (newState) => {
      setState(newState);
    });

    managerRef.current = manager;

    return () => {
      manager.dispose();
      managerRef.current = null;
    };
  }, [repoPath]); // Only recreate on repo change

  // Update options when filter settings change
  useEffect(() => {
    if (managerRef.current && isActive) {
      managerRef.current.setOptions({
        hideHidden: hideHiddenFiles,
        hideGitignored,
      });
    }
  }, [hideHiddenFiles, hideGitignored, isActive]);

  // Load directory when tab becomes active
  useEffect(() => {
    if (!isActive || !managerRef.current) return;

    managerRef.current.loadDirectory(state.currentPath);
    setExplorerScrollOffset(0);
  }, [isActive, repoPath]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset file scroll when selected file changes
  useEffect(() => {
    if (state.selectedFile) {
      setFileScrollOffset(0);
    }
  }, [state.selectedFile?.path, setFileScrollOffset]);

  // Total rows for scroll calculations
  const explorerTotalRows = useMemo(() => state.items.length, [state.items]);

  // Navigation handlers
  const navigateUp = useCallback(() => {
    if (!managerRef.current) return;

    const newOffset = managerRef.current.navigateUp(explorerScrollOffset);
    if (newOffset !== null) {
      setExplorerScrollOffset(newOffset);
    }
  }, [explorerScrollOffset, setExplorerScrollOffset]);

  const navigateDown = useCallback(() => {
    if (!managerRef.current) return;

    // Calculate visible area: topPaneHeight - 1 for "EXPLORER" header
    const maxHeight = topPaneHeight - 1;
    const newOffset = managerRef.current.navigateDown(explorerScrollOffset, maxHeight);
    if (newOffset !== null) {
      setExplorerScrollOffset(newOffset);
    }
  }, [explorerScrollOffset, topPaneHeight, setExplorerScrollOffset]);

  const enterDirectory = useCallback(() => {
    managerRef.current?.enterDirectory();
  }, []);

  const goUp = useCallback(() => {
    managerRef.current?.goUp();
  }, []);

  const setSelectedIndex = useCallback<Dispatch<SetStateAction<number>>>(
    (action) => {
      if (!managerRef.current) return;

      const newIndex = typeof action === 'function' ? action(state.selectedIndex) : action;
      managerRef.current.selectIndex(newIndex);
    },
    [state.selectedIndex]
  );

  return {
    currentPath: state.currentPath,
    items: state.items,
    selectedIndex: state.selectedIndex,
    setSelectedIndex,
    selectedFile: state.selectedFile,
    fileScrollOffset,
    setFileScrollOffset,
    navigateUp,
    navigateDown,
    enterDirectory,
    goUp,
    isLoading: state.isLoading,
    error: state.error,
    explorerTotalRows,
  };
}
