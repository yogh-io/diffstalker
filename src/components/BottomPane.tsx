import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { FileEntry, CommitInfo } from '../git/status.js';
import { DiffResult, CompareDiff } from '../git/diff.js';
import { UnifiedDiffView } from './UnifiedDiffView.js';
import { CommitPanel } from './CommitPanel.js';
import { CompareListSelection } from './CompareListView.js';
import { BottomTab, Pane } from '../hooks/useKeymap.js';
import { ThemeName } from '../themes.js';
import { shortenPath } from '../utils/formatPath.js';
import {
  DisplayRow,
  buildDiffDisplayRows,
  buildHistoryDisplayRows,
  buildCompareDisplayRows,
  getDisplayRowsLineNumWidth,
  wrapDisplayRows,
} from '../utils/displayRows.js';

interface BottomPaneProps {
  bottomTab: BottomTab;
  currentPane: Pane;
  terminalWidth: number;
  bottomPaneHeight: number;
  diffScrollOffset: number;
  currentTheme: ThemeName;

  // Diff tab props
  diff: DiffResult | null;
  selectedFile: FileEntry | null;

  // Commit tab props
  stagedCount: number;
  onCommit: (message: string) => Promise<void>;
  onCommitCancel: () => void;
  getHeadCommitMessage: () => Promise<string>;
  onCommitInputFocusChange: (focused: boolean) => void;

  // History tab props
  historySelectedCommit: CommitInfo | null;
  historyCommitDiff: DiffResult | null;

  // Compare tab props
  compareDiff: CompareDiff | null;
  compareLoading: boolean;
  compareError: string | null;
  compareListSelection: CompareListSelection | null;
  compareSelectionDiff: DiffResult | null;

  // Wrap mode
  wrapMode: boolean;
}

export function BottomPane({
  bottomTab,
  currentPane,
  terminalWidth,
  bottomPaneHeight,
  diffScrollOffset,
  currentTheme,
  diff,
  selectedFile,
  stagedCount,
  onCommit,
  onCommitCancel,
  getHeadCommitMessage,
  onCommitInputFocusChange,
  historySelectedCommit,
  historyCommitDiff,
  compareDiff,
  compareLoading,
  compareError,
  compareListSelection,
  compareSelectionDiff,
  wrapMode,
}: BottomPaneProps): React.ReactElement {
  const isDiffFocused =
    currentPane !== 'files' && currentPane !== 'history' && currentPane !== 'compare';

  // Build display rows based on current tab
  const displayRows: DisplayRow[] = useMemo(() => {
    if (bottomTab === 'diff') {
      return buildDiffDisplayRows(diff);
    }

    if (bottomTab === 'history') {
      return buildHistoryDisplayRows(historySelectedCommit, historyCommitDiff);
    }

    if (bottomTab === 'compare') {
      // If a specific commit is selected, show that commit's diff
      if (compareListSelection?.type === 'commit' && compareSelectionDiff) {
        return buildDiffDisplayRows(compareSelectionDiff);
      }
      // Otherwise show combined compare diff
      return buildCompareDisplayRows(compareDiff);
    }

    return [];
  }, [
    bottomTab,
    diff,
    historySelectedCommit,
    historyCommitDiff,
    compareListSelection,
    compareSelectionDiff,
    compareDiff,
  ]);

  // Wrap display rows if wrap mode is enabled
  const wrappedRows = useMemo(() => {
    if (!wrapMode || displayRows.length === 0) return displayRows;

    // Calculate content width: width - paddingX(1) - lineNum - space(1) - symbol(1) - space(1) - paddingX(1)
    const lineNumWidth = getDisplayRowsLineNumWidth(displayRows);
    const contentWidth = terminalWidth - lineNumWidth - 5;

    return wrapDisplayRows(displayRows, contentWidth, wrapMode);
  }, [displayRows, terminalWidth, wrapMode]);

  // Build header right-side content
  const renderHeaderRight = () => {
    if (selectedFile && bottomTab === 'diff') {
      return <Text dimColor>{shortenPath(selectedFile.path, terminalWidth - 10)}</Text>;
    }
    if (bottomTab === 'history' && historySelectedCommit) {
      return (
        <Text dimColor>
          {historySelectedCommit.shortHash} - {historySelectedCommit.message.slice(0, 50)}
        </Text>
      );
    }
    if (bottomTab === 'compare' && compareListSelection) {
      if (compareListSelection.type === 'commit') {
        const commit = compareDiff?.commits[compareListSelection.index];
        return (
          <Text dimColor>
            {commit?.shortHash ?? ''} - {commit?.message.slice(0, 40) ?? ''}
          </Text>
        );
      } else {
        const path = compareDiff?.files[compareListSelection.index]?.path ?? '';
        return <Text dimColor>{shortenPath(path, terminalWidth - 10)}</Text>;
      }
    }
    return null;
  };

  // Render content based on tab
  const renderContent = () => {
    // Commit tab is special - not a diff view
    if (bottomTab === 'commit') {
      return (
        <CommitPanel
          isActive={currentPane === 'commit'}
          stagedCount={stagedCount}
          onCommit={onCommit}
          onCancel={onCommitCancel}
          getHeadMessage={getHeadCommitMessage}
          onInputFocusChange={onCommitInputFocusChange}
        />
      );
    }

    // Compare tab loading/error states
    if (bottomTab === 'compare') {
      if (compareLoading) {
        return <Text dimColor>Loading compare diff...</Text>;
      }
      if (compareError) {
        return <Text color="red">{compareError}</Text>;
      }
      if (!compareDiff) {
        return <Text dimColor>No base branch found (no origin/main or origin/master)</Text>;
      }
      if (compareDiff.files.length === 0) {
        return <Text dimColor>No changes compared to {compareDiff.baseBranch}</Text>;
      }
    }

    // All diff views use UnifiedDiffView
    return (
      <UnifiedDiffView
        rows={wrappedRows}
        maxHeight={bottomPaneHeight - 1}
        scrollOffset={diffScrollOffset}
        theme={currentTheme}
        width={terminalWidth}
        wrapMode={wrapMode}
      />
    );
  };

  return (
    <Box
      flexDirection="column"
      height={bottomPaneHeight}
      width={terminalWidth}
      overflowX="hidden"
      overflowY="hidden"
    >
      <Box width={terminalWidth}>
        <Text bold color={isDiffFocused ? 'cyan' : undefined}>
          {bottomTab === 'commit' ? 'COMMIT' : 'DIFF'}
        </Text>
        <Box flexGrow={1} justifyContent="flex-end">
          {renderHeaderRight()}
        </Box>
      </Box>
      {renderContent()}
    </Box>
  );
}
