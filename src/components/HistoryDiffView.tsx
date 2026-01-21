import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { CommitInfo } from '../git/status.js';
import { DiffResult, DiffLine } from '../git/diff.js';
import { DiffView } from './DiffView.js';
import { ThemeName } from '../themes.js';

interface HistoryDiffViewProps {
  commit: CommitInfo | null;
  diff: DiffResult | null;
  scrollOffset: number;
  maxHeight: number;
  theme?: ThemeName;
}

interface HistoryDiffRow {
  type: 'commit-header' | 'commit-message' | 'spacer' | 'diff-line';
  content?: string;
  diffLine?: DiffLine;
}

function formatDate(date: Date): string {
  return date.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Filter out redundant headers that DiffView also skips */
function isDisplayableDiffLine(line: DiffLine): boolean {
  if (line.type !== 'header') return true;
  const content = line.content;
  return !(
    content.startsWith('index ') ||
    content.startsWith('--- ') ||
    content.startsWith('+++ ') ||
    content.startsWith('similarity index')
  );
}

/**
 * Build all displayable rows for the history diff view.
 * This includes commit metadata, message, and diff lines.
 * Single source of truth for both rendering and row counting.
 */
export function buildHistoryDiffRows(
  commit: CommitInfo | null,
  diff: DiffResult | null
): HistoryDiffRow[] {
  const rows: HistoryDiffRow[] = [];

  if (commit) {
    // Commit header: hash, author, date
    rows.push({
      type: 'commit-header',
      content: `commit ${commit.hash}`,
    });
    rows.push({
      type: 'commit-header',
      content: `Author: ${commit.author}`,
    });
    rows.push({
      type: 'commit-header',
      content: `Date:   ${formatDate(commit.date)}`,
    });

    // Blank line before message
    rows.push({ type: 'spacer' });

    // Commit message (can be multi-line)
    const messageLines = commit.message.split('\n');
    for (const line of messageLines) {
      rows.push({
        type: 'commit-message',
        content: `    ${line}`,
      });
    }

    // Blank line after message, before diff
    rows.push({ type: 'spacer' });
  }

  // Diff lines (filter same as DiffView)
  if (diff) {
    for (const line of diff.lines) {
      if (isDisplayableDiffLine(line)) {
        rows.push({ type: 'diff-line', diffLine: line });
      }
    }
  }

  return rows;
}

/**
 * Get total displayable rows for scroll calculation.
 */
export function getHistoryDiffTotalRows(
  commit: CommitInfo | null,
  diff: DiffResult | null
): number {
  return buildHistoryDiffRows(commit, diff).length;
}

export function HistoryDiffView({
  commit,
  diff,
  scrollOffset,
  maxHeight,
  theme = 'dark',
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
      />
    );
  }

  // Mixed view: some header rows visible, then diff
  const headerRowsToShow = visibleRows.filter((r) => r.type !== 'diff-line');
  const diffRowsVisible = maxHeight - headerRowsToShow.length;

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
        />
      )}
    </Box>
  );
}
