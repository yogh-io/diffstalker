import React from 'react';
import { Box, Text } from 'ink';
import { FileEntry, CommitInfo } from '../git/status.js';
import { CompareDiff } from '../git/diff.js';
import { FileList } from './FileList.js';
import { HistoryView } from './HistoryView.js';
import { CompareListView, CompareListSelection } from './CompareListView.js';
import { ExplorerView, buildBreadcrumbs } from './ExplorerView.js';
import { ExplorerItem } from '../hooks/useExplorerState.js';
import { BottomTab, Pane } from '../hooks/useKeymap.js';
import { categorizeFiles } from '../utils/fileCategories.js';

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

  // Explorer props
  explorerCurrentPath?: string;
  explorerItems?: ExplorerItem[];
  explorerSelectedIndex?: number;
  explorerScrollOffset?: number;
  explorerIsLoading?: boolean;
  explorerError?: string | null;
  hideHiddenFiles?: boolean;
  hideGitignored?: boolean;
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
  explorerCurrentPath = '',
  explorerItems = [],
  explorerSelectedIndex = 0,
  explorerScrollOffset = 0,
  explorerIsLoading = false,
  explorerError = null,
  hideHiddenFiles = true,
  hideGitignored = true,
}: TopPaneProps): React.ReactElement {
  const { modified, untracked } = categorizeFiles(files);
  const modifiedCount = modified.length;
  const untrackedCount = untracked.length;

  return (
    <Box
      flexDirection="column"
      height={topPaneHeight}
      width={terminalWidth}
      overflowX="hidden"
      overflowY="hidden"
    >
      {(bottomTab === 'diff' || bottomTab === 'commit') && (
        <>
          <Box>
            <Text bold color={currentPane === 'files' ? 'cyan' : undefined}>
              STAGING AREA
            </Text>
            <Text dimColor>
              {' '}
              ({modifiedCount} modified, {untrackedCount} untracked, {stagedCount} staged)
            </Text>
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
            <Text bold color={currentPane === 'history' ? 'cyan' : undefined}>
              COMMITS
            </Text>
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
            <Text bold color={currentPane === 'compare' ? 'cyan' : undefined}>
              COMPARE
            </Text>
            <Text dimColor> (vs </Text>
            <Text color="cyan">{compareDiff?.baseBranch ?? '...'}</Text>
            <Text dimColor>
              : {compareDiff?.commits.length ?? 0} commits, {compareDiff?.files.length ?? 0} files)
              (b)
            </Text>
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
          />
        </>
      )}
      {bottomTab === 'explorer' && (
        <>
          <Box justifyContent="space-between" width={terminalWidth}>
            <Box>
              <Text bold color={currentPane === 'explorer' ? 'cyan' : undefined}>
                EXPLORER
              </Text>
              <Text dimColor> </Text>
              {buildBreadcrumbs(explorerCurrentPath).map((segment, i, arr) => (
                <React.Fragment key={i}>
                  <Text color="blue">{segment}</Text>
                  {i < arr.length - 1 && <Text dimColor> / </Text>}
                </React.Fragment>
              ))}
              {explorerCurrentPath && <Text dimColor> /</Text>}
              {!explorerCurrentPath && <Text dimColor>(root)</Text>}
            </Box>
            <Box>
              {(hideHiddenFiles || hideGitignored) && (
                <Text dimColor>
                  {hideHiddenFiles && 'H'}
                  {hideGitignored && 'G'}
                </Text>
              )}
            </Box>
          </Box>
          <ExplorerView
            currentPath={explorerCurrentPath}
            items={explorerItems}
            selectedIndex={explorerSelectedIndex}
            scrollOffset={explorerScrollOffset}
            maxHeight={topPaneHeight - 1}
            isActive={currentPane === 'explorer'}
            width={terminalWidth}
            isLoading={explorerIsLoading}
            error={explorerError}
          />
        </>
      )}
    </Box>
  );
}
