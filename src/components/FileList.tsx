import React from 'react';
import { Box, Text } from 'ink';
import { FileEntry, FileStatus } from '../git/status.js';

interface FileListProps {
  files: FileEntry[];
  selectedIndex: number;
  isFocused: boolean;
  scrollOffset?: number;
  maxHeight?: number;
  onStage: (file: FileEntry) => void;
  onUnstage: (file: FileEntry) => void;
}

function getStatusChar(status: FileStatus): string {
  switch (status) {
    case 'modified': return 'M';
    case 'added': return 'A';
    case 'deleted': return 'D';
    case 'untracked': return '?';
    case 'renamed': return 'R';
    case 'copied': return 'C';
    default: return ' ';
  }
}

function getStatusColor(status: FileStatus): string {
  switch (status) {
    case 'modified': return 'yellow';
    case 'added': return 'green';
    case 'deleted': return 'red';
    case 'untracked': return 'gray';
    case 'renamed': return 'blue';
    case 'copied': return 'cyan';
    default: return 'white';
  }
}

interface FileRowProps {
  file: FileEntry;
  isSelected: boolean;
  isFocused: boolean;
}

function FileRow({ file, isSelected, isFocused }: FileRowProps): React.ReactElement {
  const statusChar = getStatusChar(file.status);
  const statusColor = getStatusColor(file.status);
  const actionButton = file.staged ? '[-]' : '[+]';
  const buttonColor = file.staged ? 'red' : 'green';

  return (
    <Box>
      {isSelected && isFocused ? (
        <Text color="cyan" bold>▸ </Text>
      ) : (
        <Text>  </Text>
      )}
      <Text color={buttonColor}>{actionButton} </Text>
      <Text color={statusColor}>{statusChar} </Text>
      <Text color={isSelected && isFocused ? 'cyan' : undefined}>
        {file.path}
        {file.originalPath && <Text dimColor> (from {file.originalPath})</Text>}
      </Text>
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
}: FileListProps): React.ReactElement {
  const stagedFiles = files.filter(f => f.staged);
  const unstagedFiles = files.filter(f => !f.staged);

  if (files.length === 0) {
    return (
      <Box flexDirection="column">
        <Text dimColor> No changes</Text>
      </Box>
    );
  }

  // Build a flat list of all rows
  const rows: RowItem[] = [];

  if (unstagedFiles.length > 0) {
    rows.push({ type: 'header', content: 'Unstaged Changes:', headerColor: 'yellow' });
    unstagedFiles.forEach((file, i) => {
      rows.push({ type: 'file', file, fileIndex: i });
    });
  }

  if (unstagedFiles.length > 0 && stagedFiles.length > 0) {
    rows.push({ type: 'spacer' });
  }

  if (stagedFiles.length > 0) {
    rows.push({ type: 'header', content: 'Staged Changes:', headerColor: 'green' });
    stagedFiles.forEach((file, i) => {
      rows.push({ type: 'file', file, fileIndex: unstagedFiles.length + i });
    });
  }

  // Apply scroll offset and max height
  const visibleRows = maxHeight ? rows.slice(scrollOffset, scrollOffset + maxHeight) : rows.slice(scrollOffset);

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
            />
          );
        }

        return null;
      })}
    </Box>
  );
}

export function getFileAtIndex(files: FileEntry[], index: number): FileEntry | null {
  const unstagedFiles = files.filter(f => !f.staged);
  const stagedFiles = files.filter(f => f.staged);
  const allFiles = [...unstagedFiles, ...stagedFiles];
  return allFiles[index] ?? null;
}

export function getTotalFileCount(files: FileEntry[]): number {
  return files.length;
}
