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
          return `{escape}${ANSI_BOLD}${ANSI_CYAN}\u2500\u2500 ${path} \u2500\u2500${ANSI_RESET}{/escape}`;
        }
      }
      return `{escape}${ANSI_GRAY}${truncate(content, headerWidth)}${ANSI_RESET}{/escape}`;
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

        return `{escape}${ANSI_CYAN}${rangeText}${ANSI_GRAY}${truncatedContext}${ANSI_RESET}{/escape}`;
      }
      return `{escape}${ANSI_CYAN}${truncate(row.content, headerWidth)}${ANSI_RESET}{/escape}`;
    }

    case 'diff-add': {
      const isCont = row.isContinuation;
      const symbol = isCont ? '\u00bb' : '+';
      const lineNum = formatLineNum(row.lineNum, lineNumWidth);
      const prefix = `${lineNum} ${symbol}  `;

      if (theme.name.includes('ansi')) {
        // Basic ANSI theme - use blessed tags with 16-color palette
        const rawContent = wrapMode ? row.content || '' : truncate(row.content || '', contentWidth);
        const visibleContent = `${prefix}${rawContent}`;
        const paddedContent = visibleContent.padEnd(headerWidth, ' ');
        return `{green-bg}{white-fg}${escapeContent(paddedContent)}{/white-fg}{/green-bg}`;
      }

      // Use 24-bit RGB via {escape} tag
      const bg = ansiBg(colors.addBg);
      const highlightBg = ansiBg(colors.addHighlight);
      const fg = ansiFg('#ffffff');

      // Check for word-level diff segments (only in non-wrap mode or first row)
      if (row.wordDiffSegments && !isCont) {
        const rawContent = row.content || '';
        // Check visible content length (not including escape codes)
        if (!wrapMode && rawContent.length > contentWidth) {
          // Content too long - fall back to simple truncation without word highlighting
          const truncated = truncate(rawContent, contentWidth);
          const visibleContent = `${prefix}${truncated}`;
          const paddedContent = visibleContent.padEnd(headerWidth, ' ');
          return `{escape}${bg}${fg}${paddedContent}${ANSI_RESET}{/escape}`;
        }

        // Build content with word-level highlighting
        let contentStr = '';
        for (const seg of row.wordDiffSegments) {
          if (seg.type === 'changed') {
            contentStr += `${highlightBg}${seg.text}${bg}`;
          } else {
            contentStr += seg.text;
          }
        }
        // Calculate padding based on visible width (prefix + rawContent)
        const visibleWidth = prefix.length + rawContent.length;
        const padding = ' '.repeat(Math.max(0, headerWidth - visibleWidth));
        return `{escape}${bg}${fg}${prefix}${contentStr}${padding}${ANSI_RESET}{/escape}`;
      }

      // Check for syntax highlighting (when no word-diff)
      if (row.highlighted && !isCont) {
        const rawContent = row.content || '';
        if (!wrapMode && rawContent.length > contentWidth) {
          // Too long - fall back to plain truncation
          const truncated = truncate(rawContent, contentWidth);
          const visibleContent = `${prefix}${truncated}`;
          const paddedContent = visibleContent.padEnd(headerWidth, ' ');
          return `{escape}${bg}${fg}${paddedContent}${ANSI_RESET}{/escape}`;
        }
        // Use highlighted content (already has foreground colors, bg preserved)
        const visibleWidth = prefix.length + rawContent.length;
        const padding = ' '.repeat(Math.max(0, headerWidth - visibleWidth));
        return `{escape}${bg}${fg}${prefix}${row.highlighted}${padding}${ANSI_RESET}{/escape}`;
      }

      const rawContent = wrapMode ? row.content || '' : truncate(row.content || '', contentWidth);
      const visibleContent = `${prefix}${rawContent}`;
      const paddedContent = visibleContent.padEnd(headerWidth, ' ');
      return `{escape}${bg}${fg}${paddedContent}${ANSI_RESET}{/escape}`;
    }

    case 'diff-del': {
      const isCont = row.isContinuation;
      const symbol = isCont ? '\u00bb' : '-';
      const lineNum = formatLineNum(row.lineNum, lineNumWidth);
      const prefix = `${lineNum} ${symbol}  `;

      if (theme.name.includes('ansi')) {
        // Basic ANSI theme - use blessed tags with 16-color palette
        const rawContent = wrapMode ? row.content || '' : truncate(row.content || '', contentWidth);
        const visibleContent = `${prefix}${rawContent}`;
        const paddedContent = visibleContent.padEnd(headerWidth, ' ');
        return `{red-bg}{white-fg}${escapeContent(paddedContent)}{/white-fg}{/red-bg}`;
      }

      // Use 24-bit RGB via {escape} tag
      const bg = ansiBg(colors.delBg);
      const highlightBg = ansiBg(colors.delHighlight);
      const fg = ansiFg('#ffffff');

      // Check for word-level diff segments (only in non-wrap mode or first row)
      if (row.wordDiffSegments && !isCont) {
        const rawContent = row.content || '';
        // Check visible content length (not including escape codes)
        if (!wrapMode && rawContent.length > contentWidth) {
          // Content too long - fall back to simple truncation without word highlighting
          const truncated = truncate(rawContent, contentWidth);
          const visibleContent = `${prefix}${truncated}`;
          const paddedContent = visibleContent.padEnd(headerWidth, ' ');
          return `{escape}${bg}${fg}${paddedContent}${ANSI_RESET}{/escape}`;
        }

        // Build content with word-level highlighting
        let contentStr = '';
        for (const seg of row.wordDiffSegments) {
          if (seg.type === 'changed') {
            contentStr += `${highlightBg}${seg.text}${bg}`;
          } else {
            contentStr += seg.text;
          }
        }
        // Calculate padding based on visible width (prefix + rawContent)
        const visibleWidth = prefix.length + rawContent.length;
        const padding = ' '.repeat(Math.max(0, headerWidth - visibleWidth));
        return `{escape}${bg}${fg}${prefix}${contentStr}${padding}${ANSI_RESET}{/escape}`;
      }

      // Check for syntax highlighting (when no word-diff)
      if (row.highlighted && !isCont) {
        const rawContent = row.content || '';
        if (!wrapMode && rawContent.length > contentWidth) {
          // Too long - fall back to plain truncation
          const truncated = truncate(rawContent, contentWidth);
          const visibleContent = `${prefix}${truncated}`;
          const paddedContent = visibleContent.padEnd(headerWidth, ' ');
          return `{escape}${bg}${fg}${paddedContent}${ANSI_RESET}{/escape}`;
        }
        // Use highlighted content (already has foreground colors, bg preserved)
        const visibleWidth = prefix.length + rawContent.length;
        const padding = ' '.repeat(Math.max(0, headerWidth - visibleWidth));
        return `{escape}${bg}${fg}${prefix}${row.highlighted}${padding}${ANSI_RESET}{/escape}`;
      }

      const rawContent = wrapMode ? row.content || '' : truncate(row.content || '', contentWidth);
      const visibleContent = `${prefix}${rawContent}`;
      const paddedContent = visibleContent.padEnd(headerWidth, ' ');
      return `{escape}${bg}${fg}${paddedContent}${ANSI_RESET}{/escape}`;
    }

    case 'diff-context': {
      const isCont = row.isContinuation;
      const symbol = isCont ? '\u00bb' : ' ';
      const lineNum = formatLineNum(row.lineNum, lineNumWidth);
      const prefix = `${lineNum} ${symbol}  `;
      const rawContent = row.content || '';

      // Use {escape} for raw ANSI output (consistent with add/del lines)
      // This avoids blessed's tag escaping issues with braces
      const prefixAnsi = `\x1b[90m${prefix}\x1b[0m`; // gray prefix

      // Use syntax highlighting if available (not for continuations)
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
