import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { CompareDiff, DiffResult, DiffLine } from '../git/diff.js';
import { DiffView } from './DiffView.js';
import { ThemeName } from '../themes.js';

interface CompareViewProps {
  compareDiff: CompareDiff | null;
  isLoading: boolean;
  error: string | null;
  scrollOffset: number;
  maxHeight: number;
  theme?: ThemeName;
}

/**
 * Build a combined DiffResult from all compare files.
 * This is the single source of truth for compare diff content.
 */
export function buildCombinedCompareDiff(compareDiff: CompareDiff | null): DiffResult {
  if (!compareDiff || compareDiff.files.length === 0) {
    return { raw: '', lines: [] };
  }

  const allLines: DiffLine[] = [];
  const rawParts: string[] = [];

  for (const file of compareDiff.files) {
    // Include all lines from each file's diff (including headers)
    for (const line of file.diff.lines) {
      allLines.push(line);
    }
    rawParts.push(file.diff.raw);
  }

  return {
    raw: rawParts.join('\n'),
    lines: allLines,
  };
}

/**
 * Calculate the total number of displayable lines in the compare diff.
 * This accounts for header filtering done by DiffView.
 */
export function getCompareDiffTotalRows(compareDiff: CompareDiff | null): number {
  const combined = buildCombinedCompareDiff(compareDiff);
  // DiffView filters out certain headers (index, ---, +++, similarity index)
  return combined.lines.filter(line => {
    if (line.type !== 'header') return true;
    const content = line.content;
    if (content.startsWith('index ') ||
        content.startsWith('--- ') ||
        content.startsWith('+++ ') ||
        content.startsWith('similarity index')) {
      return false;
    }
    return true;
  }).length;
}

/**
 * Calculate the row offset to scroll to a specific file in the compare diff.
 * Returns the row index where the file's diff --git header starts.
 */
export function getFileScrollOffset(compareDiff: CompareDiff | null, fileIndex: number): number {
  if (!compareDiff || fileIndex < 0 || fileIndex >= compareDiff.files.length) return 0;

  const combined = buildCombinedCompareDiff(compareDiff);
  let displayableRow = 0;
  let currentFileIndex = 0;

  for (const line of combined.lines) {
    // Check if this is a file boundary
    if (line.type === 'header' && line.content.startsWith('diff --git')) {
      if (currentFileIndex === fileIndex) {
        return displayableRow;
      }
      currentFileIndex++;
    }

    // Skip lines that DiffView filters out
    if (line.type === 'header') {
      const content = line.content;
      if (content.startsWith('index ') ||
          content.startsWith('--- ') ||
          content.startsWith('+++ ') ||
          content.startsWith('similarity index')) {
        continue;
      }
    }
    displayableRow++;
  }

  return 0;
}

export function CompareView({
  compareDiff,
  isLoading,
  error,
  scrollOffset,
  maxHeight,
  theme = 'dark',
}: CompareViewProps): React.ReactElement {
  // Build combined diff for DiffView
  const combinedDiff = useMemo(() => buildCombinedCompareDiff(compareDiff), [compareDiff]);

  if (isLoading) {
    return (
      <Box paddingX={1}>
        <Text dimColor>Loading diff...</Text>
      </Box>
    );
  }

  if (error) {
    return (
      <Box paddingX={1}>
        <Text color="red">{error}</Text>
      </Box>
    );
  }

  if (!compareDiff) {
    return (
      <Box paddingX={1}>
        <Text dimColor>No base branch found (no origin/main or origin/master)</Text>
      </Box>
    );
  }

  if (compareDiff.files.length === 0) {
    return (
      <Box paddingX={1}>
        <Text dimColor>No changes compared to {compareDiff.baseBranch}</Text>
      </Box>
    );
  }

  // Use DiffView for the actual diff rendering (word-level highlighting, themes, line numbers)
  return (
    <DiffView
      diff={combinedDiff}
      maxHeight={maxHeight}
      scrollOffset={scrollOffset}
      theme={theme}
    />
  );
}
