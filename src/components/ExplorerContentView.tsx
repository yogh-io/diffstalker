import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { ScrollableList } from './ScrollableList.js';
import {
  WrappedExplorerContentRow,
  buildExplorerContentRows,
  wrapExplorerContentRows,
  getExplorerContentRowCount,
  getExplorerContentLineNumWidth,
  applyMiddleDots,
} from '../utils/explorerDisplayRows.js';
import { truncateAnsi } from '../utils/ansiTruncate.js';

interface ExplorerContentViewProps {
  filePath: string | null;
  content: string | null;
  maxHeight: number;
  scrollOffset: number;
  truncated?: boolean;
  wrapMode?: boolean;
  width: number;
  showMiddleDots?: boolean;
}

export function ExplorerContentView({
  filePath,
  content,
  maxHeight,
  scrollOffset,
  truncated = false,
  wrapMode = false,
  width,
  showMiddleDots = false,
}: ExplorerContentViewProps): React.ReactElement {
  // Build base rows with syntax highlighting
  const baseRows = useMemo(
    () => buildExplorerContentRows(content, filePath, truncated),
    [content, filePath, truncated]
  );

  // Calculate line number width
  const lineNumWidth = useMemo(() => getExplorerContentLineNumWidth(baseRows), [baseRows]);

  // Calculate content width for wrapping
  // Layout: paddingX(1) + lineNum + space(1) + content + paddingX(1)
  const contentWidth = width - lineNumWidth - 3;

  // Apply wrapping if enabled
  const displayRows = useMemo(
    () => wrapExplorerContentRows(baseRows, contentWidth, wrapMode),
    [baseRows, contentWidth, wrapMode]
  );

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

  if (displayRows.length === 0) {
    return (
      <Box paddingX={1}>
        <Text dimColor>(empty file)</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <ScrollableList
        items={displayRows}
        maxHeight={maxHeight}
        scrollOffset={scrollOffset}
        getKey={(row, index) => `${index}`}
        renderItem={(row: WrappedExplorerContentRow) => {
          if (row.type === 'truncation') {
            return (
              <Box>
                <Text color="yellow" dimColor>
                  {row.content}
                </Text>
              </Box>
            );
          }

          // Code row
          const isContinuation = row.isContinuation ?? false;

          // Line number display
          let lineNumDisplay: string;
          if (isContinuation) {
            // Show continuation marker instead of line number
            lineNumDisplay = '>>'.padStart(lineNumWidth, ' ');
          } else {
            lineNumDisplay = String(row.lineNum).padStart(lineNumWidth, ' ');
          }

          // Determine what content to display
          const rawContent = row.content;
          const shouldTruncate = !wrapMode && rawContent.length > contentWidth;

          // Use highlighted content if available and not a continuation or middle-dots mode
          const canUseHighlighting = row.highlighted && !isContinuation && !showMiddleDots;

          let displayContent: string;
          if (canUseHighlighting && row.highlighted) {
            // Use ANSI-aware truncation to preserve syntax highlighting
            displayContent = shouldTruncate
              ? truncateAnsi(row.highlighted, contentWidth)
              : row.highlighted;
          } else {
            // Plain content path
            let content = rawContent;

            // Apply middle-dots to raw content
            if (showMiddleDots && !isContinuation) {
              content = applyMiddleDots(content, true);
            }

            // Simple truncation for plain content
            if (shouldTruncate) {
              content = content.slice(0, Math.max(0, contentWidth - 1)) + '…';
            }

            displayContent = content;
          }

          return (
            <Box>
              <Text dimColor={!isContinuation} color={isContinuation ? 'cyan' : undefined}>
                {lineNumDisplay}{' '}
              </Text>
              <Text dimColor={showMiddleDots && !canUseHighlighting}>{displayContent || ' '}</Text>
            </Box>
          );
        }}
      />
    </Box>
  );
}

/**
 * Get total rows for scroll calculations.
 * Accounts for wrap mode when calculating.
 */
export function getExplorerContentTotalRows(
  content: string | null,
  filePath: string | null,
  truncated: boolean,
  width: number,
  wrapMode: boolean
): number {
  if (!content) return 0;

  const rows = buildExplorerContentRows(content, filePath, truncated);
  const lineNumWidth = getExplorerContentLineNumWidth(rows);
  const contentWidth = width - lineNumWidth - 3;

  return getExplorerContentRowCount(rows, contentWidth, wrapMode);
}
