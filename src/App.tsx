import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { FileEntry, CommitInfo, getCommitHistory } from './git/status.js';
import { Header, getHeaderHeight } from './components/Header.js';
import { FileList, getFileAtIndex, getTotalFileCount } from './components/FileList.js';
import { DiffView } from './components/DiffView.js';
import { CommitPanel } from './components/CommitPanel.js';
import { HistoryView, getCommitIndexFromRow, getHistoryTotalRows } from './components/HistoryView.js';
import { HistoryDiffView, getHistoryDiffTotalRows } from './components/HistoryDiffView.js';
import { CompareListView, CompareListSelection, getCompareItemIndexFromRow } from './components/CompareListView.js';
import { CompareView, getFileScrollOffset, getCompareDiffTotalRows } from './components/CompareView.js';
import { Footer } from './components/Footer.js';
import { useWatcher } from './hooks/useWatcher.js';
import { useGit } from './hooks/useGit.js';
import { useKeymap, Pane, BottomTab } from './hooks/useKeymap.js';
import { useMouse } from './hooks/useMouse.js';
import { useTerminalSize } from './hooks/useTerminalSize.js';
import { useLayout, LAYOUT_OVERHEAD, SPLIT_RATIO_STEP } from './hooks/useLayout.js';
import {
  getClickedFileIndex,
  getClickedTab,
  isButtonAreaClick,
  isInPane,
} from './utils/mouseCoordinates.js';
import { Config, saveConfig } from './config.js';
import { ThemePicker } from './components/ThemePicker.js';
import { HotkeysModal } from './components/HotkeysModal.js';
import { BaseBranchPicker } from './components/BaseBranchPicker.js';
import { ThemeName } from './themes.js';
import { shortenPath } from './utils/formatPath.js';

interface AppProps {
  config: Config;
  initialPath?: string;
}

export function App({ config, initialPath }: AppProps): React.ReactElement {
  const { exit } = useApp();

  // Get terminal dimensions
  const { rows: terminalHeight, columns: terminalWidth } = useTerminalSize();

  // File watcher
  const { state: watcherState, setEnabled: setWatcherEnabled } = useWatcher(config.watcherEnabled, config.targetFile, config.debug);

  // Determine repo path: CLI path > watcher path > cwd
  const repoPath = initialPath ?? watcherState.path ?? process.cwd();

  // Git state
  const {
    status, diff, stagedDiff, selectedFile, isLoading, error,
    selectFile, stage, unstage, discard, stageAll, unstageAll,
    commit, refresh, getHeadCommitMessage,
    compareDiff, compareLoading, compareError, refreshCompareDiff,
    getCandidateBaseBranches, setCompareBaseBranch,
    historySelectedCommit, historyCommitDiff, selectHistoryCommit,
    compareSelectionType, compareSelectionIndex, compareSelectionDiff, selectCompareCommit, selectCompareFile,
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

  // Theme state
  const [currentTheme, setCurrentTheme] = useState<ThemeName>(config.theme);
  const [showThemePicker, setShowThemePicker] = useState(false);

  // Hotkeys modal state
  const [showHotkeysModal, setShowHotkeysModal] = useState(false);

  // History state
  const [commits, setCommits] = useState<CommitInfo[]>([]);
  const [historySelectedIndex, setHistorySelectedIndex] = useState(0);

  // Compare view state
  const [includeUncommitted, setIncludeUncommitted] = useState(true);
  const [compareListSelection, setCompareListSelection] = useState<CompareListSelection | null>(null);
  const [compareSelectedIndex, setCompareSelectedIndex] = useState(0);  // Combined index for commits + files
  const compareSelectionInitialized = useRef(false);  // Track if user has made explicit selection
  const [baseBranchCandidates, setBaseBranchCandidates] = useState<string[]>([]);
  const [showBaseBranchPicker, setShowBaseBranchPicker] = useState(false);

  // Calculate header height (1 normally, 2 if branch wraps due to follow indicator)
  const headerHeight = getHeaderHeight(repoPath, status?.branch ?? null, watcherState, terminalWidth, error, isLoading);
  const extraOverhead = headerHeight - 1; // 1 is already accounted for in LAYOUT_OVERHEAD

  // Layout and scroll state
  const {
    topPaneHeight, bottomPaneHeight, paneBoundaries,
    splitRatio, adjustSplitRatio,
    fileListScrollOffset, diffScrollOffset, historyScrollOffset, compareScrollOffset,
    setFileListScrollOffset, setDiffScrollOffset, setHistoryScrollOffset, setCompareScrollOffset,
    scrollDiff, scrollFileList, scrollHistory, scrollCompare,
  } = useLayout(terminalHeight, terminalWidth, files, selectedIndex, diff, bottomTab, undefined, config.splitRatio, extraOverhead);

  // Keep a ref to paneBoundaries for use in callbacks
  const paneBoundariesRef = useRef(paneBoundaries);
  paneBoundariesRef.current = paneBoundaries;

  // Save split ratio to config when it changes (debounced)
  const initialSplitRatioRef = useRef(config.splitRatio);
  useEffect(() => {
    // Only save if it changed from the initial value
    if (splitRatio !== initialSplitRatioRef.current) {
      const timer = setTimeout(() => {
        saveConfig({ splitRatio });
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [splitRatio]);

  // Get currently selected file
  const currentFile = useMemo(() => getFileAtIndex(files, selectedIndex), [files, selectedIndex]);

  // Fetch commit history when needed
  useEffect(() => {
    if (repoPath && bottomTab === 'history') {
      getCommitHistory(repoPath, 100).then(setCommits);
    }
  }, [repoPath, bottomTab, status]);

  // Fetch compare diff when needed
  useEffect(() => {
    if (repoPath && bottomTab === 'compare') {
      refreshCompareDiff(includeUncommitted);
    }
  }, [repoPath, bottomTab, status, refreshCompareDiff, includeUncommitted]);

  // Fetch base branch candidates when entering compare view
  useEffect(() => {
    if (repoPath && bottomTab === 'compare') {
      getCandidateBaseBranches().then(setBaseBranchCandidates);
    }
  }, [repoPath, bottomTab, getCandidateBaseBranches]);

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

  // Update selected history commit when index changes
  useEffect(() => {
    if (bottomTab === 'history' && commits.length > 0) {
      const commit = commits[historySelectedIndex];
      if (commit) {
        selectHistoryCommit(commit);
        setDiffScrollOffset(0);
      }
    }
  }, [bottomTab, commits, historySelectedIndex, selectHistoryCommit, setDiffScrollOffset]);

  // Reset compare selection state when entering compare tab
  useEffect(() => {
    if (bottomTab === 'compare') {
      // Reset to show full diff on entering compare tab
      compareSelectionInitialized.current = false;
      setCompareListSelection(null);
      setDiffScrollOffset(0);
    }
  }, [bottomTab, setDiffScrollOffset]);

  // Update compare selection when compareSelectedIndex changes (only after user interaction)
  useEffect(() => {
    if (bottomTab === 'compare' && compareDiff && compareSelectionInitialized.current) {
      const commitCount = compareDiff.commits.length;
      const fileCount = compareDiff.files.length;

      if (compareSelectedIndex < commitCount) {
        // Selected a commit - show commit diff from top
        setCompareListSelection({ type: 'commit', index: compareSelectedIndex });
        selectCompareCommit(compareSelectedIndex);
        setDiffScrollOffset(0);
      } else if (compareSelectedIndex < commitCount + fileCount) {
        // Selected a file - scroll to file in full compare diff
        const fileIndex = compareSelectedIndex - commitCount;
        setCompareListSelection({ type: 'file', index: fileIndex });
        // Calculate scroll offset to jump to this file's section
        const scrollTo = getFileScrollOffset(compareDiff, fileIndex);
        setDiffScrollOffset(scrollTo);
      }
    }
  }, [bottomTab, compareDiff, compareSelectedIndex, selectCompareCommit, setDiffScrollOffset]);

  // Calculate compare total items (commits + files) for navigation
  const compareTotalItems = useMemo(() => {
    if (!compareDiff) return 0;
    return compareDiff.commits.length + compareDiff.files.length;
  }, [compareDiff]);

  // Calculate compare diff total rows for scrolling (uses shared row building logic)
  const compareDiffTotalRows = useMemo(() => getCompareDiffTotalRows(compareDiff), [compareDiff]);

  // Calculate history diff total rows for scrolling
  const historyDiffTotalRows = useMemo(
    () => getHistoryDiffTotalRows(historySelectedCommit, historyCommitDiff),
    [historySelectedCommit, historyCommitDiff]
  );

  // Mouse handler
  const handleMouseEvent = useCallback((event: { x: number; y: number; type: string; button: string }) => {
    const { x, y, type, button } = event;
    const { stagingPaneStart, fileListEnd, diffPaneStart, diffPaneEnd, footerRow } = paneBoundariesRef.current;

    if (type === 'click') {
      // Tab clicks in footer
      if (y === footerRow && button === 'left') {
        const tab = getClickedTab(x, terminalWidth);
        if (tab) {
          handleSwitchTab(tab);
          return;
        }
      }

      // Top pane clicks - depends on current mode
      if (isInPane(y, stagingPaneStart + 1, fileListEnd)) {
        if (bottomTab === 'diff' || bottomTab === 'commit') {
          // File list clicks
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
          // History list clicks - map visual row to commit index (accounting for wrapped lines)
          const visualRow = y - stagingPaneStart - 1;
          const clickedIndex = getCommitIndexFromRow(visualRow, commits, terminalWidth, historyScrollOffset);
          if (clickedIndex >= 0 && clickedIndex < commits.length) {
            setHistorySelectedIndex(clickedIndex);
            setCurrentPane('history');
            setDiffScrollOffset(0);
            return;
          }
        } else if (bottomTab === 'compare' && compareDiff) {
          // Compare list clicks - map visual row to item index (accounting for headers/spacers)
          const visualRow = (y - stagingPaneStart - 1) + compareScrollOffset;
          const itemIndex = getCompareItemIndexFromRow(
            visualRow,
            compareDiff.commits.length,
            compareDiff.files.length
          );
          if (itemIndex >= 0 && itemIndex < compareTotalItems) {
            compareSelectionInitialized.current = true;
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
    }
    // Scroll events
    else if (type === 'scroll-up' || type === 'scroll-down') {
      const direction = type === 'scroll-up' ? 'up' : 'down';

      // Top pane scrolling - depends on current mode
      if (isInPane(y, stagingPaneStart, fileListEnd)) {
        if (bottomTab === 'diff' || bottomTab === 'commit') {
          scrollFileList(direction);
        } else if (bottomTab === 'history') {
          scrollHistory(direction, getHistoryTotalRows(commits, terminalWidth));
        } else if (bottomTab === 'compare') {
          scrollCompare(direction, compareTotalItems);
        }
      }
      // Bottom pane scrolling (anywhere below top pane scrolls diff)
      else {
        // Pass appropriate max rows based on mode
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
    terminalWidth, fileListScrollOffset, files, totalFiles,
    bottomTab, commits.length, compareTotalItems, stage, unstage,
    scrollDiff, scrollFileList, scrollHistory, scrollCompare,
    historyScrollOffset, compareScrollOffset, setDiffScrollOffset,
    compareListSelection?.type, compareDiffTotalRows, historyDiffTotalRows,
  ]);

  // Disable mouse tracking when text inputs are focused to prevent escape sequences from entering input
  const mouseDisabled = commitInputFocused || showBaseBranchPicker;
  const { mouseEnabled, toggleMouse } = useMouse(handleMouseEvent, mouseDisabled);

  // Tab switching
  const handleSwitchTab = useCallback((tab: BottomTab) => {
    setBottomTab(tab);
    // Set focus to appropriate pane for each mode
    if (tab === 'diff') {
      setCurrentPane('files');  // In diff mode, start focused on file list
    } else if (tab === 'commit') {
      setCurrentPane('commit');  // In commit mode, focus on commit panel
    } else if (tab === 'history') {
      setCurrentPane('history');  // In history mode, focus on commit list
    } else if (tab === 'compare') {
      setCurrentPane('compare');  // In compare mode, focus on compare list
    }
  }, []);

  // Keyboard navigation
  const handleNavigateUp = useCallback(() => {
    if (currentPane === 'files') {
      setSelectedIndex(prev => Math.max(0, prev - 1));
    } else if (currentPane === 'diff') {
      // In compare view showing full diff, pass the compare diff row count
      const maxRows = (bottomTab === 'compare' && compareListSelection?.type !== 'commit') ? compareDiffTotalRows : undefined;
      scrollDiff('up', 3, maxRows);
    } else if (currentPane === 'history') {
      setHistorySelectedIndex(prev => {
        const newIndex = Math.max(0, prev - 1);
        if (newIndex < historyScrollOffset) setHistoryScrollOffset(newIndex);
        return newIndex;
      });
    } else if (currentPane === 'compare') {
      compareSelectionInitialized.current = true;
      setCompareSelectedIndex(prev => {
        const newIndex = Math.max(0, prev - 1);
        if (newIndex < compareScrollOffset) setCompareScrollOffset(newIndex);
        return newIndex;
      });
    }
  }, [currentPane, bottomTab, compareListSelection?.type, compareDiffTotalRows, historyScrollOffset, compareScrollOffset, scrollDiff, setHistoryScrollOffset, setCompareScrollOffset]);

  const handleNavigateDown = useCallback(() => {
    if (currentPane === 'files') {
      setSelectedIndex(prev => Math.min(totalFiles - 1, prev + 1));
    } else if (currentPane === 'diff') {
      // In compare view showing full diff, pass the compare diff row count
      const maxRows = (bottomTab === 'compare' && compareListSelection?.type !== 'commit') ? compareDiffTotalRows : undefined;
      scrollDiff('down', 3, maxRows);
    } else if (currentPane === 'history') {
      setHistorySelectedIndex(prev => {
        const newIndex = Math.min(commits.length - 1, prev + 1);
        const visibleEnd = historyScrollOffset + topPaneHeight - 2;  // History is now in top pane
        if (newIndex >= visibleEnd) setHistoryScrollOffset(prev => prev + 1);
        return newIndex;
      });
    } else if (currentPane === 'compare') {
      compareSelectionInitialized.current = true;
      setCompareSelectedIndex(prev => {
        const newIndex = Math.min(compareTotalItems - 1, prev + 1);
        const visibleEnd = compareScrollOffset + topPaneHeight - 2;  // Account for header
        if (newIndex >= visibleEnd) setCompareScrollOffset(prev => prev + 1);
        return newIndex;
      });
    }
  }, [currentPane, bottomTab, compareListSelection?.type, compareDiffTotalRows, totalFiles, commits.length, historyScrollOffset, topPaneHeight, compareTotalItems, compareScrollOffset, scrollDiff, setHistoryScrollOffset, setCompareScrollOffset]);

  const handleTogglePane = useCallback(() => {
    // In all modes, toggle between top pane (list) and bottom pane (diff/details)
    if (bottomTab === 'diff' || bottomTab === 'commit') {
      setCurrentPane(prev => prev === 'files' ? 'diff' : 'files');
    } else if (bottomTab === 'history') {
      setCurrentPane(prev => prev === 'history' ? 'diff' : 'history');
    } else if (bottomTab === 'compare') {
      setCurrentPane(prev => prev === 'compare' ? 'diff' : 'compare');
    }
  }, [bottomTab]);

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

  const handleToggleIncludeUncommitted = useCallback(() => {
    setIncludeUncommitted(prev => !prev);
  }, []);

  const handleOpenBaseBranchPicker = useCallback(() => {
    setShowBaseBranchPicker(true);
  }, []);

  const handleBaseBranchSelect = useCallback((branch: string) => {
    setShowBaseBranchPicker(false);
    setCompareBaseBranch(branch, includeUncommitted);
  }, [setCompareBaseBranch, includeUncommitted]);

  const handleBaseBranchCancel = useCallback(() => {
    setShowBaseBranchPicker(false);
  }, []);

  // Theme handlers
  const handleOpenThemePicker = useCallback(() => {
    setShowThemePicker(true);
  }, []);

  const handleThemeSelect = useCallback((theme: ThemeName) => {
    setCurrentTheme(theme);
    setShowThemePicker(false);
    saveConfig({ theme });
  }, []);

  const handleThemeCancel = useCallback(() => {
    setShowThemePicker(false);
  }, []);

  // Hotkeys modal handlers
  const handleOpenHotkeysModal = useCallback(() => {
    setShowHotkeysModal(true);
  }, []);

  const handleCloseHotkeysModal = useCallback(() => {
    setShowHotkeysModal(false);
  }, []);

  // Pane resize handlers
  const handleShrinkTopPane = useCallback(() => {
    adjustSplitRatio(-SPLIT_RATIO_STEP);
  }, [adjustSplitRatio]);

  const handleGrowTopPane = useCallback(() => {
    adjustSplitRatio(SPLIT_RATIO_STEP);
  }, [adjustSplitRatio]);

  // Follow mode toggle handler
  const handleToggleFollow = useCallback(() => {
    setWatcherEnabled(prev => !prev);
  }, [setWatcherEnabled]);

  // Keymap (disabled when modals are open)
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
    onToggleIncludeUncommitted: handleToggleIncludeUncommitted,
    onCycleBaseBranch: handleOpenBaseBranchPicker,
    onOpenThemePicker: handleOpenThemePicker,
    onShrinkTopPane: handleShrinkTopPane,
    onGrowTopPane: handleGrowTopPane,
    onOpenHotkeysModal: handleOpenHotkeysModal,
    onToggleMouse: toggleMouse,
    onToggleFollow: handleToggleFollow,
  }, currentPane, commitInputFocused || showThemePicker || showHotkeysModal || showBaseBranchPicker);

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

      <Box flexDirection="column" height={topPaneHeight} width={terminalWidth} overflowY="hidden">
        {/* Top pane: List content based on mode */}
        {(bottomTab === 'diff' || bottomTab === 'commit') && (
          <>
            <Box>
              <Text bold color={currentPane === 'files' ? 'cyan' : undefined}>STAGING AREA</Text>
              <Text dimColor> ({files.filter(f => !f.staged && f.status !== 'untracked').length} modified, {files.filter(f => f.status === 'untracked').length} untracked, {stagedCount} staged)</Text>
            </Box>
            <FileList
              files={files}
              selectedIndex={selectedIndex}
              isFocused={currentPane === 'files'}
              scrollOffset={fileListScrollOffset}
              maxHeight={topPaneHeight - 1}
              width={terminalWidth}
              onStage={stage}
              onUnstage={unstage}
            />
          </>
        )}
        {bottomTab === 'history' && (
          <>
            <Box>
              <Text bold color={currentPane === 'history' ? 'cyan' : undefined}>COMMITS</Text>
              <Text dimColor> ({commits.length} commits)</Text>
            </Box>
            <HistoryView
              commits={commits}
              selectedIndex={historySelectedIndex}
              scrollOffset={historyScrollOffset}
              maxHeight={topPaneHeight - 1}
              isActive={currentPane === 'history'}
              width={terminalWidth}
              onSelectCommit={(commit, idx) => setHistorySelectedIndex(idx)}
            />
          </>
        )}
        {bottomTab === 'compare' && (
          <>
            <Box>
              <Text bold color={currentPane === 'compare' ? 'cyan' : undefined}>COMPARE</Text>
              <Text dimColor>{' '}(vs </Text>
              <Text color="cyan">{compareDiff?.baseBranch ?? '...'}</Text>
              <Text dimColor>: {compareDiff?.commits.length ?? 0} commits, {compareDiff?.files.length ?? 0} files) (b)</Text>
              {compareDiff && compareDiff.uncommittedCount > 0 && (
                <>
                  <Text dimColor> | </Text>
                  <Text color={includeUncommitted ? 'magenta' : 'yellow'}>
                    [{includeUncommitted ? 'x' : ' '}] uncommitted
                  </Text>
                  <Text dimColor> (u)</Text>
                </>
              )}
            </Box>
            <CompareListView
              commits={compareDiff?.commits ?? []}
              files={compareDiff?.files ?? []}
              selectedItem={compareListSelection}
              scrollOffset={compareScrollOffset}
              maxHeight={topPaneHeight - 1}
              isActive={currentPane === 'compare'}
              width={terminalWidth}
              includeUncommitted={includeUncommitted}
              onSelectCommit={(idx) => setCompareSelectedIndex(idx)}
              onSelectFile={(idx) => setCompareSelectedIndex((compareDiff?.commits.length ?? 0) + idx)}
              onToggleIncludeUncommitted={handleToggleIncludeUncommitted}
            />
          </>
        )}
      </Box>

      <Separator />

      <Box flexDirection="column" height={bottomPaneHeight} width={terminalWidth} overflowY="hidden">
        {/* Bottom pane: Details/Diff content based on mode */}
        <Box width={terminalWidth}>
          <Text bold color={currentPane !== 'files' && currentPane !== 'history' && currentPane !== 'compare' ? 'cyan' : undefined}>
            {bottomTab === 'commit' ? 'COMMIT' : 'DIFF'}
          </Text>
          <Box flexGrow={1} justifyContent="flex-end">
            {selectedFile && bottomTab === 'diff' && <Text dimColor>{shortenPath(selectedFile.path, terminalWidth - 10)}</Text>}
            {bottomTab === 'history' && historySelectedCommit && (
              <Text dimColor>{historySelectedCommit.shortHash} - {historySelectedCommit.message.slice(0, 50)}</Text>
            )}
            {bottomTab === 'compare' && compareListSelection && (
              <Text dimColor>
                {compareListSelection.type === 'commit'
                  ? `${compareDiff?.commits[compareListSelection.index]?.shortHash ?? ''} - ${compareDiff?.commits[compareListSelection.index]?.message.slice(0, 40) ?? ''}`
                  : shortenPath(compareDiff?.files[compareListSelection.index]?.path ?? '', terminalWidth - 10)}
              </Text>
            )}
          </Box>
        </Box>

        {bottomTab === 'diff' ? (
          <DiffView diff={diff} filePath={selectedFile?.path} maxHeight={bottomPaneHeight - 1} scrollOffset={diffScrollOffset} theme={currentTheme} />
        ) : bottomTab === 'commit' ? (
          <CommitPanel
            isActive={currentPane === 'commit'}
            stagedCount={stagedCount}
            stagedDiff={stagedDiff}
            onCommit={commit}
            onCancel={handleCommitCancel}
            getHeadMessage={getHeadCommitMessage}
            onInputFocusChange={setCommitInputFocused}
          />
        ) : bottomTab === 'history' ? (
          <HistoryDiffView
            commit={historySelectedCommit}
            diff={historyCommitDiff}
            maxHeight={bottomPaneHeight - 1}
            scrollOffset={diffScrollOffset}
            width={terminalWidth}
            theme={currentTheme}
          />
        ) : (
          <>
            {compareLoading ? (
              <Text dimColor>Loading compare diff...</Text>
            ) : compareError ? (
              <Text color="red">{compareError}</Text>
            ) : compareListSelection?.type === 'commit' && compareSelectionDiff ? (
              // Show single commit diff when a commit is selected
              <DiffView
                diff={compareSelectionDiff}
                maxHeight={bottomPaneHeight - 1}
                scrollOffset={diffScrollOffset}
                theme={currentTheme}
              />
            ) : compareDiff ? (
              // Show full compare diff when a file is selected or nothing selected
              <CompareView
                compareDiff={compareDiff}
                isLoading={false}
                error={null}
                scrollOffset={diffScrollOffset}
                maxHeight={bottomPaneHeight - 1}
                width={terminalWidth}
                isActive={currentPane === 'diff'}
                includeUncommitted={includeUncommitted}
                onToggleIncludeUncommitted={handleToggleIncludeUncommitted}
                theme={currentTheme}
              />
            ) : (
              <Text dimColor>No compare diff available</Text>
            )}
          </>
        )}
      </Box>

      <Separator />

      {pendingDiscard ? (
        <Box>
          <Text color="yellow" bold>Discard changes to </Text>
          <Text color="cyan">{pendingDiscard.path}</Text>
          <Text color="yellow" bold>? </Text>
          <Text dimColor>(y/n)</Text>
        </Box>
      ) : (
        <Footer activeTab={bottomTab} mouseEnabled={mouseEnabled} />
      )}

      {/* Theme picker modal overlay */}
      {showThemePicker && (
        <Box position="absolute" marginTop={0} marginLeft={0}>
          <ThemePicker
            currentTheme={currentTheme}
            onSelect={handleThemeSelect}
            onCancel={handleThemeCancel}
            width={terminalWidth}
            height={terminalHeight}
          />
        </Box>
      )}

      {/* Hotkeys modal overlay */}
      {showHotkeysModal && (
        <Box position="absolute" marginTop={0} marginLeft={0}>
          <HotkeysModal
            onClose={handleCloseHotkeysModal}
            width={terminalWidth}
            height={terminalHeight}
          />
        </Box>
      )}

      {/* Base branch picker modal overlay */}
      {showBaseBranchPicker && (
        <Box position="absolute" marginTop={0} marginLeft={0}>
          <BaseBranchPicker
            candidates={baseBranchCandidates}
            currentBranch={compareDiff?.baseBranch ?? null}
            onSelect={handleBaseBranchSelect}
            onCancel={handleBaseBranchCancel}
            width={terminalWidth}
            height={terminalHeight}
          />
        </Box>
      )}
    </Box>
  );
}
