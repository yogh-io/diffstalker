import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { CommitInfo } from '../git/status.js';
import { DiffResult } from '../git/diff.js';
import { DiffView } from './DiffView.js';
import { ThemeName } from '../themes.js';
import { buildHistoryDiffRows } from '../utils/rowCalculations.js';
import { isDisplayableDiffLine } from '../utils/diffFilters.js';

// Re-export from utils for backwards compatibility
export { buildHistoryDiffRows, getHistoryDiffTotalRows } from '../utils/rowCalculations.js';

// Re-export type for external use
export type { HistoryDiffRow } from '../utils/rowCalculations.js';

interface HistoryDiffViewProps {
  commit: CommitInfo | null;
  diff: DiffResult | null;
  scrollOffset: number;
  maxHeight: number;
  theme?: ThemeName;
  width?: number;
}

export function HistoryDiffView({
  commit,
  diff,
  scrollOffset,
  maxHeight,
  theme = 'dark',
  width,
}: HistoryDiffViewProps): React.ReactElement {
  // Build rows using shared function
  const allRows = useMemo(() => buildHistoryDiffRows(commit, diff), [commit, diff]);

  // Find where diff starts (after commit metadata)
  const diffStartIndex = useMemo(() => {
    for (let i = 0; i < allRows.length; i++) {
      if (allRows[i].type === 'diff-line') {
        return i;
      }
    }
    return allRows.length;
  }, [allRows]);

  // Calculate how many header rows are visible vs scrolled past
  const visibleRows = allRows.slice(scrollOffset, scrollOffset + maxHeight);

  if (!commit) {
    return (
      <Box paddingX={1}>
        <Text dimColor>Select a commit to view its diff</Text>
      </Box>
    );
  }

  if (!diff || diff.lines.length === 0) {
    // Show commit info even if no diff
    return (
      <Box flexDirection="column">
        {visibleRows.map((row, i) => {
          const key = `row-${scrollOffset + i}`;
          if (row.type === 'commit-header') {
            return (
              <Box key={key}>
                <Text color="yellow">{row.content}</Text>
              </Box>
            );
          }
          if (row.type === 'commit-message') {
            return (
              <Box key={key}>
                <Text>{row.content}</Text>
              </Box>
            );
          }
          if (row.type === 'spacer') {
            return (
              <Box key={key}>
                <Text> </Text>
              </Box>
            );
          }
          return null;
        })}
        <Box>
          <Text dimColor>No changes in this commit</Text>
        </Box>
      </Box>
    );
  }

  // Render visible rows
  // For diff lines, we delegate to DiffView for proper highlighting
  // But we need to handle the mixed content (headers + diff)

  // Build filtered diff lines (computed once, used in both branches below)
  const diffOnlyLines = diff.lines.filter(isDisplayableDiffLine);

  // If scroll is past all headers, just use DiffView directly with adjusted offset
  if (scrollOffset >= diffStartIndex) {
    return (
      <DiffView
        diff={{ raw: diff.raw, lines: diffOnlyLines }}
        maxHeight={maxHeight}
        scrollOffset={scrollOffset - diffStartIndex}
        theme={theme}
        width={width}
      />
    );
  }

  // Mixed view: some header rows visible, then diff
  const headerRowsToShow = visibleRows.filter((r) => r.type !== 'diff-line');
  const diffRowsVisible = maxHeight - headerRowsToShow.length;

  return (
    <Box flexDirection="column" overflowX="hidden">
      {visibleRows.map((row, i) => {
        const key = `row-${scrollOffset + i}`;

        if (row.type === 'commit-header') {
          return (
            <Box key={key}>
              <Text color="yellow">{row.content}</Text>
            </Box>
          );
        }
        if (row.type === 'commit-message') {
          return (
            <Box key={key}>
              <Text>{row.content}</Text>
            </Box>
          );
        }
        if (row.type === 'spacer') {
          return (
            <Box key={key}>
              <Text> </Text>
            </Box>
          );
        }

        // For diff lines, we've reached the diff section
        // Render remaining space with DiffView
        return null;
      })}
      {diffRowsVisible > 0 && (
        <DiffView
          diff={{ raw: diff.raw, lines: diffOnlyLines }}
          maxHeight={diffRowsVisible}
          scrollOffset={0}
          theme={theme}
          width={width}
        />
      )}
    </Box>
  );
}
