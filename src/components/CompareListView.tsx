import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { CommitInfo } from '../git/status.js';
import { CompareFileDiff } from '../git/diff.js';
import { shortenPath } from '../utils/formatPath.js';
import { formatDate } from '../utils/formatDate.js';
import { formatCommitDisplay } from '../utils/commitFormat.js';
import { ScrollableList } from './ScrollableList.js';

// Re-export from utils for backwards compatibility
export { getCompareItemIndexFromRow } from '../utils/rowCalculations.js';

export type CompareListSelectionType = 'commit' | 'file';

export interface CompareListSelection {
  type: CompareListSelectionType;
  index: number;
}

interface CompareListViewProps {
  commits: CommitInfo[];
  files: CompareFileDiff[];
  selectedItem: CompareListSelection | null;
  scrollOffset: number;
  maxHeight: number;
  isActive: boolean;
  width: number;
}

interface RowItem {
  type: 'section-header' | 'commit' | 'file' | 'spacer';
  sectionType?: 'commits' | 'files';
  commitIndex?: number;
  fileIndex?: number;
  commit?: CommitInfo;
  file?: CompareFileDiff;
}

function CommitRow({
  commit,
  isSelected,
  isActive,
  width,
}: {
  commit: CommitInfo;
  isSelected: boolean;
  isActive: boolean;
  width: number;
}): React.ReactElement {
  const dateStr = formatDate(commit.date);
  // Fixed parts: indent(2) + hash(7) + spaces(4) + date + parens(2)
  const baseWidth = 2 + 7 + 4 + dateStr.length + 2;
  const remainingWidth = width - baseWidth;

  const { displayMessage, displayRefs } = formatCommitDisplay(
    commit.message,
    commit.refs,
    remainingWidth
  );

  return (
    <Box>
      <Text> </Text>
      <Text color="yellow">{commit.shortHash}</Text>
      <Text> </Text>
      <Text
        color={isSelected && isActive ? 'cyan' : undefined}
        bold={isSelected && isActive}
        inverse={isSelected && isActive}
      >
        {displayMessage}
      </Text>
      <Text> </Text>
      <Text dimColor>({dateStr})</Text>
      {displayRefs && (
        <>
          <Text> </Text>
          <Text color="green">{displayRefs}</Text>
        </>
      )}
    </Box>
  );
}

function FileRow({
  file,
  isSelected,
  isActive,
  maxPathLength,
}: {
  file: CompareFileDiff;
  isSelected: boolean;
  isActive: boolean;
  maxPathLength: number;
}): React.ReactElement {
  const statusColors: Record<CompareFileDiff['status'], string> = {
    added: 'green',
    modified: 'yellow',
    deleted: 'red',
    renamed: 'blue',
  };

  const statusChars: Record<CompareFileDiff['status'], string> = {
    added: 'A',
    modified: 'M',
    deleted: 'D',
    renamed: 'R',
  };

  const isUncommitted = file.isUncommitted ?? false;
  // Account for stats: " (+123 -456)" and possible "[uncommitted]"
  const statsLength = 5 + String(file.additions).length + String(file.deletions).length;
  const uncommittedLength = isUncommitted ? 14 : 0;
  const availableForPath = maxPathLength - statsLength - uncommittedLength;

  return (
    <Box>
      <Text> </Text>
      {isUncommitted && (
        <Text color="magenta" bold>
          *
        </Text>
      )}
      <Text color={isUncommitted ? 'magenta' : statusColors[file.status]} bold>
        {statusChars[file.status]}
      </Text>
      <Text
        bold={isSelected && isActive}
        color={isSelected && isActive ? 'cyan' : isUncommitted ? 'magenta' : undefined}
        inverse={isSelected && isActive}
      >
        {' '}
        {shortenPath(file.path, availableForPath)}
      </Text>
      <Text dimColor> (</Text>
      <Text color="green">+{file.additions}</Text>
      <Text dimColor> </Text>
      <Text color="red">-{file.deletions}</Text>
      <Text dimColor>)</Text>
      {isUncommitted && (
        <Text color="magenta" dimColor>
          {' '}
          [uncommitted]
        </Text>
      )}
    </Box>
  );
}

export function CompareListView({
  commits,
  files,
  selectedItem,
  scrollOffset,
  maxHeight,
  isActive,
  width,
}: CompareListViewProps): React.ReactElement {
  // Note: expand/collapse functionality is prepared but not exposed yet
  const commitsExpanded = true;
  const filesExpanded = true;

  // Build flat list of rows
  const rows = useMemo(() => {
    const result: RowItem[] = [];

    // Commits section
    if (commits.length > 0) {
      result.push({ type: 'section-header', sectionType: 'commits' });
      if (commitsExpanded) {
        commits.forEach((commit, i) => {
          result.push({ type: 'commit', commitIndex: i, commit });
        });
      }
    }

    // Files section
    if (files.length > 0) {
      if (commits.length > 0) {
        result.push({ type: 'spacer' });
      }
      result.push({ type: 'section-header', sectionType: 'files' });
      if (filesExpanded) {
        files.forEach((file, i) => {
          result.push({ type: 'file', fileIndex: i, file });
        });
      }
    }

    return result;
  }, [commits, files, commitsExpanded, filesExpanded]);

  if (commits.length === 0 && files.length === 0) {
    return (
      <Box flexDirection="column">
        <Text dimColor>No changes compared to base branch</Text>
      </Box>
    );
  }

  const renderRow = (row: RowItem): React.ReactElement | null => {
    if (row.type === 'section-header') {
      const isCommits = row.sectionType === 'commits';
      const expanded = isCommits ? commitsExpanded : filesExpanded;
      const count = isCommits ? commits.length : files.length;
      const label = isCommits ? 'Commits' : 'Files';

      return (
        <Box>
          <Text bold color="cyan">
            {expanded ? '▼' : '▶'} {label}
          </Text>
          <Text dimColor> ({count})</Text>
        </Box>
      );
    }

    if (row.type === 'spacer') {
      return <Text> </Text>;
    }

    if (row.type === 'commit' && row.commit !== undefined && row.commitIndex !== undefined) {
      const isSelected = selectedItem?.type === 'commit' && selectedItem.index === row.commitIndex;
      return (
        <CommitRow commit={row.commit} isSelected={isSelected} isActive={isActive} width={width} />
      );
    }

    if (row.type === 'file' && row.file !== undefined && row.fileIndex !== undefined) {
      const isSelected = selectedItem?.type === 'file' && selectedItem.index === row.fileIndex;
      return (
        <FileRow
          file={row.file}
          isSelected={isSelected}
          isActive={isActive}
          maxPathLength={width - 5}
        />
      );
    }

    return null;
  };

  return (
    <ScrollableList
      items={rows}
      maxHeight={maxHeight}
      scrollOffset={scrollOffset}
      getKey={(_row, i) => `row-${i}`}
      renderItem={(row) => renderRow(row)}
    />
  );
}

// Helper to get total row count for scrolling
export function getCompareListTotalRows(
  commits: CommitInfo[],
  files: CompareFileDiff[],
  commitsExpanded: boolean = true,
  filesExpanded: boolean = true
): number {
  let count = 0;
  if (commits.length > 0) {
    count += 1; // header
    if (commitsExpanded) count += commits.length;
  }
  if (files.length > 0) {
    if (commits.length > 0) count += 1; // spacer
    count += 1; // header
    if (filesExpanded) count += files.length;
  }
  return count;
}
