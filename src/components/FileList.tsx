import React from 'react';
import { Box, Text } from 'ink';
import { FileEntry, FileStatus } from '../git/status.js';
import { shortenPath } from '../utils/formatPath.js';
import { categorizeFiles } from '../utils/fileCategories.js';

interface FileListProps {
  files: FileEntry[];
  selectedIndex: number;
  isFocused: boolean;
  scrollOffset?: number;
  maxHeight?: number;
  width?: number;
  onStage: (file: FileEntry) => void;
  onUnstage: (file: FileEntry) => void;
}

function getStatusChar(status: FileStatus): string {
  switch (status) {
    case 'modified':
      return 'M';
    case 'added':
      return 'A';
    case 'deleted':
      return 'D';
    case 'untracked':
      return '?';
    case 'renamed':
      return 'R';
    case 'copied':
      return 'C';
    default:
      return ' ';
  }
}

function getStatusColor(status: FileStatus): string {
  switch (status) {
    case 'modified':
      return 'yellow';
    case 'added':
      return 'green';
    case 'deleted':
      return 'red';
    case 'untracked':
      return 'gray';
    case 'renamed':
      return 'blue';
    case 'copied':
      return 'cyan';
    default:
      return 'white';
  }
}

interface FileRowProps {
  file: FileEntry;
  isSelected: boolean;
  isFocused: boolean;
  maxPathLength: number;
}

function formatStats(insertions?: number, deletions?: number): string | null {
  if (insertions === undefined && deletions === undefined) return null;
  const add = insertions ?? 0;
  const del = deletions ?? 0;
  if (add === 0 && del === 0) return null;
  const parts: string[] = [];
  if (add > 0) parts.push(`+${add}`);
  if (del > 0) parts.push(`-${del}`);
  return parts.join(' ');
}

function FileRow({ file, isSelected, isFocused, maxPathLength }: FileRowProps): React.ReactElement {
  const statusChar = getStatusChar(file.status);
  const statusColor = getStatusColor(file.status);
  const actionButton = file.staged ? '[-]' : '[+]';
  const buttonColor = file.staged ? 'red' : 'green';
  const stats = formatStats(file.insertions, file.deletions);
  const isHighlighted = isSelected && isFocused;

  // Calculate available space for path (account for stats if present)
  const statsLength = stats ? stats.length + 1 : 0;
  const availableForPath = maxPathLength - statsLength;
  const displayPath = shortenPath(file.path, availableForPath);

  return (
    <Box>
      <Text color={isHighlighted ? 'cyan' : undefined} bold={isHighlighted}>
        {isHighlighted ? '▸ ' : '  '}
      </Text>
      <Text color={buttonColor}>{actionButton} </Text>
      <Text color={statusColor}>{statusChar} </Text>
      <Text color={isHighlighted ? 'cyan' : undefined} inverse={isHighlighted}>
        {displayPath}
      </Text>
      {file.originalPath && <Text dimColor> ← {shortenPath(file.originalPath, 30)}</Text>}
      {stats && (
        <Text>
          <Text dimColor> </Text>
          {file.insertions !== undefined && file.insertions > 0 && (
            <Text color="green">+{file.insertions}</Text>
          )}
          {file.insertions !== undefined &&
            file.insertions > 0 &&
            file.deletions !== undefined &&
            file.deletions > 0 && <Text dimColor> </Text>}
          {file.deletions !== undefined && file.deletions > 0 && (
            <Text color="red">-{file.deletions}</Text>
          )}
        </Text>
      )}
    </Box>
  );
}

interface RowItem {
  type: 'header' | 'file' | 'spacer';
  content?: string;
  headerColor?: string;
  file?: FileEntry;
  fileIndex?: number;
}

export function FileList({
  files,
  selectedIndex,
  isFocused,
  scrollOffset = 0,
  maxHeight,
  width = 80,
}: FileListProps): React.ReactElement {
  // Calculate max path length: width minus prefix chars (▸/space + [+]/[-] + status + spaces = ~10)
  const maxPathLength = width - 10;
  // Split files into 3 categories: Modified, Untracked, Staged
  const {
    modified: modifiedFiles,
    untracked: untrackedFiles,
    staged: stagedFiles,
  } = categorizeFiles(files);

  if (files.length === 0) {
    return (
      <Box flexDirection="column">
        <Text dimColor> No changes</Text>
      </Box>
    );
  }

  // Build a flat list of all rows
  // Order: Modified → Untracked → Staged
  const rows: RowItem[] = [];
  let currentFileIndex = 0;

  if (modifiedFiles.length > 0) {
    rows.push({ type: 'header', content: 'Modified:', headerColor: 'yellow' });
    modifiedFiles.forEach((file) => {
      rows.push({ type: 'file', file, fileIndex: currentFileIndex++ });
    });
  }

  if (untrackedFiles.length > 0) {
    if (modifiedFiles.length > 0) {
      rows.push({ type: 'spacer' });
    }
    rows.push({ type: 'header', content: 'Untracked:', headerColor: 'gray' });
    untrackedFiles.forEach((file) => {
      rows.push({ type: 'file', file, fileIndex: currentFileIndex++ });
    });
  }

  if (stagedFiles.length > 0) {
    if (modifiedFiles.length > 0 || untrackedFiles.length > 0) {
      rows.push({ type: 'spacer' });
    }
    rows.push({ type: 'header', content: 'Staged:', headerColor: 'green' });
    stagedFiles.forEach((file) => {
      rows.push({ type: 'file', file, fileIndex: currentFileIndex++ });
    });
  }

  // Apply scroll offset and max height
  const visibleRows = maxHeight
    ? rows.slice(scrollOffset, scrollOffset + maxHeight)
    : rows.slice(scrollOffset);

  return (
    <Box flexDirection="column">
      {visibleRows.map((row, i) => {
        const key = `row-${scrollOffset + i}`;

        if (row.type === 'header') {
          return (
            <Text key={key} bold color={row.headerColor}>
              {row.content}
            </Text>
          );
        }

        if (row.type === 'spacer') {
          return <Text key={key}> </Text>;
        }

        if (row.type === 'file' && row.file !== undefined && row.fileIndex !== undefined) {
          return (
            <FileRow
              key={key}
              file={row.file}
              isSelected={row.fileIndex === selectedIndex}
              isFocused={isFocused}
              maxPathLength={maxPathLength}
            />
          );
        }

        return null;
      })}
    </Box>
  );
}

export function getFileAtIndex(files: FileEntry[], index: number): FileEntry | null {
  const { ordered } = categorizeFiles(files);
  return ordered[index] ?? null;
}

export function getTotalFileCount(files: FileEntry[]): number {
  return files.length;
}
