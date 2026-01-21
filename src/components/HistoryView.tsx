import React from 'react';
import { Box, Text } from 'ink';
import { CommitInfo } from '../git/status.js';
import { ScrollableList } from './ScrollableList.js';
import { formatDate } from '../utils/formatDate.js';
import { formatCommitDisplay } from '../utils/commitFormat.js';

// Re-export from utils for backwards compatibility
export {
  getCommitIndexFromRow,
  getHistoryTotalRows,
  getHistoryRowOffset,
} from '../utils/rowCalculations.js';

interface HistoryViewProps {
  commits: CommitInfo[];
  selectedIndex: number;
  scrollOffset: number;
  maxHeight: number;
  isActive: boolean;
  width: number;
  onSelectCommit?: (commit: CommitInfo, index: number) => void;
}

export function HistoryView({
  commits,
  selectedIndex,
  scrollOffset,
  maxHeight,
  isActive,
  width,
  onSelectCommit: _onSelectCommit,
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
        const remainingWidth = width - baseWidth;

        const { displayMessage, displayRefs } = formatCommitDisplay(
          commit.message,
          commit.refs,
          remainingWidth
        );

        return (
          <>
            <Text color="yellow">{commit.shortHash}</Text>
            <Text> </Text>
            <Text color={isSelected ? 'cyan' : undefined} bold={isSelected} inverse={isSelected}>
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
