import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { CompareDiff } from '../git/diff.js';
import { DiffView } from './DiffView.js';
import { ThemeName } from '../themes.js';
import { buildCombinedCompareDiff } from '../utils/rowCalculations.js';

// Re-export from utils for backwards compatibility
export {
  buildCombinedCompareDiff,
  getCompareDiffTotalRows,
  getFileScrollOffset,
} from '../utils/rowCalculations.js';

interface CompareViewProps {
  compareDiff: CompareDiff | null;
  isLoading: boolean;
  error: string | null;
  scrollOffset: number;
  maxHeight: number;
  theme?: ThemeName;
  width?: number;
}

export function CompareView({
  compareDiff,
  isLoading,
  error,
  scrollOffset,
  maxHeight,
  theme = 'dark',
  width,
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
      width={width}
    />
  );
}
