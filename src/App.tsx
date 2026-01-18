import React, { useState, useCallback, useMemo, useEffect } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { FileEntry, CommitInfo, getCommitHistory } from './git/status.js';
import { Header } from './components/Header.js';
import { FileList, getFileAtIndex, getTotalFileCount } from './components/FileList.js';
import { DiffView } from './components/DiffView.js';
import { CommitPanel } from './components/CommitPanel.js';
import { HistoryView } from './components/HistoryView.js';
import { PRView } from './components/PRView.js';
import { Footer } from './components/Footer.js';
import { useWatcher } from './hooks/useWatcher.js';
import { useGit } from './hooks/useGit.js';
import { useKeymap, Pane, BottomTab } from './hooks/useKeymap.js';
import { useMouse } from './hooks/useMouse.js';
import { useTerminalSize } from './hooks/useTerminalSize.js';
import { useLayout, LAYOUT_OVERHEAD } from './hooks/useLayout.js';
import {
  getClickedFileIndex,
  getClickedTab,
  isButtonAreaClick,
  isInPane,
} from './utils/mouseCoordinates.js';
import { Config } from './config.js';

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

  // History state
  const [commits, setCommits] = useState<CommitInfo[]>([]);
  const [historySelectedIndex, setHistorySelectedIndex] = useState(0);

  // PR view state
  const [includeUncommitted, setIncludeUncommitted] = useState(false);

  // Layout and scroll state
  const {
    topPaneHeight, bottomPaneHeight, paneBoundaries,
    fileListScrollOffset, diffScrollOffset, historyScrollOffset, prScrollOffset,
    setFileListScrollOffset, setDiffScrollOffset, setHistoryScrollOffset, setPRScrollOffset,
    scrollDiff, scrollFileList, scrollHistory, scrollPR,
  } = useLayout(terminalHeight, terminalWidth, files, selectedIndex, diff);

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

  // Calculate PR total rows for scrolling
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

      if (isInPane(y, diffPaneStart, diffPaneEnd)) {
        if (bottomTab === 'diff') scrollDiff(direction);
        else if (bottomTab === 'history') scrollHistory(direction, commits.length);
        else if (bottomTab === 'pr') scrollPR(direction, prTotalRows);
      } else if (isInPane(y, stagingPaneStart, fileListEnd)) {
        scrollFileList(direction);
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
    setCurrentPane(tab === 'diff' ? 'diff' : tab);
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
      scrollPR('up', prTotalRows);
    }
  }, [currentPane, historyScrollOffset, scrollDiff, scrollPR, prTotalRows, setHistoryScrollOffset]);

  const handleNavigateDown = useCallback(() => {
    if (currentPane === 'files') {
      setSelectedIndex(prev => Math.min(totalFiles - 1, prev + 1));
    } else if (currentPane === 'diff') {
      scrollDiff('down');
    } else if (currentPane === 'history') {
      setHistorySelectedIndex(prev => {
        const newIndex = Math.min(commits.length - 1, prev + 1);
        const visibleEnd = historyScrollOffset + bottomPaneHeight - 2;
        if (newIndex >= visibleEnd) setHistoryScrollOffset(prev => prev + 1);
        return newIndex;
      });
    } else if (currentPane === 'pr') {
      scrollPR('down', prTotalRows);
    }
  }, [currentPane, totalFiles, commits.length, historyScrollOffset, bottomPaneHeight, scrollDiff, scrollPR, prTotalRows, setHistoryScrollOffset]);

  const handleTogglePane = useCallback(() => {
    setCurrentPane(prev => prev === 'files' ? bottomTab : 'files');
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
    onToggleIncludeUncommitted: handleToggleIncludeUncommitted,
  }, currentPane, commitInputFocused);

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
        <Box>
          <Text bold color={currentPane === 'files' ? 'cyan' : undefined}>STAGING AREA</Text>
          <Text dimColor> ({files.filter(f => !f.staged).length} unstaged, {stagedCount} staged)</Text>
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
      </Box>

      <Separator />

      <Box flexDirection="column" height={bottomPaneHeight} overflowY="hidden">
        <Box justifyContent="space-between">
          <Text bold color={currentPane !== 'files' ? 'cyan' : undefined}>
            {bottomTab.toUpperCase()}
          </Text>
          {selectedFile && bottomTab === 'diff' && <Text dimColor>{selectedFile.path}</Text>}
          {bottomTab === 'history' && <Text dimColor>{commits.length} commits</Text>}
        </Box>

        {bottomTab === 'diff' ? (
          <DiffView diff={diff} maxHeight={bottomPaneHeight - 1} scrollOffset={diffScrollOffset} />
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
          <HistoryView
            commits={commits}
            selectedIndex={historySelectedIndex}
            scrollOffset={historyScrollOffset}
            maxHeight={bottomPaneHeight - 1}
            isActive={currentPane === 'history'}
            width={terminalWidth}
          />
        ) : (
          <PRView
            prDiff={prDiff}
            isLoading={prLoading}
            error={prError}
            scrollOffset={prScrollOffset}
            maxHeight={bottomPaneHeight - 1}
            width={terminalWidth}
            isActive={currentPane === 'pr'}
            includeUncommitted={includeUncommitted}
            onToggleIncludeUncommitted={handleToggleIncludeUncommitted}
          />
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
    </Box>
  );
}
