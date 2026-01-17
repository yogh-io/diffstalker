import React from 'react';
import { Box, Text } from 'ink';
import { PRDiff, PRFileDiff, DiffLine } from '../git/diff.js';

interface PRViewProps {
  prDiff: PRDiff | null;
  isLoading: boolean;
  error: string | null;
  scrollOffset: number;
  maxHeight: number;
  width: number;
  isActive: boolean;
}

interface RenderRow {
  type: 'file-header' | 'diff-line';
  fileIndex: number;
  content: DiffLine | PRFileDiff;
}

function DiffLineComponent({ line }: { line: DiffLine }): React.ReactElement {
  let color: string | undefined;
  let dimColor = false;

  switch (line.type) {
    case 'addition':
      color = 'green';
      break;
    case 'deletion':
      color = 'red';
      break;
    case 'hunk':
      color = 'cyan';
      break;
    case 'header':
      color = 'yellow';
      dimColor = true;
      break;
    case 'context':
    default:
      break;
  }

  return (
    <Text color={color} dimColor={dimColor}>
      {'  '}{line.content}
    </Text>
  );
}

function FileHeaderComponent({ file }: { file: PRFileDiff }): React.ReactElement {
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

  return (
    <Box>
      <Text color={statusColors[file.status]} bold>{statusChars[file.status]}</Text>
      <Text bold> {file.path}</Text>
      <Text dimColor> (</Text>
      <Text color="green">+{file.additions}</Text>
      <Text dimColor> </Text>
      <Text color="red">-{file.deletions}</Text>
      <Text dimColor>)</Text>
    </Box>
  );
}

export function PRView({
  prDiff,
  isLoading,
  error,
  scrollOffset,
  maxHeight,
  width,
  isActive,
}: PRViewProps): React.ReactElement {
  // Header line
  const renderHeader = (): React.ReactElement => {
    if (isLoading) {
      return (
        <Box>
          <Text dimColor>Loading PR diff...</Text>
        </Box>
      );
    }

    if (error) {
      return (
        <Box>
          <Text color="red">{error}</Text>
        </Box>
      );
    }

    if (!prDiff) {
      return (
        <Box>
          <Text dimColor>No base branch found (no origin/main or origin/master)</Text>
        </Box>
      );
    }

    const { baseBranch, stats, uncommittedCount } = prDiff;

    return (
      <Box>
        <Text>Comparing with </Text>
        <Text color="cyan" bold>{baseBranch}</Text>
        <Text dimColor> | </Text>
        <Text>{stats.filesChanged} file{stats.filesChanged !== 1 ? 's' : ''}</Text>
        <Text dimColor> | </Text>
        <Text color="green">+{stats.additions}</Text>
        <Text> </Text>
        <Text color="red">-{stats.deletions}</Text>
        {uncommittedCount > 0 && (
          <>
            <Text dimColor> | </Text>
            <Text color="yellow">{uncommittedCount} uncommitted</Text>
          </>
        )}
      </Box>
    );
  };

  // Build flat list of renderable rows
  const buildRows = (): RenderRow[] => {
    if (!prDiff || prDiff.files.length === 0) return [];

    const rows: RenderRow[] = [];
    for (let fileIndex = 0; fileIndex < prDiff.files.length; fileIndex++) {
      const file = prDiff.files[fileIndex];

      // File header
      rows.push({ type: 'file-header', fileIndex, content: file });

      // Diff lines (skip the raw diff header lines, start from hunk)
      for (const line of file.diff.lines) {
        // Skip redundant header lines as we already show file header
        if (line.type === 'header') continue;
        rows.push({ type: 'diff-line', fileIndex, content: line });
      }
    }
    return rows;
  };

  const allRows = buildRows();
  const contentHeight = maxHeight - 2; // Reserve for header and indicators
  const visibleRows = allRows.slice(scrollOffset, scrollOffset + contentHeight);
  const hasMore = allRows.length > scrollOffset + contentHeight;
  const hasPrevious = scrollOffset > 0;

  return (
    <Box flexDirection="column" paddingX={1}>
      {renderHeader()}

      {prDiff && prDiff.files.length === 0 && (
        <Text dimColor>No changes compared to {prDiff.baseBranch}</Text>
      )}

      {hasPrevious && (
        <Text dimColor>↑ {scrollOffset} more lines above</Text>
      )}

      {visibleRows.map((row, i) => {
        if (row.type === 'file-header') {
          return <FileHeaderComponent key={`header-${row.fileIndex}`} file={row.content as PRFileDiff} />;
        }
        const line = row.content as DiffLine;
        return (
          <DiffLineComponent
            key={`line-${scrollOffset + i}-${line.content.slice(0, 20)}`}
            line={line}
          />
        );
      })}

      {hasMore && (
        <Text dimColor>↓ {allRows.length - scrollOffset - contentHeight} more lines below</Text>
      )}
    </Box>
  );
}
