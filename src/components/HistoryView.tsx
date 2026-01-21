import React from 'react';
import { Box, Text } from 'ink';
import { CommitInfo } from '../git/status.js';
import { ScrollableList } from './ScrollableList.js';
import { formatDate } from '../utils/formatDate.js';

interface HistoryViewProps {
  commits: CommitInfo[];
  selectedIndex: number;
  scrollOffset: number;
  maxHeight: number;
  isActive: boolean;
  width: number;
  onSelectCommit?: (commit: CommitInfo, index: number) => void;
}

/**
 * Calculate how many visual terminal rows a commit takes.
 * Since rendering truncates messages to fit, this always returns 1.
 */
function getCommitRowCount(_commit: CommitInfo, _terminalWidth: number): number {
  // The rendering truncates messages to fit within terminalWidth,
  // so each commit always takes exactly 1 row
  return 1;
}

/**
 * Map a visual row index to the commit index.
 * Since each commit takes 1 row, this is simply visualRow + scrollOffset.
 */
export function getCommitIndexFromRow(
  visualRow: number,
  commits: CommitInfo[],
  _terminalWidth: number,
  scrollOffset: number = 0
): number {
  const index = visualRow + scrollOffset;
  if (index < 0 || index >= commits.length) {
    return -1;
  }
  return index;
}

/**
 * Get the total number of visual rows for all commits.
 * Since each commit takes 1 row, this equals commits.length.
 */
export function getHistoryTotalRows(commits: CommitInfo[], _terminalWidth: number): number {
  return commits.length;
}

/**
 * Get the visual row offset for a given commit index.
 * Since each commit takes 1 row, this equals commitIndex.
 */
export function getHistoryRowOffset(
  _commits: CommitInfo[],
  commitIndex: number,
  _terminalWidth: number
): number {
  return commitIndex;
}

export function HistoryView({
  commits,
  selectedIndex,
  scrollOffset,
  maxHeight,
  isActive,
  width,
  onSelectCommit,
}: HistoryViewProps): React.ReactElement {
  if (commits.length === 0) {
    return (
      <Box>
        <Text dimColor>No commits yet</Text>
      </Box>
    );
  }

  return (
    <ScrollableList
      items={commits}
      maxHeight={maxHeight}
      scrollOffset={scrollOffset}
      getKey={(commit) => commit.hash}
      renderItem={(commit, actualIndex) => {
        const isSelected = actualIndex === selectedIndex && isActive;

        const dateStr = formatDate(commit.date);
        // Fixed parts: hash(7) + spaces(4) + date + parens(2)
        const baseWidth = 7 + 4 + dateStr.length + 2;

        // Calculate space available for message and refs combined
        const remainingWidth = width - baseWidth;

        // Allocate space: prioritize message (min 20 chars), rest for refs
        const minMessageWidth = 20;
        const maxRefsWidth = Math.max(0, remainingWidth - minMessageWidth - 1);

        // Truncate refs if needed
        let displayRefs = commit.refs || '';
        if (displayRefs.length > maxRefsWidth && maxRefsWidth > 3) {
          displayRefs = displayRefs.slice(0, maxRefsWidth - 3) + '...';
        } else if (displayRefs.length > maxRefsWidth) {
          displayRefs = '';
        }

        // Calculate message width (remaining space after refs)
        const refsWidth = displayRefs ? displayRefs.length + 1 : 0;
        const messageWidth = Math.max(minMessageWidth, remainingWidth - refsWidth);

        // Truncate message if needed
        const needsTruncation = commit.message.length > messageWidth;
        const displayMessage = needsTruncation
          ? commit.message.slice(0, messageWidth - 3) + '...'
          : commit.message;

        return (
          <>
            <Text color="yellow">{commit.shortHash}</Text>
            <Text> </Text>
            <Text
              color={isSelected ? 'cyan' : undefined}
              bold={isSelected}
              inverse={isSelected}
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
          </>
        );
      }}
    />
  );
}
