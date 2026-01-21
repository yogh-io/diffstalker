import React from 'react';
import { Box, Text } from 'ink';
import { FileEntry, CommitInfo } from '../git/status.js';
import { DiffResult, CompareDiff } from '../git/diff.js';
import { DiffView } from './DiffView.js';
import { CommitPanel } from './CommitPanel.js';
import { HistoryDiffView } from './HistoryDiffView.js';
import { CompareView } from './CompareView.js';
import { ExplorerContentView } from './ExplorerContentView.js';
import { CompareListSelection } from './CompareListView.js';
import { BottomTab, Pane } from '../hooks/useKeymap.js';
import { ThemeName } from '../themes.js';
import { shortenPath } from '../utils/formatPath.js';

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

  // Explorer tab props
  explorerSelectedFile?: { path: string; content: string; truncated?: boolean } | null;
  explorerFileScrollOffset?: number;
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
  explorerSelectedFile = null,
  explorerFileScrollOffset = 0,
}: BottomPaneProps): React.ReactElement {
  const isDiffFocused =
    currentPane !== 'files' &&
    currentPane !== 'history' &&
    currentPane !== 'compare' &&
    currentPane !== 'explorer';

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
    if (bottomTab === 'explorer' && explorerSelectedFile) {
      return <Text dimColor>{shortenPath(explorerSelectedFile.path, terminalWidth - 10)}</Text>;
    }
    return null;
  };

  // Render content based on tab
  const renderContent = () => {
    if (bottomTab === 'diff') {
      return (
        <DiffView
          diff={diff}
          filePath={selectedFile?.path}
          maxHeight={bottomPaneHeight - 1}
          scrollOffset={diffScrollOffset}
          theme={currentTheme}
        />
      );
    }

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

    if (bottomTab === 'history') {
      return (
        <HistoryDiffView
          commit={historySelectedCommit}
          diff={historyCommitDiff}
          maxHeight={bottomPaneHeight - 1}
          scrollOffset={diffScrollOffset}
          theme={currentTheme}
        />
      );
    }

    // Compare tab
    if (compareLoading) {
      return <Text dimColor>Loading compare diff...</Text>;
    }

    if (compareError) {
      return <Text color="red">{compareError}</Text>;
    }

    if (compareListSelection?.type === 'commit' && compareSelectionDiff) {
      return (
        <DiffView
          diff={compareSelectionDiff}
          maxHeight={bottomPaneHeight - 1}
          scrollOffset={diffScrollOffset}
          theme={currentTheme}
        />
      );
    }

    if (compareDiff) {
      return (
        <CompareView
          compareDiff={compareDiff}
          isLoading={false}
          error={null}
          scrollOffset={diffScrollOffset}
          maxHeight={bottomPaneHeight - 1}
          theme={currentTheme}
        />
      );
    }

    return <Text dimColor>No compare diff available</Text>;
  };

  // Explorer tab content
  if (bottomTab === 'explorer') {
    return (
      <Box
        flexDirection="column"
        height={bottomPaneHeight}
        width={terminalWidth}
        overflowY="hidden"
      >
        <Box width={terminalWidth}>
          <Text bold color={isDiffFocused ? 'cyan' : undefined}>
            FILE
          </Text>
          <Box flexGrow={1} justifyContent="flex-end">
            {renderHeaderRight()}
          </Box>
        </Box>
        <ExplorerContentView
          filePath={explorerSelectedFile?.path ?? null}
          content={explorerSelectedFile?.content ?? null}
          maxHeight={bottomPaneHeight - 1}
          scrollOffset={explorerFileScrollOffset}
          truncated={explorerSelectedFile?.truncated}
        />
      </Box>
    );
  }

  return (
    <Box flexDirection="column" height={bottomPaneHeight} width={terminalWidth} overflowY="hidden">
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
