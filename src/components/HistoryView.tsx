import React from 'react';
import { Box, Text } from 'ink';
import { CommitInfo } from '../git/status.js';

interface HistoryViewProps {
  commits: CommitInfo[];
  selectedIndex: number;
  scrollOffset: number;
  maxHeight: number;
  isActive: boolean;
  width: number;
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
  width
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
