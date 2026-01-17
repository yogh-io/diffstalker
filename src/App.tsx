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
import { Config } from './config.js';

interface AppProps {
  config: Config;
  initialPath?: string;
}

// Layout constants (compact: single-line separators)
// Header (1) + sep (1) + sep (1) + sep (1) + footer (1) = 5 lines overhead
// Note: "STAGING AREA" and "DIFF" headers are inside their respective panes, not separate overhead
const LAYOUT_OVERHEAD = 5;

export function App({ config, initialPath }: AppProps): React.ReactElement {
  const { exit } = useApp();

  // Get terminal dimensions for layout (reactive to resize)
  const { rows: terminalHeight, columns: terminalWidth } = useTerminalSize();
  const contentHeight = terminalHeight - LAYOUT_OVERHEAD;

  // File watcher (only active when config.watcherEnabled is true)
  const watcherState = useWatcher(config.watcherEnabled, config.targetFile, config.debug);

  // Determine repo path with priority: CLI path > watcher path > cwd
  const repoPath = initialPath ?? watcherState.path ?? process.cwd();

  // Git state
  const {
    status,
    diff,
    stagedDiff,
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
    prDiff,
    prLoading,
    prError,
    refreshPRDiff,
  } = useGit(repoPath);

  // UI state
  const [currentPane, setCurrentPane] = useState<Pane>('files');
  const [bottomTab, setBottomTab] = useState<BottomTab>('diff');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [diffScrollOffset, setDiffScrollOffset] = useState(0);
  const [fileListScrollOffset, setFileListScrollOffset] = useState(0);
  const [pendingDiscard, setPendingDiscard] = useState<FileEntry | null>(null);

  // History state
  const [commits, setCommits] = useState<CommitInfo[]>([]);
  const [historyScrollOffset, setHistoryScrollOffset] = useState(0);
  const [historySelectedIndex, setHistorySelectedIndex] = useState(0);

  // PR view state
  const [prScrollOffset, setPRScrollOffset] = useState(0);

  // Commit input focus state (for keybinding control)
  const [commitInputFocused, setCommitInputFocused] = useState(false);

  // Fetch commit history when switching to history tab, repo changes, or status updates
  // Status updates after commits (via git watcher), so history auto-refreshes
  useEffect(() => {
    if (repoPath && bottomTab === 'history') {
      getCommitHistory(repoPath, 100).then(setCommits);
    }
  }, [repoPath, bottomTab, status]);

  // Fetch PR diff when switching to PR tab or when repo/status changes
  useEffect(() => {
    if (repoPath && bottomTab === 'pr') {
      refreshPRDiff();
    }
  }, [repoPath, bottomTab, status, refreshPRDiff]);

  // File list helpers
  const files = status?.files ?? [];
  const totalFiles = getTotalFileCount(files);
  const stagedCount = files.filter(f => f.staged).length;

  // Calculate dynamic layout based on file count
  const { topPaneHeight, bottomPaneHeight } = useMemo(() => {
    const unstagedCount = files.filter(f => !f.staged).length;
    const stagedFileCount = files.filter(f => f.staged).length;

    // Calculate content rows needed for staging area
    // 1 for "STAGING AREA" header
    // unstaged header + files (if any)
    // spacer (if both sections exist)
    // staged header + files (if any)
    let neededRows = 1; // "STAGING AREA" header
    if (unstagedCount > 0) neededRows += 1 + unstagedCount; // header + files
    if (stagedFileCount > 0) neededRows += 1 + stagedFileCount; // header + files
    if (unstagedCount > 0 && stagedFileCount > 0) neededRows += 1; // spacer

    // Minimum height of 3 (header + 2 lines for empty state)
    const minHeight = 3;
    // Maximum is 40% of content area
    const maxHeight = Math.floor(contentHeight * 0.4);
    // Use the smaller of needed or max, but at least min
    const topHeight = Math.max(minHeight, Math.min(neededRows, maxHeight));
    const bottomHeight = contentHeight - topHeight;

    return { topPaneHeight: topHeight, bottomPaneHeight: bottomHeight };
  }, [files, contentHeight]);

  // Get currently selected file
  const currentFile = useMemo(() => {
    return getFileAtIndex(files, selectedIndex);
  }, [files, selectedIndex]);

  // Auto-select first file when files change and nothing is selected
  useEffect(() => {
    if (totalFiles > 0 && selectedIndex >= totalFiles) {
      setSelectedIndex(Math.max(0, totalFiles - 1));
    }
    // Reset file list scroll when files change
    setFileListScrollOffset(0);
  }, [totalFiles]);

  // Auto-scroll to keep selected item visible
  useEffect(() => {
    const unstagedFiles = files.filter(f => !f.staged);
    const stagedFiles = files.filter(f => f.staged);

    // Calculate which row the selected file is on
    let selectedRow = 0;
    if (selectedIndex < unstagedFiles.length) {
      // In unstaged section: header (0) + file rows
      selectedRow = 1 + selectedIndex;
    } else {
      // In staged section
      const stagedIdx = selectedIndex - unstagedFiles.length;
      selectedRow = (unstagedFiles.length > 0 ? 1 + unstagedFiles.length : 0) // unstaged section
        + (unstagedFiles.length > 0 && stagedFiles.length > 0 ? 1 : 0) // spacer
        + 1 // staged header
        + stagedIdx;
    }

    const visibleHeight = topPaneHeight - 1;

    // Scroll up if selected is above visible area
    if (selectedRow < fileListScrollOffset) {
      setFileListScrollOffset(Math.max(0, selectedRow - 1));
    }
    // Scroll down if selected is below visible area
    else if (selectedRow >= fileListScrollOffset + visibleHeight) {
      setFileListScrollOffset(selectedRow - visibleHeight + 1);
    }
  }, [selectedIndex, files, topPaneHeight, fileListScrollOffset]);

  // Update selected file in useGit when selection changes
  useEffect(() => {
    selectFile(currentFile);
  }, [currentFile, selectFile]);

  // Reset scroll when diff changes
  useEffect(() => {
    setDiffScrollOffset(0);
  }, [diff]);

  // Mouse event handler
  const handleMouseEvent = useCallback((event: { x: number; y: number; type: string; button: string }) => {
    const { x, y, type, button } = event;

    // Calculate pane boundaries (compact layout)
    // Row 1: Header, Row 2: Sep, Row 3: "STAGING AREA" header, Row 4+: FileList content
    const stagingPaneStart = 3;
    const fileListEnd = 2 + topPaneHeight; // header + sep + staging pane
    const diffPaneStart = fileListEnd + 2; // after staging pane + sep + diff header
    const diffPaneEnd = diffPaneStart + bottomPaneHeight - 1;

    // Helper to get clicked file index in file list area
    const getClickedFileIndex = (): number => {
      if (y < stagingPaneStart + 1 || y > fileListEnd) return -1;

      const listRow = (y - 4) + fileListScrollOffset;
      const unstagedFiles = files.filter(f => !f.staged);
      const stagedFiles = files.filter(f => f.staged);

      if (unstagedFiles.length > 0 && stagedFiles.length > 0) {
        const firstUnstagedFileRow = 1;
        const lastUnstagedFileRow = unstagedFiles.length;
        const spacerRow = lastUnstagedFileRow + 1;
        const stagedHeaderRow = spacerRow + 1;
        const firstStagedFileRow = stagedHeaderRow + 1;

        if (listRow >= firstUnstagedFileRow && listRow <= lastUnstagedFileRow) {
          return listRow - firstUnstagedFileRow;
        } else if (listRow >= firstStagedFileRow) {
          const stagedIdx = listRow - firstStagedFileRow;
          if (stagedIdx < stagedFiles.length) {
            return unstagedFiles.length + stagedIdx;
          }
        }
      } else if (unstagedFiles.length > 0) {
        if (listRow >= 1 && listRow <= unstagedFiles.length) {
          return listRow - 1;
        }
      } else if (stagedFiles.length > 0) {
        if (listRow >= 1 && listRow <= stagedFiles.length) {
          return listRow - 1;
        }
      }
      return -1;
    };

    if (type === 'click') {
      const clickedIndex = getClickedFileIndex();

      if (clickedIndex >= 0 && clickedIndex < totalFiles) {
        setSelectedIndex(clickedIndex);
        setCurrentPane('files');

        const file = getFileAtIndex(files, clickedIndex);
        if (file) {
          if (button === 'right') {
            // Right-click: prompt to discard changes (only for unstaged, non-untracked files)
            if (!file.staged && file.status !== 'untracked') {
              setPendingDiscard(file);
            }
          } else if (button === 'left' && x <= 6) {
            // Left-click on button area: toggle stage/unstage
            if (file.staged) {
              unstage(file);
            } else {
              stage(file);
            }
          }
        }
      }
      // Click in bottom pane
      else if (y >= diffPaneStart && y <= diffPaneEnd) {
        setCurrentPane(bottomTab);
      }
    }
    // Scroll events
    else if (type === 'scroll-up' || type === 'scroll-down') {
      const scrollAmount = 3;

      // Scroll in bottom pane (depends on which tab is active)
      if (y >= diffPaneStart && y <= diffPaneEnd) {
        if (bottomTab === 'diff') {
          if (type === 'scroll-up') {
            setDiffScrollOffset(prev => Math.max(0, prev - scrollAmount));
          } else {
            const maxOffset = Math.max(0, (diff?.lines.length ?? 0) - (bottomPaneHeight - 2));
            setDiffScrollOffset(prev => Math.min(maxOffset, prev + scrollAmount));
          }
        } else if (bottomTab === 'history') {
          if (type === 'scroll-up') {
            setHistoryScrollOffset(prev => Math.max(0, prev - scrollAmount));
          } else {
            const maxOffset = Math.max(0, commits.length - (bottomPaneHeight - 2));
            setHistoryScrollOffset(prev => Math.min(maxOffset, prev + scrollAmount));
          }
        } else if (bottomTab === 'pr') {
          // Calculate total rows for PR view
          let totalRows = 0;
          if (prDiff?.files) {
            for (const file of prDiff.files) {
              totalRows += 1; // File header
              totalRows += file.diff.lines.filter(l => l.type !== 'header').length;
            }
          }
          if (type === 'scroll-up') {
            setPRScrollOffset(prev => Math.max(0, prev - scrollAmount));
          } else {
            const maxOffset = Math.max(0, totalRows - (bottomPaneHeight - 4));
            setPRScrollOffset(prev => Math.min(maxOffset, prev + scrollAmount));
          }
        }
      }
      // Scroll in file list
      else if (y >= stagingPaneStart && y <= fileListEnd) {
        // Calculate max scroll based on total content height
        const unstagedFiles = files.filter(f => !f.staged);
        const stagedFiles = files.filter(f => f.staged);
        let totalRows = 0;
        if (unstagedFiles.length > 0) totalRows += 1 + unstagedFiles.length; // header + files
        if (stagedFiles.length > 0) totalRows += 1 + stagedFiles.length; // header + files
        if (unstagedFiles.length > 0 && stagedFiles.length > 0) totalRows += 1; // spacer

        const visibleRows = topPaneHeight - 1; // minus the "STAGING AREA" header
        const maxScroll = Math.max(0, totalRows - visibleRows);

        if (type === 'scroll-up') {
          setFileListScrollOffset(prev => Math.max(0, prev - scrollAmount));
        } else {
          setFileListScrollOffset(prev => Math.min(maxScroll, prev + scrollAmount));
        }
      }
    }
  }, [files, totalFiles, topPaneHeight, bottomPaneHeight, diff?.lines.length, fileListScrollOffset, stage, unstage, bottomTab, commits.length, prDiff]);

  // Enable mouse support
  useMouse(handleMouseEvent);

  // Keyboard handlers
  const handleNavigateUp = useCallback(() => {
    if (currentPane === 'files') {
      setSelectedIndex(prev => Math.max(0, prev - 1));
    } else if (currentPane === 'diff') {
      setDiffScrollOffset(prev => Math.max(0, prev - 3));
    } else if (currentPane === 'history') {
      setHistorySelectedIndex(prev => {
        const newIndex = Math.max(0, prev - 1);
        // Auto-scroll to keep selection visible
        if (newIndex < historyScrollOffset) {
          setHistoryScrollOffset(newIndex);
        }
        return newIndex;
      });
    } else if (currentPane === 'pr') {
      setPRScrollOffset(prev => Math.max(0, prev - 3));
    }
  }, [currentPane, historyScrollOffset]);

  const handleNavigateDown = useCallback(() => {
    if (currentPane === 'files') {
      setSelectedIndex(prev => Math.min(totalFiles - 1, prev + 1));
    } else if (currentPane === 'diff') {
      const maxOffset = Math.max(0, (diff?.lines.length ?? 0) - (bottomPaneHeight - 4));
      setDiffScrollOffset(prev => Math.min(maxOffset, prev + 3));
    } else if (currentPane === 'history') {
      setHistorySelectedIndex(prev => {
        const newIndex = Math.min(commits.length - 1, prev + 1);
        // Auto-scroll to keep selection visible
        const visibleEnd = historyScrollOffset + bottomPaneHeight - 2;
        if (newIndex >= visibleEnd) {
          setHistoryScrollOffset(prev => prev + 1);
        }
        return newIndex;
      });
    } else if (currentPane === 'pr') {
      // Calculate total rows for PR view
      let totalRows = 0;
      if (prDiff?.files) {
        for (const file of prDiff.files) {
          totalRows += 1; // File header
          totalRows += file.diff.lines.filter(l => l.type !== 'header').length;
        }
      }
      const maxOffset = Math.max(0, totalRows - (bottomPaneHeight - 4));
      setPRScrollOffset(prev => Math.min(maxOffset, prev + 3));
    }
  }, [currentPane, totalFiles, diff?.lines.length, bottomPaneHeight, commits.length, historyScrollOffset, prDiff]);

  const handleTogglePane = useCallback(() => {
    setCurrentPane(prev => {
      if (prev === 'files') return bottomTab;
      return 'files';
    });
  }, [bottomTab]);

  const handleSwitchTab = useCallback((tab: BottomTab) => {
    setBottomTab(tab);
    if (tab === 'commit') {
      setCurrentPane('commit');
    } else if (tab === 'history') {
      setCurrentPane('history');
    } else if (tab === 'pr') {
      setCurrentPane('pr');
    } else {
      setCurrentPane('diff');
    }
  }, []);

  const handleStage = useCallback(async () => {
    if (currentFile && !currentFile.staged) {
      await stage(currentFile);
    }
  }, [currentFile, stage]);

  const handleUnstage = useCallback(async () => {
    if (currentFile && currentFile.staged) {
      await unstage(currentFile);
    }
  }, [currentFile, unstage]);

  const handleSelect = useCallback(async () => {
    if (!currentFile) return;
    if (currentFile.staged) {
      await unstage(currentFile);
    } else {
      await stage(currentFile);
    }
  }, [currentFile, stage, unstage]);

  const handleCommit = useCallback(() => {
    setBottomTab('commit');
    setCurrentPane('commit');
  }, []);

  const handleCommitCancel = useCallback(() => {
    setBottomTab('diff');
    setCurrentPane('files');
  }, []);

  // Use keymap (no config param anymore)
  // Only suppress keybindings when commit input is actually focused
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
    },
    currentPane,
    commitInputFocused
  );

  // Handle confirmation dialog input
  useInput((input, key) => {
    if (!pendingDiscard) return;

    if (input === 'y' || input === 'Y') {
      discard(pendingDiscard);
      setPendingDiscard(null);
    } else if (input === 'n' || input === 'N' || key.escape) {
      setPendingDiscard(null);
    }
  }, { isActive: !!pendingDiscard });

  // Separator line component
  const Separator = () => (
    <Text dimColor>{'─'.repeat(terminalWidth)}</Text>
  );

  return (
    <Box flexDirection="column" height={terminalHeight}>
      {/* Header */}
      <Header
        repoPath={repoPath}
        branch={status?.branch ?? null}
        isLoading={isLoading}
        error={error}
        debug={config.debug}
        watcherState={watcherState}
      />
      <Separator />

      {/* Top pane: File list */}
      <Box flexDirection="column" height={topPaneHeight} overflowY="hidden">
        <Box>
          <Text bold color={currentPane === 'files' ? 'cyan' : undefined}>
            STAGING AREA
          </Text>
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

      {/* Bottom pane: Diff, Commit, History, or PR */}
      <Box flexDirection="column" height={bottomPaneHeight} overflowY="hidden">
        <Box justifyContent="space-between">
          <Text bold color={currentPane !== 'files' ? 'cyan' : undefined}>
            {bottomTab === 'diff' ? 'DIFF' : bottomTab === 'commit' ? 'COMMIT' : bottomTab === 'history' ? 'HISTORY' : 'PR'}
          </Text>
          {selectedFile && bottomTab === 'diff' && (
            <Text dimColor>{selectedFile.path}</Text>
          )}
          {bottomTab === 'history' && (
            <Text dimColor>{commits.length} commits</Text>
          )}
        </Box>

        {bottomTab === 'diff' ? (
          <DiffView
            diff={diff}
            maxHeight={bottomPaneHeight - 1}
            scrollOffset={diffScrollOffset}
          />
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
          />
        )}
      </Box>

      <Separator />

      {/* Footer or Confirmation Dialog */}
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
