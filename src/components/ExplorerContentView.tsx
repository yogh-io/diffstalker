import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { ScrollableList } from './ScrollableList.js';

interface ExplorerContentViewProps {
  filePath: string | null;
  content: string | null;
  maxHeight: number;
  scrollOffset: number;
  truncated?: boolean;
}

interface ContentLine {
  lineNum: number;
  content: string;
}

export function ExplorerContentView({
  filePath,
  content,
  maxHeight,
  scrollOffset,
  truncated = false,
}: ExplorerContentViewProps): React.ReactElement {
  // Parse content into lines
  const lines = useMemo((): ContentLine[] => {
    if (!content) return [];
    return content.split('\n').map((line, i) => ({
      lineNum: i + 1,
      content: line,
    }));
  }, [content]);

  // Calculate line number width
  const lineNumWidth = useMemo(() => {
    const maxLineNum = lines.length;
    return Math.max(3, String(maxLineNum).length);
  }, [lines.length]);

  if (!filePath) {
    return (
      <Box paddingX={1}>
        <Text dimColor>Select a file to view its contents</Text>
      </Box>
    );
  }

  if (!content) {
    return (
      <Box paddingX={1}>
        <Text dimColor>Loading...</Text>
      </Box>
    );
  }

  if (lines.length === 0) {
    return (
      <Box paddingX={1}>
        <Text dimColor>(empty file)</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <ScrollableList
        items={lines}
        maxHeight={maxHeight}
        scrollOffset={scrollOffset}
        getKey={(line) => `${line.lineNum}`}
        renderItem={(line) => {
          const lineNumStr = String(line.lineNum).padStart(lineNumWidth, ' ');
          return (
            <Box>
              <Text dimColor>{lineNumStr} </Text>
              <Text>{line.content || ' '}</Text>
            </Box>
          );
        }}
      />
      {truncated && (
        <Box>
          <Text color="yellow" dimColor>
            (file truncated)
          </Text>
        </Box>
      )}
    </Box>
  );
}

/**
 * Get total lines in file content for scroll calculations.
 */
export function getExplorerContentTotalRows(content: string | null): number {
  if (!content) return 0;
  return content.split('\n').length;
}
