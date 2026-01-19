import React, { useState, useCallback, useMemo, useEffect } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { FileEntry, CommitInfo, getCommitHistory } from './git/status.js';
import { Header } from './components/Header.js';
import { FileList, getFileAtIndex, getTotalFileCount } from './components/FileList.js';
import { DiffView } from './components/DiffView.js';
import { CommitPanel } from './components/CommitPanel.js';
import { HistoryView } from './components/HistoryView.js';
import { PRListView, PRListSelection } from './components/PRListView.js';
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
import { ThemeName } from './themes.js';

interface AppProps {
  config: Config;
  initialPath?: string;
}

export function App({ config, initialPath }: AppProps): React.ReactElement {
  const { exit } = useApp();

  // Get terminal dimensions
  const { rows: terminalHeight, columns: terminalWidth } = useTerminalSize();

  // File watcher
  const watcherState = useWatcher(config.watcherEnabled, config.targetFile, config.debug);

  // Determine repo path: CLI path > watcher path > cwd
  const repoPath = initialPath ?? watcherState.path ?? process.cwd();

  // Git state
  const {
    status, diff, stagedDiff, selectedFile, isLoading, error,
    selectFile, stage, unstage, discard, stageAll, unstageAll,
    commit, refresh, getHeadCommitMessage,
    prDiff, prLoading, prError, refreshPRDiff,
    historySelectedCommit, historyCommitDiff, selectHistoryCommit,
    prSelectionType, prSelectionIndex, prSelectionDiff, selectPRCommit, selectPRFile,
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

  // PR view state
  const [includeUncommitted, setIncludeUncommitted] = useState(false);
  const [prListSelection, setPRListSelection] = useState<PRListSelection | null>(null);
  const [prSelectedIndex, setPRSelectedIndex] = useState(0);  // Combined index for commits + files

  // Layout and scroll state
  const {
    topPaneHeight, bottomPaneHeight, paneBoundaries,
    adjustSplitRatio,
    fileListScrollOffset, diffScrollOffset, historyScrollOffset, prScrollOffset,
    setFileListScrollOffset, setDiffScrollOffset, setHistoryScrollOffset, setPRScrollOffset,
    scrollDiff, scrollFileList, scrollHistory, scrollPR,
  } = useLayout(terminalHeight, terminalWidth, files, selectedIndex, diff, bottomTab);

  // Get currently selected file
  const currentFile = useMemo(() => getFileAtIndex(files, selectedIndex), [files, selectedIndex]);

  // Fetch commit history when needed
  useEffect(() => {
    if (repoPath && bottomTab === 'history') {
      getCommitHistory(repoPath, 100).then(setCommits);
    }
  }, [repoPath, bottomTab, status]);

  // Fetch PR diff when needed
  useEffect(() => {
    if (repoPath && bottomTab === 'pr') {
      refreshPRDiff(includeUncommitted);
    }
  }, [repoPath, bottomTab, status, refreshPRDiff, includeUncommitted]);

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

  // Update selected history commit when index changes
  useEffect(() => {
    if (bottomTab === 'history' && commits.length > 0) {
      const commit = commits[historySelectedIndex];
      if (commit) {
        selectHistoryCommit(commit);
      }
    }
  }, [bottomTab, commits, historySelectedIndex, selectHistoryCommit]);

  // Update PR selection when prSelectedIndex changes
  useEffect(() => {
    if (bottomTab === 'pr' && prDiff) {
      const commitCount = prDiff.commits.length;
      const fileCount = prDiff.files.length;

      if (prSelectedIndex < commitCount) {
        // Selected a commit
        setPRListSelection({ type: 'commit', index: prSelectedIndex });
        selectPRCommit(prSelectedIndex);
      } else if (prSelectedIndex < commitCount + fileCount) {
        // Selected a file
        const fileIndex = prSelectedIndex - commitCount;
        setPRListSelection({ type: 'file', index: fileIndex });
        selectPRFile(fileIndex);
      }
    }
  }, [bottomTab, prDiff, prSelectedIndex, selectPRCommit, selectPRFile]);

  // Calculate PR total items (commits + files) for navigation
  const prTotalItems = useMemo(() => {
    if (!prDiff) return 0;
    return prDiff.commits.length + prDiff.files.length;
  }, [prDiff]);

  // Calculate PR total rows for scrolling (legacy, kept for compatibility)
  const prTotalRows = useMemo(() => {
    if (!prDiff?.files) return 0;
    return prDiff.files.reduce((total, file) =>
      total + 1 + file.diff.lines.filter(l => l.type !== 'header').length, 0);
  }, [prDiff]);

  // Mouse handler
  const handleMouseEvent = useCallback((event: { x: number; y: number; type: string; button: string }) => {
    const { x, y, type, button } = event;
    const { stagingPaneStart, fileListEnd, diffPaneStart, diffPaneEnd, footerRow } = paneBoundaries;

    if (type === 'click') {
      // Tab clicks in footer
      if (y === footerRow && button === 'left') {
        const tab = getClickedTab(x, terminalWidth);
        if (tab) {
          handleSwitchTab(tab);
          return;
        }
      }

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
          scrollHistory(direction, commits.length);
        } else if (bottomTab === 'pr') {
          scrollPR(direction, prTotalRows);
        }
      }
      // Bottom pane scrolling - always scrolls the diff view
      else if (isInPane(y, diffPaneStart, diffPaneEnd)) {
        scrollDiff(direction);
      }
    }
  }, [
    paneBoundaries, terminalWidth, fileListScrollOffset, files, totalFiles,
    bottomTab, commits.length, prTotalRows, stage, unstage,
    scrollDiff, scrollFileList, scrollHistory, scrollPR,
  ]);

  useMouse(handleMouseEvent);

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
    } else if (tab === 'pr') {
      setCurrentPane('pr');  // In PR mode, focus on PR list
    }
  }, []);

  // Keyboard navigation
  const handleNavigateUp = useCallback(() => {
    if (currentPane === 'files') {
      setSelectedIndex(prev => Math.max(0, prev - 1));
    } else if (currentPane === 'diff') {
      scrollDiff('up');
    } else if (currentPane === 'history') {
      setHistorySelectedIndex(prev => {
        const newIndex = Math.max(0, prev - 1);
        if (newIndex < historyScrollOffset) setHistoryScrollOffset(newIndex);
        return newIndex;
      });
    } else if (currentPane === 'pr') {
      setPRSelectedIndex(prev => {
        const newIndex = Math.max(0, prev - 1);
        if (newIndex < prScrollOffset) setPRScrollOffset(newIndex);
        return newIndex;
      });
    }
  }, [currentPane, historyScrollOffset, prScrollOffset, scrollDiff, setHistoryScrollOffset, setPRScrollOffset]);

  const handleNavigateDown = useCallback(() => {
    if (currentPane === 'files') {
      setSelectedIndex(prev => Math.min(totalFiles - 1, prev + 1));
    } else if (currentPane === 'diff') {
      scrollDiff('down');
    } else if (currentPane === 'history') {
      setHistorySelectedIndex(prev => {
        const newIndex = Math.min(commits.length - 1, prev + 1);
        const visibleEnd = historyScrollOffset + topPaneHeight - 2;  // History is now in top pane
        if (newIndex >= visibleEnd) setHistoryScrollOffset(prev => prev + 1);
        return newIndex;
      });
    } else if (currentPane === 'pr') {
      setPRSelectedIndex(prev => {
        const newIndex = Math.min(prTotalItems - 1, prev + 1);
        const visibleEnd = prScrollOffset + topPaneHeight - 2;  // Account for header
        if (newIndex >= visibleEnd) setPRScrollOffset(prev => prev + 1);
        return newIndex;
      });
    }
  }, [currentPane, totalFiles, commits.length, historyScrollOffset, topPaneHeight, prTotalItems, prScrollOffset, scrollDiff, setHistoryScrollOffset, setPRScrollOffset]);

  const handleTogglePane = useCallback(() => {
    // In all modes, toggle between top pane (list) and bottom pane (diff/details)
    if (bottomTab === 'diff' || bottomTab === 'commit') {
      setCurrentPane(prev => prev === 'files' ? 'diff' : 'files');
    } else if (bottomTab === 'history') {
      setCurrentPane(prev => prev === 'history' ? 'diff' : 'history');
    } else if (bottomTab === 'pr') {
      setCurrentPane(prev => prev === 'pr' ? 'diff' : 'pr');
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
    onOpenThemePicker: handleOpenThemePicker,
    onShrinkTopPane: handleShrinkTopPane,
    onGrowTopPane: handleGrowTopPane,
    onOpenHotkeysModal: handleOpenHotkeysModal,
  }, currentPane, commitInputFocused || showThemePicker || showHotkeysModal);

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
    <Box flexDirection="column" height={terminalHeight}>
      <Header
        repoPath={repoPath}
        branch={status?.branch ?? null}
        isLoading={isLoading}
        error={error}
        debug={config.debug}
        watcherState={watcherState}
      />
      <Separator />

      <Box flexDirection="column" height={topPaneHeight} overflowY="hidden">
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
        {bottomTab === 'pr' && (
          <>
            <Box>
              <Text bold color={currentPane === 'pr' ? 'cyan' : undefined}>PR CHANGES</Text>
              <Text dimColor>
                {' '}(vs {prDiff?.baseBranch ?? 'origin/main'}: {prDiff?.commits.length ?? 0} commits, {prDiff?.files.length ?? 0} files)
              </Text>
              {prDiff && prDiff.uncommittedCount > 0 && (
                <>
                  <Text dimColor> | </Text>
                  <Text color={includeUncommitted ? 'magenta' : 'yellow'}>
                    [{includeUncommitted ? 'x' : ' '}] uncommitted
                  </Text>
                  <Text dimColor> (u)</Text>
                </>
              )}
            </Box>
            <PRListView
              commits={prDiff?.commits ?? []}
              files={prDiff?.files ?? []}
              selectedItem={prListSelection}
              scrollOffset={prScrollOffset}
              maxHeight={topPaneHeight - 1}
              isActive={currentPane === 'pr'}
              width={terminalWidth}
              includeUncommitted={includeUncommitted}
              onSelectCommit={(idx) => setPRSelectedIndex(idx)}
              onSelectFile={(idx) => setPRSelectedIndex((prDiff?.commits.length ?? 0) + idx)}
              onToggleIncludeUncommitted={handleToggleIncludeUncommitted}
            />
          </>
        )}
      </Box>

      <Separator />

      <Box flexDirection="column" height={bottomPaneHeight} overflowY="hidden">
        {/* Bottom pane: Details/Diff content based on mode */}
        <Box justifyContent="space-between">
          <Text bold color={currentPane !== 'files' && currentPane !== 'history' && currentPane !== 'pr' ? 'cyan' : undefined}>
            {bottomTab === 'commit' ? 'COMMIT' : 'DIFF'}
          </Text>
          {selectedFile && bottomTab === 'diff' && <Text dimColor>{selectedFile.path}</Text>}
          {bottomTab === 'history' && historySelectedCommit && (
            <Text dimColor>{historySelectedCommit.shortHash} - {historySelectedCommit.message.slice(0, 50)}</Text>
          )}
          {bottomTab === 'pr' && prListSelection && (
            <Text dimColor>
              {prListSelection.type === 'commit'
                ? `${prDiff?.commits[prListSelection.index]?.shortHash ?? ''} - ${prDiff?.commits[prListSelection.index]?.message.slice(0, 40) ?? ''}`
                : prDiff?.files[prListSelection.index]?.path ?? ''}
            </Text>
          )}
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
          <DiffView
            diff={historyCommitDiff}
            maxHeight={bottomPaneHeight - 1}
            scrollOffset={diffScrollOffset}
            theme={currentTheme}
          />
        ) : (
          <>
            {prLoading ? (
              <Text dimColor>Loading PR diff...</Text>
            ) : prError ? (
              <Text color="red">{prError}</Text>
            ) : prSelectionDiff ? (
              <DiffView
                diff={prSelectionDiff}
                filePath={prListSelection?.type === 'file' ? prDiff?.files[prListSelection.index]?.path : undefined}
                maxHeight={bottomPaneHeight - 1}
                scrollOffset={diffScrollOffset}
                theme={currentTheme}
              />
            ) : (
              <Text dimColor>Select a commit or file to view diff</Text>
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
        <Footer activeTab={bottomTab} />
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
    </Box>
  );
}
