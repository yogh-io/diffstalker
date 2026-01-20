import React from 'react';
import { Box, Text } from 'ink';
import stringWidth from 'string-width';
import { CommitInfo } from '../git/status.js';

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
 * Calculate the visual width of a commit line (accounting for wide characters).
 */
function getCommitLineWidth(commit: CommitInfo): number {
  const dateStr = formatDate(commit.date);
  // Build the full line as it would be rendered
  let line = commit.shortHash + ' ' + commit.message + ' ' + '(' + dateStr + ')';
  if (commit.refs) {
    line += ' ' + commit.refs;
  }
  return stringWidth(line);
}

/**
 * Calculate how many visual terminal rows a commit takes (1 if no wrap, more if wrapped).
 */
function getCommitRowCount(commit: CommitInfo, terminalWidth: number): number {
  const lineWidth = getCommitLineWidth(commit);
  return Math.ceil(lineWidth / terminalWidth);
}

/**
 * Map a visual row index (from scrollOffset) to the commit index.
 * Returns the commit index, or -1 if out of bounds.
 */
export function getCommitIndexFromRow(
  visualRow: number,
  commits: CommitInfo[],
  terminalWidth: number,
  scrollOffset: number = 0
): number {
  // The visualRow is relative to scrollOffset, so we need to find which commit
  // contains this visual row
  let currentRow = 0;

  for (let i = 0; i < commits.length; i++) {
    const rowCount = getCommitRowCount(commits[i], terminalWidth);

    // Check if visualRow + scrollOffset falls within this commit's rows
    if (visualRow + scrollOffset < currentRow + rowCount) {
      return i;
    }
    currentRow += rowCount;
  }

  return -1; // Out of bounds
}

/**
 * Get the total number of visual rows for all commits (accounting for wrapping).
 */
export function getHistoryTotalRows(commits: CommitInfo[], terminalWidth: number): number {
  let total = 0;
  for (const commit of commits) {
    total += getCommitRowCount(commit, terminalWidth);
  }
  return total;
}

/**
 * Get the visual row offset for a given commit index (for scrolling to a commit).
 */
export function getHistoryRowOffset(
  commits: CommitInfo[],
  commitIndex: number,
  terminalWidth: number
): number {
  let offset = 0;
  for (let i = 0; i < commitIndex && i < commits.length; i++) {
    offset += getCommitRowCount(commits[i], terminalWidth);
  }
  return offset;
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

  const visibleCommits = commits.slice(scrollOffset, scrollOffset + maxHeight);

  return (
    <Box flexDirection="column">
      {visibleCommits.map((commit, idx) => {
        const actualIndex = scrollOffset + idx;
        const isSelected = actualIndex === selectedIndex && isActive;

        const dateStr = formatDate(commit.date);
        // Calculate available space: width - hash(7) - spaces(4) - date - parens(2) - refs - buffer
        const fixedWidth = 7 + 4 + dateStr.length + 2 + (commit.refs ? commit.refs.length + 1 : 0);
        const availableWidth = Math.max(20, width - fixedWidth);

        const needsTruncation = commit.message.length > availableWidth;
        const displayMessage = needsTruncation
          ? commit.message.slice(0, availableWidth - 3) + '...'
          : commit.message;

        return (
          <Box key={commit.hash}>
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
            {commit.refs && (
              <>
                <Text> </Text>
                <Text color="green">{commit.refs}</Text>
              </>
            )}
          </Box>
        );
      })}
    </Box>
  );
}
