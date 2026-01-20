import React, { useState, useMemo } from 'react';
import { Box, Text } from 'ink';
import { CommitInfo } from '../git/status.js';
import { CompareFileDiff } from '../git/diff.js';
import { shortenPath } from '../utils/formatPath.js';

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
  file?: CompareFileDiff;
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
  } else if (days <= 14) {
    return `${days}d ago`;
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
  // Fixed parts: indent(2) + hash(7) + spaces(4) + date + parens(2)
  const baseWidth = 2 + 7 + 4 + dateStr.length + 2;

  // Calculate space available for message and refs combined
  const remainingWidth = width - baseWidth;

  // Allocate space: prioritize message (min 20 chars), rest for refs
  const minMessageWidth = 20;
  const maxRefsWidth = Math.max(0, remainingWidth - minMessageWidth - 1); // -1 for space before refs

  // Truncate refs if needed
  let displayRefs = commit.refs || '';
  if (displayRefs.length > maxRefsWidth && maxRefsWidth > 3) {
    displayRefs = displayRefs.slice(0, maxRefsWidth - 3) + '...';
  } else if (displayRefs.length > maxRefsWidth) {
    displayRefs = ''; // Not enough space for refs
  }

  // Calculate message width (remaining space after refs)
  const refsWidth = displayRefs ? displayRefs.length + 1 : 0; // +1 for space
  const messageWidth = Math.max(minMessageWidth, remainingWidth - refsWidth);

  // Truncate message if needed
  const needsTruncation = commit.message.length > messageWidth;
  const displayMessage = needsTruncation
    ? commit.message.slice(0, messageWidth - 3) + '...'
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
        {' '}{shortenPath(file.path, availableForPath)}
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

export function CompareListView({
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
}: CompareListViewProps): React.ReactElement {
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
              maxPathLength={width - 5}
            />
          );
        }

        return null;
      })}
    </Box>
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

/**
 * Map a visual row index (from click) to the actual compareSelectedIndex.
 * Returns -1 if the row is a header or spacer (not selectable).
 * Visual structure (with both sections expanded):
 *   Row 0: "▼ Commits" header
 *   Rows 1..N: commits
 *   Row N+1: spacer (if both sections exist)
 *   Row N+2: "▼ Files" header
 *   Rows N+3..: files
 */
export function getCompareItemIndexFromRow(
  row: number,
  commitCount: number,
  fileCount: number,
  commitsExpanded: boolean = true,
  filesExpanded: boolean = true
): number {
  let currentRow = 0;

  // Commits section
  if (commitCount > 0) {
    if (row === currentRow) return -1; // "▼ Commits" header
    currentRow++;

    if (commitsExpanded) {
      if (row < currentRow + commitCount) {
        return row - currentRow; // Commit index
      }
      currentRow += commitCount;
    }
  }

  // Files section
  if (fileCount > 0) {
    if (commitCount > 0) {
      if (row === currentRow) return -1; // Spacer
      currentRow++;
    }

    if (row === currentRow) return -1; // "▼ Files" header
    currentRow++;

    if (filesExpanded) {
      if (row < currentRow + fileCount) {
        return commitCount + (row - currentRow); // File index (offset by commit count)
      }
    }
  }

  return -1; // Out of bounds
}
