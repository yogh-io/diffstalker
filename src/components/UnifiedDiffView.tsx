import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { ThemeName, getTheme, Theme } from '../themes.js';
import { ScrollableList } from './ScrollableList.js';
import { DisplayRow, WrappedDisplayRow, getDisplayRowsLineNumWidth } from '../utils/displayRows.js';

// Truncate string to fit within maxWidth, adding ellipsis if needed
function truncate(str: string, maxWidth: number): string {
  if (maxWidth <= 0 || str.length <= maxWidth) return str;
  if (maxWidth <= 1) return '\u2026';
  return str.slice(0, maxWidth - 1) + '\u2026';
}

// Format line number with padding
function formatLineNum(lineNum: number | undefined, width: number): string {
  if (lineNum === undefined) return ' '.repeat(width);
  return String(lineNum).padStart(width, ' ');
}

interface DisplayRowRendererProps {
  row: WrappedDisplayRow;
  lineNumWidth: number;
  width: number;
  theme: Theme;
  wrapMode: boolean;
}

const DisplayRowRenderer = React.memo(function DisplayRowRenderer({
  row,
  lineNumWidth,
  width,
  theme,
  wrapMode,
}: DisplayRowRendererProps): React.ReactElement {
  const { colors } = theme;
  // Available width for content: width - paddingX(1) - lineNum - space(1) - symbol(1) - space(1) - paddingX(1)
  const contentWidth = width - lineNumWidth - 5;
  // Width for headers (just subtract paddingX on each side)
  const headerWidth = width - 2;

  switch (row.type) {
    case 'diff-header': {
      // Extract file path from diff --git and show as clean separator
      const content = row.content;
      if (content.startsWith('diff --git')) {
        const match = content.match(/diff --git a\/.+ b\/(.+)$/);
        if (match) {
          const maxPathLen = headerWidth - 6; // "── " + " ──"
          const path = truncate(match[1], maxPathLen);
          return (
            <Text color="cyan" bold>
              ── {path} ──
            </Text>
          );
        }
      }
      return <Text dimColor>{truncate(content, headerWidth)}</Text>;
    }

    case 'diff-hunk': {
      // Parse hunk header: @@ -oldStart,oldCount +newStart,newCount @@ context
      const match = row.content.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
      if (match) {
        const oldStart = parseInt(match[1], 10);
        const oldCount = match[2] ? parseInt(match[2], 10) : 1;
        const newStart = parseInt(match[3], 10);
        const newCount = match[4] ? parseInt(match[4], 10) : 1;
        const context = match[5].trim();

        const oldEnd = oldStart + oldCount - 1;
        const newEnd = newStart + newCount - 1;

        const oldRange = oldCount === 1 ? `${oldStart}` : `${oldStart}-${oldEnd}`;
        const newRange = newCount === 1 ? `${newStart}` : `${newStart}-${newEnd}`;

        const rangeText = `Lines ${oldRange} \u2192 ${newRange}`;
        const contextMaxLen = headerWidth - rangeText.length - 1;
        const truncatedContext =
          context && contextMaxLen > 3 ? ' ' + truncate(context, contextMaxLen) : '';

        return (
          <Box>
            <Text color="cyan" dimColor>
              {rangeText}
            </Text>
            {truncatedContext && <Text color="gray">{truncatedContext}</Text>}
          </Box>
        );
      }
      return (
        <Text color="cyan" dimColor>
          {truncate(row.content, headerWidth)}
        </Text>
      );
    }

    case 'diff-add': {
      const isCont = row.isContinuation;
      // Use » for continuation - it's single-width and renders background correctly
      const symbol = isCont ? '\u00bb' : '+';
      const rawContent = wrapMode ? row.content || '' : truncate(row.content, contentWidth) || '';
      // Always prepend space to content
      const content = ' ' + rawContent || ' ';
      return (
        <Box>
          <Text backgroundColor={colors.addBg} color={colors.addLineNum}>
            {formatLineNum(row.lineNum, lineNumWidth) + ' '}
          </Text>
          <Text
            backgroundColor={colors.addBg}
            color={isCont ? colors.addLineNum : colors.addSymbol}
            bold={!isCont}
          >
            {symbol}
          </Text>
          <Text backgroundColor={colors.addBg} color={colors.text}>
            {content}
          </Text>
        </Box>
      );
    }

    case 'diff-del': {
      const isCont = row.isContinuation;
      // Use » for continuation - it's single-width and renders background correctly
      const symbol = isCont ? '\u00bb' : '-';
      const rawContent = wrapMode ? row.content || '' : truncate(row.content, contentWidth) || '';
      // Always prepend space to content
      const content = ' ' + rawContent || ' ';
      return (
        <Box>
          <Text backgroundColor={colors.delBg} color={colors.delLineNum}>
            {formatLineNum(row.lineNum, lineNumWidth) + ' '}
          </Text>
          <Text
            backgroundColor={colors.delBg}
            color={isCont ? colors.delLineNum : colors.delSymbol}
            bold={!isCont}
          >
            {symbol}
          </Text>
          <Text backgroundColor={colors.delBg} color={colors.text}>
            {content}
          </Text>
        </Box>
      );
    }

    case 'diff-context': {
      const isCont = row.isContinuation;
      // Use » for continuation - it's single-width and renders correctly
      const symbol = isCont ? '\u00bb ' : '  ';
      const content = wrapMode ? row.content : truncate(row.content, contentWidth);
      return (
        <Box>
          <Text color={colors.contextLineNum}>{formatLineNum(row.lineNum, lineNumWidth)} </Text>
          <Text dimColor>{symbol}</Text>
          <Text>{content}</Text>
        </Box>
      );
    }

    case 'commit-header':
      return <Text color="yellow">{truncate(row.content, headerWidth)}</Text>;

    case 'commit-message':
      return <Text>{truncate(row.content, headerWidth)}</Text>;

    case 'spacer':
      return <Text> </Text>;
  }
});

interface UnifiedDiffViewProps {
  rows: WrappedDisplayRow[];
  maxHeight: number;
  scrollOffset: number;
  theme: ThemeName;
  width: number;
  wrapMode?: boolean;
}

/**
 * The ONE diff renderer used by all tabs.
 * Every row = exactly 1 terminal row.
 * No variable heights, no complexity.
 */
export function UnifiedDiffView({
  rows,
  maxHeight,
  scrollOffset,
  theme: themeName,
  width,
  wrapMode = false,
}: UnifiedDiffViewProps): React.ReactElement {
  const theme = useMemo(() => getTheme(themeName), [themeName]);
  const lineNumWidth = useMemo(() => getDisplayRowsLineNumWidth(rows), [rows]);

  if (rows.length === 0) {
    return (
      <Box paddingX={1}>
        <Text dimColor>No diff to display</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1} width={width}>
      <ScrollableList
        items={rows}
        maxHeight={maxHeight}
        scrollOffset={scrollOffset}
        getKey={(_, i) => `row-${i}`}
        // NO getItemHeight - all rows are 1 line
        renderItem={(row) => (
          <DisplayRowRenderer
            row={row}
            lineNumWidth={lineNumWidth}
            width={width}
            theme={theme}
            wrapMode={wrapMode}
          />
        )}
      />
    </Box>
  );
}

/**
 * Get total row count for scroll calculation.
 * Since every row = 1 terminal row, this is just rows.length.
 */
export function getUnifiedDiffTotalRows(rows: DisplayRow[]): number {
  return rows.length;
}
