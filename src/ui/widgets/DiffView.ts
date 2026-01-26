import type { DiffResult } from '../../git/diff.js';
import type { CommitInfo } from '../../git/status.js';
import { ThemeName, getTheme, Theme } from '../../themes.js';
import {
  DisplayRow,
  WrappedDisplayRow,
  buildDiffDisplayRows,
  buildHistoryDisplayRows,
  getDisplayRowsLineNumWidth,
  wrapDisplayRows,
} from '../../utils/displayRows.js';

/**
 * Truncate string to fit within maxWidth, adding ellipsis if needed.
 */
function truncate(str: string, maxWidth: number): string {
  if (maxWidth <= 0 || str.length <= maxWidth) return str;
  if (maxWidth <= 1) return '\u2026';
  return str.slice(0, maxWidth - 1) + '\u2026';
}

/**
 * Format line number with padding.
 */
function formatLineNum(lineNum: number | undefined, width: number): string {
  if (lineNum === undefined) return ' '.repeat(width);
  return String(lineNum).padStart(width, ' ');
}

/**
 * Escape blessed tags in content.
 */
function escapeContent(content: string): string {
  return content.replace(/\{/g, '{{').replace(/\}/g, '}}');
}

/**
 * Convert a hex color like #022800 to a blessed-compatible format.
 * blessed supports 256-color and truecolor via bgHex/fgHex style properties,
 * but for tags we need to use the closest named color or use escape codes directly.
 */
function hexToAnsi(hex: string): string {
  // For now, just use the hex value directly - blessed supports hex in style objects
  return hex;
}

/**
 * Format a single display row as blessed-compatible tagged string.
 */
function formatDisplayRow(
  row: WrappedDisplayRow,
  lineNumWidth: number,
  contentWidth: number,
  headerWidth: number,
  theme: Theme,
  wrapMode: boolean
): string {
  const { colors } = theme;

  switch (row.type) {
    case 'diff-header': {
      const content = row.content;
      if (content.startsWith('diff --git')) {
        const match = content.match(/diff --git a\/.+ b\/(.+)$/);
        if (match) {
          const maxPathLen = headerWidth - 6;
          const path = truncate(match[1], maxPathLen);
          return `{bold}{cyan-fg}\u2500\u2500 ${path} \u2500\u2500{/cyan-fg}{/bold}`;
        }
      }
      return `{gray-fg}${escapeContent(truncate(content, headerWidth))}{/gray-fg}`;
    }

    case 'diff-hunk': {
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

        return `{cyan-fg}${rangeText}{/cyan-fg}{gray-fg}${truncatedContext}{/gray-fg}`;
      }
      return `{cyan-fg}${escapeContent(truncate(row.content, headerWidth))}{/cyan-fg}`;
    }

    case 'diff-add': {
      const isCont = row.isContinuation;
      const symbol = isCont ? '\u00bb' : '+';
      const rawContent = wrapMode ? row.content || '' : truncate(row.content || '', contentWidth);
      const content = ' ' + escapeContent(rawContent);
      const lineNum = formatLineNum(row.lineNum, lineNumWidth);

      // Use simple ANSI colors for the background - blessed tags don't support hex well
      // We'll use green-bg/red-bg for ANSI themes, or escape codes for hex themes
      if (theme.name.includes('ansi')) {
        return `{green-bg}{black-fg}${lineNum} {/black-fg}{bold}${symbol}{/bold} ${content}{/green-bg}`;
      }
      // For hex themes, just use foreground colors (backgrounds need direct escape codes)
      return `{green-fg}${lineNum} {bold}${symbol}{/bold}${content}{/green-fg}`;
    }

    case 'diff-del': {
      const isCont = row.isContinuation;
      const symbol = isCont ? '\u00bb' : '-';
      const rawContent = wrapMode ? row.content || '' : truncate(row.content || '', contentWidth);
      const content = ' ' + escapeContent(rawContent);
      const lineNum = formatLineNum(row.lineNum, lineNumWidth);

      if (theme.name.includes('ansi')) {
        return `{red-bg}{black-fg}${lineNum} {/black-fg}{bold}${symbol}{/bold} ${content}{/red-bg}`;
      }
      return `{red-fg}${lineNum} {bold}${symbol}{/bold}${content}{/red-fg}`;
    }

    case 'diff-context': {
      const isCont = row.isContinuation;
      const symbol = isCont ? '\u00bb ' : '  ';
      const content = wrapMode
        ? escapeContent(row.content || '')
        : escapeContent(truncate(row.content || '', contentWidth));
      const lineNum = formatLineNum(row.lineNum, lineNumWidth);

      return `{gray-fg}${lineNum} ${symbol}{/gray-fg}${content}`;
    }

    case 'commit-header':
      return `{yellow-fg}${escapeContent(truncate(row.content, headerWidth))}{/yellow-fg}`;

    case 'commit-message':
      return escapeContent(truncate(row.content, headerWidth));

    case 'spacer':
      return '';
  }
}

/**
 * Format diff output as blessed-compatible tagged string.
 */
export function formatDiff(
  diff: DiffResult | null,
  width: number,
  scrollOffset: number = 0,
  maxHeight?: number,
  themeName: ThemeName = 'dark',
  wrapMode: boolean = false
): string {
  const displayRows = buildDiffDisplayRows(diff);

  if (displayRows.length === 0) {
    return '{gray-fg}No diff to display{/gray-fg}';
  }

  const theme = getTheme(themeName);
  const lineNumWidth = getDisplayRowsLineNumWidth(displayRows);
  const contentWidth = width - lineNumWidth - 5; // line num + space + symbol + space + padding
  const headerWidth = width - 2;

  // Apply wrapping if enabled
  const wrappedRows = wrapDisplayRows(displayRows, contentWidth, wrapMode);

  // Apply scroll offset and max height
  const visibleRows = maxHeight
    ? wrappedRows.slice(scrollOffset, scrollOffset + maxHeight)
    : wrappedRows.slice(scrollOffset);

  const lines = visibleRows.map((row) =>
    formatDisplayRow(row, lineNumWidth, contentWidth, headerWidth, theme, wrapMode)
  );

  return lines.join('\n');
}

/**
 * Format history diff (commit metadata + diff) as blessed-compatible tagged string.
 */
export function formatHistoryDiff(
  commit: CommitInfo | null,
  diff: DiffResult | null,
  width: number,
  scrollOffset: number = 0,
  maxHeight?: number,
  themeName: ThemeName = 'dark',
  wrapMode: boolean = false
): string {
  const displayRows = buildHistoryDisplayRows(commit, diff);

  if (displayRows.length === 0) {
    return '{gray-fg}No commit selected{/gray-fg}';
  }

  const theme = getTheme(themeName);
  const lineNumWidth = getDisplayRowsLineNumWidth(displayRows);
  const contentWidth = width - lineNumWidth - 5;
  const headerWidth = width - 2;

  const wrappedRows = wrapDisplayRows(displayRows, contentWidth, wrapMode);

  const visibleRows = maxHeight
    ? wrappedRows.slice(scrollOffset, scrollOffset + maxHeight)
    : wrappedRows.slice(scrollOffset);

  const lines = visibleRows.map((row) =>
    formatDisplayRow(row, lineNumWidth, contentWidth, headerWidth, theme, wrapMode)
  );

  return lines.join('\n');
}

/**
 * Get total row count for scroll calculation.
 */
export function getDiffTotalRows(
  diff: DiffResult | null,
  width: number,
  wrapMode: boolean = false
): number {
  const displayRows = buildDiffDisplayRows(diff);
  if (!wrapMode) return displayRows.length;

  const lineNumWidth = getDisplayRowsLineNumWidth(displayRows);
  const contentWidth = width - lineNumWidth - 5;
  return wrapDisplayRows(displayRows, contentWidth, wrapMode).length;
}
