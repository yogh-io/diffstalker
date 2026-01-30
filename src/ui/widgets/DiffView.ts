import type { DiffResult } from '../../git/diff.js';
import type { CommitInfo } from '../../git/status.js';
import { ThemeName, getTheme, Theme } from '../../themes.js';
import {
  WrappedDisplayRow,
  buildDiffDisplayRows,
  buildHistoryDisplayRows,
  getDisplayRowsLineNumWidth,
  wrapDisplayRows,
} from '../../utils/displayRows.js';
import { truncateAnsi } from '../../utils/ansiTruncate.js';

// ANSI escape codes for raw terminal output (avoids blessed tag escaping issues)
const ANSI_RESET = '\x1b[0m';
const ANSI_BOLD = '\x1b[1m';
const ANSI_GRAY = '\x1b[90m';
const ANSI_CYAN = '\x1b[36m';
const ANSI_YELLOW = '\x1b[33m';

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
 * Build raw ANSI escape sequence for 24-bit RGB background.
 */
function ansiBg(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `\x1b[48;2;${r};${g};${b}m`;
}

/**
 * Build raw ANSI escape sequence for 24-bit RGB foreground.
 */
function ansiFg(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `\x1b[38;2;${r};${g};${b}m`;
}

/**
 * Format a diff file header row (e.g. "── path/to/file ──").
 */
function formatDiffHeader(content: string, headerWidth: number): string {
  if (content.startsWith('diff --git')) {
    const match = content.match(/diff --git a\/.+ b\/(.+)$/);
    if (match) {
      const maxPathLen = headerWidth - 6;
      const path = truncate(match[1], maxPathLen);
      return `{escape}${ANSI_BOLD}${ANSI_CYAN}\u2500\u2500 ${path} \u2500\u2500${ANSI_RESET}{/escape}`;
    }
  }
  return `{escape}${ANSI_GRAY}${truncate(content, headerWidth)}${ANSI_RESET}{/escape}`;
}

/**
 * Format a diff hunk header row (e.g. "Lines 10-20 → 15-25 functionName").
 */
function formatDiffHunk(content: string, headerWidth: number): string {
  const match = content.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
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

    return `{escape}${ANSI_CYAN}${rangeText}${ANSI_GRAY}${truncatedContext}${ANSI_RESET}{/escape}`;
  }
  return `{escape}${ANSI_CYAN}${truncate(content, headerWidth)}${ANSI_RESET}{/escape}`;
}

type DiffContentRow = Extract<WrappedDisplayRow, { type: 'diff-add' | 'diff-del' }>;

/**
 * Format an add or delete content line, parameterized by line type.
 */
function formatDiffContentLine(
  row: DiffContentRow,
  lineNumWidth: number,
  contentWidth: number,
  headerWidth: number,
  theme: Theme,
  wrapMode: boolean,
  lineType: 'add' | 'del'
): string {
  const { colors } = theme;
  const isCont = row.isContinuation;
  const typeSymbol = lineType === 'add' ? '+' : '-';
  const symbol = isCont ? '\u00bb' : typeSymbol;
  const lineNum = formatLineNum(row.lineNum, lineNumWidth);
  const prefix = `${lineNum} ${symbol}  `;

  if (theme.name.includes('ansi')) {
    const rawContent = wrapMode ? row.content || '' : truncate(row.content || '', contentWidth);
    const visibleContent = `${prefix}${rawContent}`;
    const paddedContent = visibleContent.padEnd(headerWidth, ' ');
    const bgTag = lineType === 'add' ? 'green' : 'red';
    return `{${bgTag}-bg}{white-fg}${escapeContent(paddedContent)}{/white-fg}{/${bgTag}-bg}`;
  }

  const bg = ansiBg(lineType === 'add' ? colors.addBg : colors.delBg);
  const highlightBg = ansiBg(lineType === 'add' ? colors.addHighlight : colors.delHighlight);
  const fg = ansiFg('#ffffff');

  if (row.wordDiffSegments && !isCont) {
    const rawContent = row.content || '';
    if (!wrapMode && rawContent.length > contentWidth) {
      const truncated = truncate(rawContent, contentWidth);
      const visibleContent = `${prefix}${truncated}`;
      const paddedContent = visibleContent.padEnd(headerWidth, ' ');
      return `{escape}${bg}${fg}${paddedContent}${ANSI_RESET}{/escape}`;
    }

    let contentStr = '';
    for (const seg of row.wordDiffSegments) {
      if (seg.type === 'changed') {
        contentStr += `${highlightBg}${seg.text}${bg}`;
      } else {
        contentStr += seg.text;
      }
    }
    const visibleWidth = prefix.length + rawContent.length;
    const padding = ' '.repeat(Math.max(0, headerWidth - visibleWidth));
    return `{escape}${bg}${fg}${prefix}${contentStr}${padding}${ANSI_RESET}{/escape}`;
  }

  if (row.highlighted && !isCont) {
    const rawContent = row.content || '';
    if (!wrapMode && rawContent.length > contentWidth) {
      const truncated = truncate(rawContent, contentWidth);
      const visibleContent = `${prefix}${truncated}`;
      const paddedContent = visibleContent.padEnd(headerWidth, ' ');
      return `{escape}${bg}${fg}${paddedContent}${ANSI_RESET}{/escape}`;
    }
    const visibleWidth = prefix.length + rawContent.length;
    const padding = ' '.repeat(Math.max(0, headerWidth - visibleWidth));
    return `{escape}${bg}${fg}${prefix}${row.highlighted}${padding}${ANSI_RESET}{/escape}`;
  }

  const rawContent = wrapMode ? row.content || '' : truncate(row.content || '', contentWidth);
  const visibleContent = `${prefix}${rawContent}`;
  const paddedContent = visibleContent.padEnd(headerWidth, ' ');
  return `{escape}${bg}${fg}${paddedContent}${ANSI_RESET}{/escape}`;
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
  switch (row.type) {
    case 'diff-header':
      return formatDiffHeader(row.content, headerWidth);

    case 'diff-hunk':
      return formatDiffHunk(row.content, headerWidth);

    case 'diff-add':
      return formatDiffContentLine(
        row,
        lineNumWidth,
        contentWidth,
        headerWidth,
        theme,
        wrapMode,
        'add'
      );

    case 'diff-del':
      return formatDiffContentLine(
        row,
        lineNumWidth,
        contentWidth,
        headerWidth,
        theme,
        wrapMode,
        'del'
      );

    case 'diff-context': {
      const isCont = row.isContinuation;
      const symbol = isCont ? '\u00bb' : ' ';
      const lineNum = formatLineNum(row.lineNum, lineNumWidth);
      const prefix = `${lineNum} ${symbol}  `;
      const rawContent = row.content || '';
      const prefixAnsi = `\x1b[90m${prefix}\x1b[0m`;

      if (row.highlighted && !isCont) {
        const content = wrapMode ? row.highlighted : truncateAnsi(row.highlighted, contentWidth);
        return `{escape}${prefixAnsi}${content}${ANSI_RESET}{/escape}`;
      }

      const content = wrapMode ? rawContent : truncate(rawContent, contentWidth);
      return `{escape}${prefixAnsi}${content}${ANSI_RESET}{/escape}`;
    }

    case 'commit-header':
      return `{escape}${ANSI_YELLOW}${truncate(row.content, headerWidth)}${ANSI_RESET}{/escape}`;

    case 'commit-message':
      return `{escape}${truncate(row.content, headerWidth)}${ANSI_RESET}{/escape}`;

    case 'spacer':
      return '';
  }
}

export interface DiffRenderResult {
  content: string;
  totalRows: number;
}

/**
 * Format diff output as blessed-compatible tagged string.
 * Returns both the content and total row count for scroll calculations.
 */
export function formatDiff(
  diff: DiffResult | null,
  width: number,
  scrollOffset: number = 0,
  maxHeight?: number,
  themeName: ThemeName = 'dark',
  wrapMode: boolean = false
): DiffRenderResult {
  const displayRows = buildDiffDisplayRows(diff);

  if (displayRows.length === 0) {
    return { content: '{gray-fg}No diff to display{/gray-fg}', totalRows: 0 };
  }

  const theme = getTheme(themeName);
  const lineNumWidth = getDisplayRowsLineNumWidth(displayRows);
  const contentWidth = width - lineNumWidth - 5; // line num + space + symbol + space + padding
  const headerWidth = width - 2;

  // Apply wrapping if enabled
  const wrappedRows = wrapDisplayRows(displayRows, contentWidth, wrapMode);
  const totalRows = wrappedRows.length;

  // Apply scroll offset and max height
  const visibleRows = maxHeight
    ? wrappedRows.slice(scrollOffset, scrollOffset + maxHeight)
    : wrappedRows.slice(scrollOffset);

  const lines = visibleRows.map((row) =>
    formatDisplayRow(row, lineNumWidth, contentWidth, headerWidth, theme, wrapMode)
  );

  return { content: lines.join('\n'), totalRows };
}

/**
 * Format history diff (commit metadata + diff) as blessed-compatible tagged string.
 * Returns both the content and total row count for scroll calculations.
 */
export function formatHistoryDiff(
  commit: CommitInfo | null,
  diff: DiffResult | null,
  width: number,
  scrollOffset: number = 0,
  maxHeight?: number,
  themeName: ThemeName = 'dark',
  wrapMode: boolean = false
): DiffRenderResult {
  const displayRows = buildHistoryDisplayRows(commit, diff);

  if (displayRows.length === 0) {
    return { content: '{gray-fg}No commit selected{/gray-fg}', totalRows: 0 };
  }

  const theme = getTheme(themeName);
  const lineNumWidth = getDisplayRowsLineNumWidth(displayRows);
  const contentWidth = width - lineNumWidth - 5;
  const headerWidth = width - 2;

  const wrappedRows = wrapDisplayRows(displayRows, contentWidth, wrapMode);
  const totalRows = wrappedRows.length;

  const visibleRows = maxHeight
    ? wrappedRows.slice(scrollOffset, scrollOffset + maxHeight)
    : wrappedRows.slice(scrollOffset);

  const lines = visibleRows.map((row) =>
    formatDisplayRow(row, lineNumWidth, contentWidth, headerWidth, theme, wrapMode)
  );

  return { content: lines.join('\n'), totalRows };
}
