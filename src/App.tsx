import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { FileEntry } from './git/status.js';
import { Header, getHeaderHeight } from './components/Header.js';
import { getFileAtIndex, getTotalFileCount } from './components/FileList.js';
import { getCommitIndexFromRow } from './components/HistoryView.js';
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
import { useExplorerState } from './hooks/useExplorerState.js';
import {
  getClickedFileIndex,
  getClickedTab,
  getFooterLeftClick,
  isButtonAreaClick,
  isInPane,
} from './utils/mouseCoordinates.js';
import { Config, saveConfig } from './config.js';
import { ThemePicker } from './components/ThemePicker.js';
import { HotkeysModal } from './components/HotkeysModal.js';
import { BaseBranchPicker } from './components/BaseBranchPicker.js';
import { ThemeName } from './themes.js';
import {
  buildDiffDisplayRows,
  getDisplayRowsLineNumWidth,
  getWrappedRowCount,
} from './utils/displayRows.js';
import { getExplorerContentTotalRows } from './components/ExplorerContentView.js';
import { getMaxScrollOffset } from './components/ScrollableList.js';

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
    config.watcherEnabled,
    config.targetFile,
    config.debug
  );

  // Determine repo path
  const repoPath = initialPath ?? watcherState.path ?? process.cwd();

  // Git state
  const {
    status,
    diff,
    selectedFile,
    isLoading,
    error,
    selectFile,
    stage,
    unstage,
    discard,
    stageAll,
    unstageAll,
    commit,
    refresh,
    getHeadCommitMessage,
    compareDiff,
    compareLoading,
    compareError,
    refreshCompareDiff,
    getCandidateBaseBranches,
    setCompareBaseBranch,
    historySelectedCommit,
    historyCommitDiff,
    selectHistoryCommit,
    compareSelectionDiff,
    selectCompareCommit,
  } = useGit(repoPath);

  // File list data
  const files = status?.files ?? [];
  const totalFiles = getTotalFileCount(files);
  const stagedCount = files.filter((f) => f.staged).length;

  // UI state
  const [currentPane, setCurrentPane] = useState<Pane>('files');
  const [bottomTab, setBottomTab] = useState<BottomTab>('diff');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [pendingDiscard, setPendingDiscard] = useState<FileEntry | null>(null);
  const [commitInputFocused, setCommitInputFocused] = useState(false);
  const [currentTheme, setCurrentTheme] = useState<ThemeName>(config.theme);
  const [activeModal, setActiveModal] = useState<ModalType>(null);
  const [autoTabEnabled, setAutoTabEnabled] = useState(false);
  const [wrapMode, setWrapMode] = useState(false);

  // Explorer scroll state
  const [explorerScrollOffset, setExplorerScrollOffset] = useState(0);
  const [explorerFileScrollOffset, setExplorerFileScrollOffset] = useState(0);

  // Explorer display options
  const [showMiddleDots, setShowMiddleDots] = useState(false);
  const [hideHiddenFiles, setHideHiddenFiles] = useState(true);
  const [hideGitignored, setHideGitignored] = useState(true);

  // Header height calculation
  const headerHeight = getHeaderHeight(
    repoPath,
    status?.branch ?? null,
    watcherState,
    terminalWidth,
    error,
    isLoading
  );
  const extraOverhead = headerHeight - 1;

  // Layout and scroll state
  const {
    topPaneHeight,
    bottomPaneHeight,
    paneBoundaries,
    splitRatio,
    adjustSplitRatio,
    fileListScrollOffset,
    diffScrollOffset,
    historyScrollOffset,
    compareScrollOffset,
    setDiffScrollOffset,
    setHistoryScrollOffset,
    setCompareScrollOffset,
    scrollDiff,
    scrollFileList,
    scrollHistory,
    scrollCompare,
  } = useLayout(
    terminalHeight,
    terminalWidth,
    files,
    selectedIndex,
    diff,
    bottomTab,
    undefined,
    config.splitRatio,
    extraOverhead
  );

  // Calculate display row counts for scroll calculations
  // When wrap mode is enabled, account for wrapped lines
  const diffTotalRows = useMemo(() => {
    const displayRows = buildDiffDisplayRows(diff);
    if (!wrapMode) return displayRows.length;

    const lineNumWidth = getDisplayRowsLineNumWidth(displayRows);
    const contentWidth = terminalWidth - lineNumWidth - 5;
    return getWrappedRowCount(displayRows, contentWidth, true);
  }, [diff, wrapMode, terminalWidth]);

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
    topPaneHeight,
    historyScrollOffset,
    setHistoryScrollOffset,
    setDiffScrollOffset,
    status,
    wrapMode,
    terminalWidth,
  });

  // Compare state
  const {
    includeUncommitted,
    compareListSelection,
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
    wrapMode,
    terminalWidth,
  });

  // Explorer state
  const {
    currentPath: explorerCurrentPath,
    items: explorerItems,
    selectedIndex: explorerSelectedIndex,
    setSelectedIndex: setExplorerSelectedIndex,
    selectedFile: explorerSelectedFile,
    navigateUp: navigateExplorerUp,
    navigateDown: navigateExplorerDown,
    enterDirectory: explorerEnterDirectory,
    goUp: explorerGoUp,
    isLoading: explorerIsLoading,
    error: explorerError,
    explorerTotalRows,
  } = useExplorerState({
    repoPath,
    isActive: bottomTab === 'explorer',
    topPaneHeight,
    explorerScrollOffset,
    setExplorerScrollOffset,
    fileScrollOffset: explorerFileScrollOffset,
    setFileScrollOffset: setExplorerFileScrollOffset,
    hideHiddenFiles,
    hideGitignored,
  });

  // Calculate explorer content total rows for scroll bounds
  const explorerContentTotalRows = useMemo(() => {
    if (!explorerSelectedFile) return 0;
    return getExplorerContentTotalRows(
      explorerSelectedFile.content,
      explorerSelectedFile.path,
      explorerSelectedFile.truncated ?? false,
      terminalWidth,
      wrapMode
    );
  }, [explorerSelectedFile, terminalWidth, wrapMode]);

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

  // Reset diff scroll when wrap mode changes
  useEffect(() => {
    setDiffScrollOffset(0);
  }, [wrapMode, setDiffScrollOffset]);

  // Tab switching (defined early so handleMouseEvent can use it)
  const handleSwitchTab = useCallback((tab: BottomTab) => {
    setBottomTab(tab);
    const paneMap: Record<BottomTab, Pane> = {
      diff: 'files',
      commit: 'commit',
      history: 'history',
      compare: 'compare',
      explorer: 'explorer',
    };
    setCurrentPane(paneMap[tab]);
  }, []);

  // Ref for toggleMouse (set after useMouse, used in handleMouseEvent)
  const toggleMouseRef = useRef<() => void>(() => {});

  // Mouse handler
  const handleMouseEvent = useCallback(
    (event: { x: number; y: number; type: string; button: string }) => {
      const { x, y, type, button } = event;
      const { stagingPaneStart, fileListEnd, diffPaneStart, diffPaneEnd, footerRow } =
        paneBoundariesRef.current;

      if (type === 'click') {
        // Close modals on any click
        if (activeModal !== null) {
          setActiveModal(null);
          return;
        }

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
            toggleMouseRef.current();
            return;
          } else if (leftClick === 'auto-tab') {
            setAutoTabEnabled((prev) => !prev);
            return;
          } else if (leftClick === 'wrap') {
            setWrapMode((prev) => !prev);
            return;
          }
        }

        // Top pane clicks
        if (isInPane(y, stagingPaneStart + 1, fileListEnd)) {
          // ScrollableList shows scroll indicators when content exceeds maxHeight.
          // This takes 1 row at top, so we need to offset click calculations.
          // FileList doesn't use ScrollableList, so no offset needed for diff/commit tabs.
          const listMaxHeight = topPaneHeight - 1;
          const getScrollIndicatorOffset = (itemCount: number) =>
            itemCount > listMaxHeight ? 1 : 0;

          if (bottomTab === 'diff' || bottomTab === 'commit') {
            const clickedIndex = getClickedFileIndex(
              y,
              fileListScrollOffset,
              files,
              stagingPaneStart,
              fileListEnd
            );
            if (clickedIndex >= 0 && clickedIndex < totalFiles) {
              setSelectedIndex(clickedIndex);
              setCurrentPane('files');
              const file = getFileAtIndex(files, clickedIndex);
              if (file) {
                if (button === 'right' && !file.staged && file.status !== 'untracked') {
                  setPendingDiscard(file);
                } else if (button === 'left' && isButtonAreaClick(x)) {
                  if (file.staged) {
                    unstage(file);
                  } else {
                    stage(file);
                  }
                }
              }
              return;
            }
          } else if (bottomTab === 'history') {
            const offset = getScrollIndicatorOffset(commits.length);
            const visualRow = y - stagingPaneStart - 1 - offset;
            const clickedIndex = getCommitIndexFromRow(
              visualRow,
              commits,
              terminalWidth,
              historyScrollOffset
            );
            if (clickedIndex >= 0 && clickedIndex < commits.length) {
              setHistorySelectedIndex(clickedIndex);
              setCurrentPane('history');
              setDiffScrollOffset(0);
              return;
            }
          } else if (bottomTab === 'compare' && compareDiff) {
            const offset = getScrollIndicatorOffset(compareListTotalRows);
            const visualRow = y - stagingPaneStart - 1 - offset + compareScrollOffset;
            const itemIndex = getItemIndexFromRow(visualRow);
            if (itemIndex >= 0 && itemIndex < compareTotalItems) {
              markSelectionInitialized();
              setCompareSelectedIndex(itemIndex);
              setCurrentPane('compare');
              return;
            }
          } else if (bottomTab === 'explorer') {
            const offset = getScrollIndicatorOffset(explorerItems.length);
            const visualRow = y - stagingPaneStart - 1 - offset + explorerScrollOffset;
            if (visualRow >= 0 && visualRow < explorerItems.length) {
              setExplorerSelectedIndex(visualRow);
              setCurrentPane('explorer');
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
            scrollCompare(direction, compareListTotalRows);
          } else if (bottomTab === 'explorer') {
            // Scroll explorer list (maxHeight is topPaneHeight - 1 for "EXPLORER" header)
            const scrollAmount = direction === 'up' ? -3 : 3;
            const maxOffset = getMaxScrollOffset(explorerTotalRows, topPaneHeight - 1);
            setExplorerScrollOffset((prev) =>
              Math.max(0, Math.min(prev + scrollAmount, maxOffset))
            );
          }
        } else {
          if (bottomTab === 'explorer') {
            // Scroll file content with proper bounds
            const scrollAmount = direction === 'up' ? -3 : 3;
            const maxOffset = getMaxScrollOffset(explorerContentTotalRows, bottomPaneHeight - 1);
            setExplorerFileScrollOffset((prev) =>
              Math.max(0, Math.min(prev + scrollAmount, maxOffset))
            );
          } else {
            let maxRows: number | undefined;
            if (bottomTab === 'compare' && compareListSelection?.type !== 'commit') {
              maxRows = compareDiffTotalRows;
            } else if (bottomTab === 'history') {
              maxRows = historyDiffTotalRows;
            } else if (bottomTab === 'diff') {
              maxRows = diffTotalRows;
            }
            scrollDiff(direction, 3, maxRows);
          }
        }
      }
    },
    [
      terminalWidth,
      fileListScrollOffset,
      files,
      totalFiles,
      bottomTab,
      commits,
      compareDiff,
      compareTotalItems,
      stage,
      unstage,
      scrollDiff,
      scrollFileList,
      scrollHistory,
      scrollCompare,
      historyScrollOffset,
      compareScrollOffset,
      setDiffScrollOffset,
      setHistorySelectedIndex,
      setCompareSelectedIndex,
      markSelectionInitialized,
      getItemIndexFromRow,
      compareListSelection?.type,
      compareDiffTotalRows,
      diffTotalRows,
      historyDiffTotalRows,
      historyTotalRows,
      activeModal,
      explorerItems,
      explorerScrollOffset,
      explorerTotalRows,
      explorerContentTotalRows,
      topPaneHeight,
      bottomPaneHeight,
      setExplorerSelectedIndex,
      setExplorerScrollOffset,
      setExplorerFileScrollOffset,
    ]
  );

  // Disable mouse when inputs are focused
  const mouseDisabled = commitInputFocused || showBaseBranchPicker;
  const { mouseEnabled, toggleMouse } = useMouse(handleMouseEvent, mouseDisabled);
  toggleMouseRef.current = toggleMouse;

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
      // Files disappeared: switch to history view and select newest commit
      setHistorySelectedIndex(0);
      setHistoryScrollOffset(0);
      handleSwitchTab('history');
    }
    prevTotalFilesRef.current = totalFiles;
  }, [
    totalFiles,
    autoTabEnabled,
    handleSwitchTab,
    setHistorySelectedIndex,
    setHistoryScrollOffset,
  ]);

  // Navigation handlers
  const handleNavigateUp = useCallback(() => {
    if (currentPane === 'files') {
      setSelectedIndex((prev) => Math.max(0, prev - 1));
    } else if (currentPane === 'diff') {
      let maxRows: number | undefined;
      if (bottomTab === 'compare' && compareListSelection?.type !== 'commit') {
        maxRows = compareDiffTotalRows;
      } else if (bottomTab === 'diff') {
        maxRows = diffTotalRows;
      }
      scrollDiff('up', 3, maxRows);
    } else if (currentPane === 'history') {
      navigateHistoryUp();
    } else if (currentPane === 'compare') {
      navigateCompareUp();
    } else if (currentPane === 'explorer') {
      navigateExplorerUp();
    }
  }, [
    currentPane,
    bottomTab,
    compareListSelection?.type,
    compareDiffTotalRows,
    diffTotalRows,
    scrollDiff,
    navigateHistoryUp,
    navigateCompareUp,
    navigateExplorerUp,
  ]);

  const handleNavigateDown = useCallback(() => {
    if (currentPane === 'files') {
      setSelectedIndex((prev) => Math.min(totalFiles - 1, prev + 1));
    } else if (currentPane === 'diff') {
      let maxRows: number | undefined;
      if (bottomTab === 'compare' && compareListSelection?.type !== 'commit') {
        maxRows = compareDiffTotalRows;
      } else if (bottomTab === 'diff') {
        maxRows = diffTotalRows;
      }
      scrollDiff('down', 3, maxRows);
    } else if (currentPane === 'history') {
      navigateHistoryDown();
    } else if (currentPane === 'compare') {
      navigateCompareDown();
    } else if (currentPane === 'explorer') {
      navigateExplorerDown();
    }
  }, [
    currentPane,
    bottomTab,
    compareListSelection?.type,
    compareDiffTotalRows,
    diffTotalRows,
    totalFiles,
    scrollDiff,
    navigateHistoryDown,
    navigateCompareDown,
    navigateExplorerDown,
  ]);

  const handleTogglePane = useCallback(() => {
    if (bottomTab === 'diff' || bottomTab === 'commit') {
      setCurrentPane((prev) => (prev === 'files' ? 'diff' : 'files'));
    } else if (bottomTab === 'history') {
      setCurrentPane((prev) => (prev === 'history' ? 'diff' : 'history'));
    } else if (bottomTab === 'compare') {
      setCurrentPane((prev) => (prev === 'compare' ? 'diff' : 'compare'));
    } else if (bottomTab === 'explorer') {
      setCurrentPane((prev) => (prev === 'explorer' ? 'diff' : 'explorer'));
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
    if (currentFile.staged) {
      await unstage(currentFile);
    } else {
      await stage(currentFile);
    }
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
  useKeymap(
    {
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
      onToggleFollow: () => setWatcherEnabled((prev) => !prev),
      onToggleAutoTab: () => setAutoTabEnabled((prev) => !prev),
      onToggleWrap: () => setWrapMode((prev) => !prev),
      onToggleMiddleDots:
        bottomTab === 'explorer' ? () => setShowMiddleDots((prev) => !prev) : undefined,
      onToggleHideHiddenFiles:
        bottomTab === 'explorer' ? () => setHideHiddenFiles((prev) => !prev) : undefined,
      onToggleHideGitignored:
        bottomTab === 'explorer' ? () => setHideGitignored((prev) => !prev) : undefined,
      onExplorerEnter: bottomTab === 'explorer' ? explorerEnterDirectory : undefined,
      onExplorerBack: bottomTab === 'explorer' ? explorerGoUp : undefined,
    },
    currentPane,
    commitInputFocused || activeModal !== null || showBaseBranchPicker
  );

  // Discard confirmation
  useInput(
    (input, key) => {
      if (!pendingDiscard) return;
      if (input === 'y' || input === 'Y') {
        discard(pendingDiscard);
        setPendingDiscard(null);
      } else if (input === 'n' || input === 'N' || key.escape) {
        setPendingDiscard(null);
      }
    },
    { isActive: !!pendingDiscard }
  );

  const Separator = () => <Text dimColor>{'─'.repeat(terminalWidth)}</Text>;

  return (
    <Box flexDirection="column" height={terminalHeight} width={terminalWidth} overflowX="hidden">
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
        explorerCurrentPath={explorerCurrentPath}
        explorerItems={explorerItems}
        explorerSelectedIndex={explorerSelectedIndex}
        explorerScrollOffset={explorerScrollOffset}
        explorerIsLoading={explorerIsLoading}
        explorerError={explorerError}
        hideHiddenFiles={hideHiddenFiles}
        hideGitignored={hideGitignored}
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
        wrapMode={wrapMode}
        explorerSelectedFile={explorerSelectedFile}
        explorerFileScrollOffset={explorerFileScrollOffset}
        showMiddleDots={showMiddleDots}
      />

      <Separator />

      {/* Footer */}
      {pendingDiscard ? (
        <Box>
          <Text color="yellow" bold>
            Discard changes to{' '}
          </Text>
          <Text color="cyan">{pendingDiscard.path}</Text>
          <Text color="yellow" bold>
            ?{' '}
          </Text>
          <Text dimColor>(y/n)</Text>
        </Box>
      ) : (
        <Footer
          activeTab={bottomTab}
          mouseEnabled={mouseEnabled}
          autoTabEnabled={autoTabEnabled}
          wrapMode={wrapMode}
          showMiddleDots={showMiddleDots}
        />
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
