import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { FileEntry } from './git/status.js';
import { Header, getHeaderHeight } from './components/Header.js';
import { getFileAtIndex, getTotalFileCount } from './components/FileList.js';
import { getCommitIndexFromRow, getHistoryTotalRows } from './components/HistoryView.js';
import { Footer } from './components/Footer.js';
import { TopPane } from './components/TopPane.js';
import { BottomPane } from './components/BottomPane.js';
import { useWatcher } from './hooks/useWatcher.js';
import { useGit } from './hooks/useGit.js';
import { useKeymap, Pane, BottomTab } from './hooks/useKeymap.js';
import { useMouse } from './hooks/useMouse.js';
import { useTerminalSize } from './hooks/useTerminalSize.js';
import { useLayout, SPLIT_RATIO_STEP } from './hooks/useLayout.js';
import { useHistoryState } from './hooks/useHistoryState.js';
import { useCompareState } from './hooks/useCompareState.js';
import { getClickedFileIndex, getClickedTab, getFooterLeftClick, isButtonAreaClick, isInPane } from './utils/mouseCoordinates.js';
import { Config, saveConfig } from './config.js';
import { ThemePicker } from './components/ThemePicker.js';
import { HotkeysModal } from './components/HotkeysModal.js';
import { BaseBranchPicker } from './components/BaseBranchPicker.js';
import { ThemeName } from './themes.js';

type ModalType = 'theme' | 'hotkeys' | 'baseBranch' | null;

interface AppProps {
  config: Config;
  initialPath?: string;
}

export function App({ config, initialPath }: AppProps): React.ReactElement {
  const { exit } = useApp();

  // Terminal dimensions
  const { rows: terminalHeight, columns: terminalWidth } = useTerminalSize();

  // File watcher
  const { state: watcherState, setEnabled: setWatcherEnabled } = useWatcher(
    config.watcherEnabled, config.targetFile, config.debug
  );

  // Determine repo path
  const repoPath = initialPath ?? watcherState.path ?? process.cwd();

  // Git state
  const {
    status, diff, stagedDiff, selectedFile, isLoading, error,
    selectFile, stage, unstage, discard, stageAll, unstageAll,
    commit, refresh, getHeadCommitMessage,
    compareDiff, compareLoading, compareError, refreshCompareDiff,
    getCandidateBaseBranches, setCompareBaseBranch,
    historySelectedCommit, historyCommitDiff, selectHistoryCommit,
    compareSelectionDiff, selectCompareCommit,
  } = useGit(repoPath);

  // File list data
  const files = status?.files ?? [];
  const totalFiles = getTotalFileCount(files);
  const stagedCount = files.filter(f => f.staged).length;

  // UI state
  const [currentPane, setCurrentPane] = useState<Pane>('files');
  const [bottomTab, setBottomTab] = useState<BottomTab>('diff');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [pendingDiscard, setPendingDiscard] = useState<FileEntry | null>(null);
  const [commitInputFocused, setCommitInputFocused] = useState(false);
  const [currentTheme, setCurrentTheme] = useState<ThemeName>(config.theme);
  const [activeModal, setActiveModal] = useState<ModalType>(null);
  const [autoTabEnabled, setAutoTabEnabled] = useState(false);

  // Header height calculation
  const headerHeight = getHeaderHeight(repoPath, status?.branch ?? null, watcherState, terminalWidth, error, isLoading);
  const extraOverhead = headerHeight - 1;

  // Layout and scroll state
  const {
    topPaneHeight, bottomPaneHeight, paneBoundaries,
    splitRatio, adjustSplitRatio,
    fileListScrollOffset, diffScrollOffset, historyScrollOffset, compareScrollOffset,
    setDiffScrollOffset, setHistoryScrollOffset, setCompareScrollOffset,
    scrollDiff, scrollFileList, scrollHistory, scrollCompare,
  } = useLayout(terminalHeight, terminalWidth, files, selectedIndex, diff, bottomTab, undefined, config.splitRatio, extraOverhead);

  // History state
  const {
    commits,
    historySelectedIndex,
    setHistorySelectedIndex,
    historyDiffTotalRows,
    navigateHistoryUp,
    navigateHistoryDown,
    historyTotalRows,
  } = useHistoryState({
    repoPath,
    isActive: bottomTab === 'history',
    selectHistoryCommit,
    historyCommitDiff,
    historySelectedCommit,
    terminalWidth,
    topPaneHeight,
    historyScrollOffset,
    setHistoryScrollOffset,
    setDiffScrollOffset,
    status,
  });

  // Compare state
  const {
    includeUncommitted,
    compareListSelection,
    compareSelectedIndex,
    baseBranchCandidates,
    showBaseBranchPicker,
    compareTotalItems,
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
  } = useCompareState({
    repoPath,
    isActive: bottomTab === 'compare',
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
  });

  // Keep a ref to paneBoundaries for use in callbacks
  const paneBoundariesRef = useRef(paneBoundaries);
  paneBoundariesRef.current = paneBoundaries;

  // Save split ratio to config when it changes
  const initialSplitRatioRef = useRef(config.splitRatio);
  useEffect(() => {
    if (splitRatio !== initialSplitRatioRef.current) {
      const timer = setTimeout(() => saveConfig({ splitRatio }), 500);
      return () => clearTimeout(timer);
    }
  }, [splitRatio]);

  // Currently selected file
  const currentFile = useMemo(() => getFileAtIndex(files, selectedIndex), [files, selectedIndex]);

  // Auto-select when files change
  useEffect(() => {
    if (totalFiles > 0 && selectedIndex >= totalFiles) {
      setSelectedIndex(Math.max(0, totalFiles - 1));
    }
  }, [totalFiles, selectedIndex]);

  // Update selected file in useGit
  useEffect(() => {
    selectFile(currentFile);
  }, [currentFile, selectFile]);

  // Reset diff scroll when file selection changes
  useEffect(() => {
    if (bottomTab === 'diff' || bottomTab === 'commit') {
      setDiffScrollOffset(0);
    }
  }, [selectedIndex, bottomTab, setDiffScrollOffset]);

  // Mouse handler
  const handleMouseEvent = useCallback((event: { x: number; y: number; type: string; button: string }) => {
    const { x, y, type, button } = event;
    const { stagingPaneStart, fileListEnd, diffPaneStart, diffPaneEnd, footerRow } = paneBoundariesRef.current;

    if (type === 'click') {
      // Footer clicks
      if (y === footerRow && button === 'left') {
        // Tab clicks on the right side
        const tab = getClickedTab(x, terminalWidth);
        if (tab) {
          handleSwitchTab(tab);
          return;
        }
        // Indicator clicks on the left side
        const leftClick = getFooterLeftClick(x);
        if (leftClick === 'hotkeys') {
          setActiveModal('hotkeys');
          return;
        } else if (leftClick === 'mouse-mode') {
          toggleMouse();
          return;
        } else if (leftClick === 'auto-tab') {
          setAutoTabEnabled(prev => !prev);
          return;
        }
      }

      // Top pane clicks
      if (isInPane(y, stagingPaneStart + 1, fileListEnd)) {
        if (bottomTab === 'diff' || bottomTab === 'commit') {
          const clickedIndex = getClickedFileIndex(y, fileListScrollOffset, files, stagingPaneStart, fileListEnd);
          if (clickedIndex >= 0 && clickedIndex < totalFiles) {
            setSelectedIndex(clickedIndex);
            setCurrentPane('files');
            const file = getFileAtIndex(files, clickedIndex);
            if (file) {
              if (button === 'right' && !file.staged && file.status !== 'untracked') {
                setPendingDiscard(file);
              } else if (button === 'left' && isButtonAreaClick(x)) {
                file.staged ? unstage(file) : stage(file);
              }
            }
            return;
          }
        } else if (bottomTab === 'history') {
          const visualRow = y - stagingPaneStart - 1;
          const clickedIndex = getCommitIndexFromRow(visualRow, commits, terminalWidth, historyScrollOffset);
          if (clickedIndex >= 0 && clickedIndex < commits.length) {
            setHistorySelectedIndex(clickedIndex);
            setCurrentPane('history');
            setDiffScrollOffset(0);
            return;
          }
        } else if (bottomTab === 'compare' && compareDiff) {
          const visualRow = (y - stagingPaneStart - 1) + compareScrollOffset;
          const itemIndex = getItemIndexFromRow(visualRow);
          if (itemIndex >= 0 && itemIndex < compareTotalItems) {
            markSelectionInitialized();
            setCompareSelectedIndex(itemIndex);
            setCurrentPane('compare');
            return;
          }
        }
      }

      // Bottom pane clicks
      if (isInPane(y, diffPaneStart, diffPaneEnd)) {
        setCurrentPane(bottomTab);
      }
    } else if (type === 'scroll-up' || type === 'scroll-down') {
      const direction = type === 'scroll-up' ? 'up' : 'down';

      if (isInPane(y, stagingPaneStart, fileListEnd)) {
        if (bottomTab === 'diff' || bottomTab === 'commit') {
          scrollFileList(direction);
        } else if (bottomTab === 'history') {
          scrollHistory(direction, historyTotalRows);
        } else if (bottomTab === 'compare') {
          scrollCompare(direction, compareTotalItems);
        }
      } else {
        let maxRows: number | undefined;
        if (bottomTab === 'compare' && compareListSelection?.type !== 'commit') {
          maxRows = compareDiffTotalRows;
        } else if (bottomTab === 'history') {
          maxRows = historyDiffTotalRows;
        }
        scrollDiff(direction, 3, maxRows);
      }
    }
  }, [
    terminalWidth, fileListScrollOffset, files, totalFiles, bottomTab, commits, compareDiff,
    compareTotalItems, stage, unstage, scrollDiff, scrollFileList, scrollHistory, scrollCompare,
    historyScrollOffset, compareScrollOffset, setDiffScrollOffset, setHistorySelectedIndex,
    setCompareSelectedIndex, markSelectionInitialized, getItemIndexFromRow,
    compareListSelection?.type, compareDiffTotalRows, historyDiffTotalRows, historyTotalRows,
  ]);

  // Disable mouse when inputs are focused
  const mouseDisabled = commitInputFocused || showBaseBranchPicker;
  const { mouseEnabled, toggleMouse } = useMouse(handleMouseEvent, mouseDisabled);

  // Tab switching
  const handleSwitchTab = useCallback((tab: BottomTab) => {
    setBottomTab(tab);
    const paneMap: Record<BottomTab, Pane> = {
      diff: 'files',
      commit: 'commit',
      history: 'history',
      compare: 'compare',
    };
    setCurrentPane(paneMap[tab]);
  }, []);

  // Auto-tab mode: switch tabs based on file count transitions
  const prevTotalFilesRef = useRef(totalFiles);
  useEffect(() => {
    if (!autoTabEnabled) {
      prevTotalFilesRef.current = totalFiles;
      return;
    }
    const prevCount = prevTotalFilesRef.current;
    // Only trigger on transitions, not on current state
    if (prevCount === 0 && totalFiles > 0) {
      // Files appeared: switch to diff view
      handleSwitchTab('diff');
    } else if (prevCount > 0 && totalFiles === 0) {
      // Files disappeared: switch to history view
      handleSwitchTab('history');
    }
    prevTotalFilesRef.current = totalFiles;
  }, [totalFiles, autoTabEnabled, handleSwitchTab]);

  // Navigation handlers
  const handleNavigateUp = useCallback(() => {
    if (currentPane === 'files') {
      setSelectedIndex(prev => Math.max(0, prev - 1));
    } else if (currentPane === 'diff') {
      const maxRows = (bottomTab === 'compare' && compareListSelection?.type !== 'commit') ? compareDiffTotalRows : undefined;
      scrollDiff('up', 3, maxRows);
    } else if (currentPane === 'history') {
      navigateHistoryUp();
    } else if (currentPane === 'compare') {
      navigateCompareUp();
    }
  }, [currentPane, bottomTab, compareListSelection?.type, compareDiffTotalRows, scrollDiff, navigateHistoryUp, navigateCompareUp]);

  const handleNavigateDown = useCallback(() => {
    if (currentPane === 'files') {
      setSelectedIndex(prev => Math.min(totalFiles - 1, prev + 1));
    } else if (currentPane === 'diff') {
      const maxRows = (bottomTab === 'compare' && compareListSelection?.type !== 'commit') ? compareDiffTotalRows : undefined;
      scrollDiff('down', 3, maxRows);
    } else if (currentPane === 'history') {
      navigateHistoryDown();
    } else if (currentPane === 'compare') {
      navigateCompareDown();
    }
  }, [currentPane, bottomTab, compareListSelection?.type, compareDiffTotalRows, totalFiles, scrollDiff, navigateHistoryDown, navigateCompareDown]);

  const handleTogglePane = useCallback(() => {
    if (bottomTab === 'diff' || bottomTab === 'commit') {
      setCurrentPane(prev => prev === 'files' ? 'diff' : 'files');
    } else if (bottomTab === 'history') {
      setCurrentPane(prev => prev === 'history' ? 'diff' : 'history');
    } else if (bottomTab === 'compare') {
      setCurrentPane(prev => prev === 'compare' ? 'diff' : 'compare');
    }
  }, [bottomTab]);

  // File operations
  const handleStage = useCallback(async () => {
    if (currentFile && !currentFile.staged) await stage(currentFile);
  }, [currentFile, stage]);

  const handleUnstage = useCallback(async () => {
    if (currentFile?.staged) await unstage(currentFile);
  }, [currentFile, unstage]);

  const handleSelect = useCallback(async () => {
    if (!currentFile) return;
    currentFile.staged ? await unstage(currentFile) : await stage(currentFile);
  }, [currentFile, stage, unstage]);

  const handleCommit = useCallback(() => handleSwitchTab('commit'), [handleSwitchTab]);
  const handleCommitCancel = useCallback(() => {
    setBottomTab('diff');
    setCurrentPane('files');
  }, []);

  // Modal handlers
  const handleThemeSelect = useCallback((theme: ThemeName) => {
    setCurrentTheme(theme);
    setActiveModal(null);
    saveConfig({ theme });
  }, []);

  // Keymap
  useKeymap({
    onStage: handleStage,
    onUnstage: handleUnstage,
    onStageAll: stageAll,
    onUnstageAll: unstageAll,
    onCommit: handleCommit,
    onQuit: exit,
    onRefresh: refresh,
    onNavigateUp: handleNavigateUp,
    onNavigateDown: handleNavigateDown,
    onTogglePane: handleTogglePane,
    onSwitchTab: handleSwitchTab,
    onSelect: handleSelect,
    onToggleIncludeUncommitted: toggleIncludeUncommitted,
    onCycleBaseBranch: openBaseBranchPicker,
    onOpenThemePicker: () => setActiveModal('theme'),
    onShrinkTopPane: () => adjustSplitRatio(-SPLIT_RATIO_STEP),
    onGrowTopPane: () => adjustSplitRatio(SPLIT_RATIO_STEP),
    onOpenHotkeysModal: () => setActiveModal('hotkeys'),
    onToggleMouse: toggleMouse,
    onToggleFollow: () => setWatcherEnabled(prev => !prev),
    onToggleAutoTab: () => setAutoTabEnabled(prev => !prev),
  }, currentPane, commitInputFocused || activeModal !== null || showBaseBranchPicker);

  // Discard confirmation
  useInput((input, key) => {
    if (!pendingDiscard) return;
    if (input === 'y' || input === 'Y') {
      discard(pendingDiscard);
      setPendingDiscard(null);
    } else if (input === 'n' || input === 'N' || key.escape) {
      setPendingDiscard(null);
    }
  }, { isActive: !!pendingDiscard });

  const Separator = () => <Text dimColor>{'─'.repeat(terminalWidth)}</Text>;

  return (
    <Box flexDirection="column" height={terminalHeight} width={terminalWidth}>
      {/* Header */}
      <Box height={headerHeight} width={terminalWidth}>
        <Header
          repoPath={repoPath}
          branch={status?.branch ?? null}
          isLoading={isLoading}
          error={error}
          debug={config.debug}
          watcherState={watcherState}
          width={terminalWidth}
        />
      </Box>
      <Separator />

      {/* Top Pane */}
      <TopPane
        bottomTab={bottomTab}
        currentPane={currentPane}
        terminalWidth={terminalWidth}
        topPaneHeight={topPaneHeight}
        files={files}
        selectedIndex={selectedIndex}
        fileListScrollOffset={fileListScrollOffset}
        stagedCount={stagedCount}
        onStage={stage}
        onUnstage={unstage}
        commits={commits}
        historySelectedIndex={historySelectedIndex}
        historyScrollOffset={historyScrollOffset}
        onSelectHistoryCommit={(_, idx) => setHistorySelectedIndex(idx)}
        compareDiff={compareDiff}
        compareListSelection={compareListSelection}
        compareScrollOffset={compareScrollOffset}
        includeUncommitted={includeUncommitted}
        onSelectCompareCommit={(idx) => { markSelectionInitialized(); setCompareSelectedIndex(idx); }}
        onSelectCompareFile={(idx) => { markSelectionInitialized(); setCompareSelectedIndex((compareDiff?.commits.length ?? 0) + idx); }}
        onToggleIncludeUncommitted={toggleIncludeUncommitted}
      />

      <Separator />

      {/* Bottom Pane */}
      <BottomPane
        bottomTab={bottomTab}
        currentPane={currentPane}
        terminalWidth={terminalWidth}
        bottomPaneHeight={bottomPaneHeight}
        diffScrollOffset={diffScrollOffset}
        currentTheme={currentTheme}
        diff={diff}
        selectedFile={selectedFile}
        stagedCount={stagedCount}
        stagedDiff={stagedDiff}
        onCommit={commit}
        onCommitCancel={handleCommitCancel}
        getHeadCommitMessage={getHeadCommitMessage}
        onCommitInputFocusChange={setCommitInputFocused}
        historySelectedCommit={historySelectedCommit}
        historyCommitDiff={historyCommitDiff}
        compareDiff={compareDiff}
        compareLoading={compareLoading}
        compareError={compareError}
        compareListSelection={compareListSelection}
        compareSelectionDiff={compareSelectionDiff}
        includeUncommitted={includeUncommitted}
        onToggleIncludeUncommitted={toggleIncludeUncommitted}
      />

      <Separator />

      {/* Footer */}
      {pendingDiscard ? (
        <Box>
          <Text color="yellow" bold>Discard changes to </Text>
          <Text color="cyan">{pendingDiscard.path}</Text>
          <Text color="yellow" bold>? </Text>
          <Text dimColor>(y/n)</Text>
        </Box>
      ) : (
        <Footer activeTab={bottomTab} mouseEnabled={mouseEnabled} autoTabEnabled={autoTabEnabled} />
      )}

      {/* Modals */}
      {activeModal === 'theme' && (
        <Box position="absolute" marginTop={0} marginLeft={0}>
          <ThemePicker
            currentTheme={currentTheme}
            onSelect={handleThemeSelect}
            onCancel={() => setActiveModal(null)}
            width={terminalWidth}
            height={terminalHeight}
          />
        </Box>
      )}

      {activeModal === 'hotkeys' && (
        <Box position="absolute" marginTop={0} marginLeft={0}>
          <HotkeysModal
            onClose={() => setActiveModal(null)}
            width={terminalWidth}
            height={terminalHeight}
          />
        </Box>
      )}

      {showBaseBranchPicker && (
        <Box position="absolute" marginTop={0} marginLeft={0}>
          <BaseBranchPicker
            candidates={baseBranchCandidates}
            currentBranch={compareDiff?.baseBranch ?? null}
            onSelect={selectBaseBranch}
            onCancel={closeBaseBranchPicker}
            width={terminalWidth}
            height={terminalHeight}
          />
        </Box>
      )}
    </Box>
  );
}
