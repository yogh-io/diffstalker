import React, { useState, useMemo } from 'react';
import { Box, Text } from 'ink';
import { CommitInfo } from '../git/status.js';
import { PRFileDiff } from '../git/diff.js';

export type PRListSelectionType = 'commit' | 'file';

export interface PRListSelection {
  type: PRListSelectionType;
  index: number;
}

interface PRListViewProps {
  commits: CommitInfo[];
  files: PRFileDiff[];
  selectedItem: PRListSelection | null;
  scrollOffset: number;
  maxHeight: number;
  isActive: boolean;
  width: number;
  includeUncommitted: boolean;
  onSelectCommit: (index: number) => void;
  onSelectFile: (index: number) => void;
  onToggleIncludeUncommitted: () => void;
}

interface RowItem {
  type: 'section-header' | 'commit' | 'file' | 'spacer';
  sectionType?: 'commits' | 'files';
  commitIndex?: number;
  fileIndex?: number;
  commit?: CommitInfo;
  file?: PRFileDiff;
}

function formatDate(date: Date): string {
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));

  if (days === 0) {
    const hours = Math.floor(diff / (1000 * 60 * 60));
    if (hours === 0) {
      const mins = Math.floor(diff / (1000 * 60));
      return `${mins}m ago`;
    }
    return `${hours}h ago`;
  } else if (days === 1) {
    return 'yesterday';
  } else if (days < 7) {
    return `${days}d ago`;
  } else if (days < 30) {
    const weeks = Math.floor(days / 7);
    return `${weeks}w ago`;
  } else {
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
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
  // Calculate available space
  const fixedWidth = 2 + 7 + 4 + dateStr.length + 2 + (commit.refs ? commit.refs.length + 1 : 0);
  const availableWidth = Math.max(20, width - fixedWidth);

  const needsTruncation = commit.message.length > availableWidth;
  const displayMessage = needsTruncation
    ? commit.message.slice(0, availableWidth - 3) + '...'
    : commit.message;

  return (
    <Box>
      <Text>  </Text>
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
      {commit.refs && (
        <>
          <Text> </Text>
          <Text color="green">{commit.refs}</Text>
        </>
      )}
    </Box>
  );
}

function FileRow({
  file,
  isSelected,
  isActive,
}: {
  file: PRFileDiff;
  isSelected: boolean;
  isActive: boolean;
}): React.ReactElement {
  const statusColors: Record<PRFileDiff['status'], string> = {
    added: 'green',
    modified: 'yellow',
    deleted: 'red',
    renamed: 'blue',
  };

  const statusChars: Record<PRFileDiff['status'], string> = {
    added: 'A',
    modified: 'M',
    deleted: 'D',
    renamed: 'R',
  };

  const isUncommitted = file.isUncommitted ?? false;

  return (
    <Box>
      <Text>  </Text>
      {isUncommitted && <Text color="magenta" bold>*</Text>}
      <Text color={isUncommitted ? 'magenta' : statusColors[file.status]} bold>
        {statusChars[file.status]}
      </Text>
      <Text
        bold={isSelected && isActive}
        color={isSelected && isActive ? 'cyan' : isUncommitted ? 'magenta' : undefined}
        inverse={isSelected && isActive}
      >
        {' '}{file.path}
      </Text>
      <Text dimColor> (</Text>
      <Text color="green">+{file.additions}</Text>
      <Text dimColor> </Text>
      <Text color="red">-{file.deletions}</Text>
      <Text dimColor>)</Text>
      {isUncommitted && <Text color="magenta" dimColor> [uncommitted]</Text>}
    </Box>
  );
}

export function PRListView({
  commits,
  files,
  selectedItem,
  scrollOffset,
  maxHeight,
  isActive,
  width,
  includeUncommitted,
  onSelectCommit,
  onSelectFile,
  onToggleIncludeUncommitted,
}: PRListViewProps): React.ReactElement {
  const [commitsExpanded, setCommitsExpanded] = useState(true);
  const [filesExpanded, setFilesExpanded] = useState(true);

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

  const visibleRows = rows.slice(scrollOffset, scrollOffset + maxHeight);

  if (commits.length === 0 && files.length === 0) {
    return (
      <Box flexDirection="column">
        <Text dimColor>No changes compared to base branch</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {visibleRows.map((row, i) => {
        const key = `row-${scrollOffset + i}`;

        if (row.type === 'section-header') {
          const isCommits = row.sectionType === 'commits';
          const expanded = isCommits ? commitsExpanded : filesExpanded;
          const count = isCommits ? commits.length : files.length;
          const label = isCommits ? 'Commits' : 'Files';

          return (
            <Box key={key}>
              <Text bold color="cyan">
                {expanded ? '▼' : '▶'} {label}
              </Text>
              <Text dimColor> ({count})</Text>
            </Box>
          );
        }

        if (row.type === 'spacer') {
          return <Text key={key}> </Text>;
        }

        if (row.type === 'commit' && row.commit !== undefined && row.commitIndex !== undefined) {
          const isSelected = selectedItem?.type === 'commit' && selectedItem.index === row.commitIndex;
          return (
            <CommitRow
              key={key}
              commit={row.commit}
              isSelected={isSelected}
              isActive={isActive}
              width={width}
            />
          );
        }

        if (row.type === 'file' && row.file !== undefined && row.fileIndex !== undefined) {
          const isSelected = selectedItem?.type === 'file' && selectedItem.index === row.fileIndex;
          return (
            <FileRow
              key={key}
              file={row.file}
              isSelected={isSelected}
              isActive={isActive}
            />
          );
        }

        return null;
      })}
    </Box>
  );
}

// Helper to get total row count for scrolling
export function getPRListTotalRows(
  commits: CommitInfo[],
  files: PRFileDiff[],
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
