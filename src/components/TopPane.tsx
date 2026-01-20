import React from 'react';
import { Box, Text } from 'ink';
import { FileEntry, CommitInfo } from '../git/status.js';
import { CompareDiff } from '../git/diff.js';
import { FileList } from './FileList.js';
import { HistoryView } from './HistoryView.js';
import { CompareListView, CompareListSelection } from './CompareListView.js';
import { BottomTab, Pane } from '../hooks/useKeymap.js';

interface TopPaneProps {
  bottomTab: BottomTab;
  currentPane: Pane;
  terminalWidth: number;
  topPaneHeight: number;

  // File list props
  files: FileEntry[];
  selectedIndex: number;
  fileListScrollOffset: number;
  stagedCount: number;
  onStage: (file: FileEntry) => void;
  onUnstage: (file: FileEntry) => void;

  // History props
  commits: CommitInfo[];
  historySelectedIndex: number;
  historyScrollOffset: number;
  onSelectHistoryCommit: (commit: CommitInfo, index: number) => void;

  // Compare props
  compareDiff: CompareDiff | null;
  compareListSelection: CompareListSelection | null;
  compareScrollOffset: number;
  includeUncommitted: boolean;
  onSelectCompareCommit: (index: number) => void;
  onSelectCompareFile: (index: number) => void;
  onToggleIncludeUncommitted: () => void;
}

export function TopPane({
  bottomTab,
  currentPane,
  terminalWidth,
  topPaneHeight,
  files,
  selectedIndex,
  fileListScrollOffset,
  stagedCount,
  onStage,
  onUnstage,
  commits,
  historySelectedIndex,
  historyScrollOffset,
  onSelectHistoryCommit,
  compareDiff,
  compareListSelection,
  compareScrollOffset,
  includeUncommitted,
  onSelectCompareCommit,
  onSelectCompareFile,
  onToggleIncludeUncommitted,
}: TopPaneProps): React.ReactElement {
  const modifiedCount = files.filter(f => !f.staged && f.status !== 'untracked').length;
  const untrackedCount = files.filter(f => f.status === 'untracked').length;

  return (
    <Box flexDirection="column" height={topPaneHeight} width={terminalWidth} overflowY="hidden">
      {(bottomTab === 'diff' || bottomTab === 'commit') && (
        <>
          <Box>
            <Text bold color={currentPane === 'files' ? 'cyan' : undefined}>STAGING AREA</Text>
            <Text dimColor> ({modifiedCount} modified, {untrackedCount} untracked, {stagedCount} staged)</Text>
          </Box>
          <FileList
            files={files}
            selectedIndex={selectedIndex}
            isFocused={currentPane === 'files'}
            scrollOffset={fileListScrollOffset}
            maxHeight={topPaneHeight - 1}
            width={terminalWidth}
            onStage={onStage}
            onUnstage={onUnstage}
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
            onSelectCommit={onSelectHistoryCommit}
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
            onSelectCommit={onSelectCompareCommit}
            onSelectFile={onSelectCompareFile}
            onToggleIncludeUncommitted={onToggleIncludeUncommitted}
          />
        </>
      )}
    </Box>
  );
}
