import {
  ExplorerContentRow,
  buildExplorerContentRows,
  wrapExplorerContentRows,
  getExplorerContentRowCount,
  getExplorerContentLineNumWidth,
  applyMiddleDots,
} from '../../utils/explorerDisplayRows.js';
import { truncateAnsi } from '../../utils/ansiTruncate.js';
import { ansiToBlessed } from '../../utils/ansiToBlessed.js';

/**
 * Escape blessed tags in content.
 */
function escapeContent(content: string): string {
  return content.replace(/\{/g, '{{').replace(/\}/g, '}}');
}

/**
 * Format explorer file content as blessed-compatible tagged string.
 */
export function formatExplorerContent(
  filePath: string | null,
  content: string | null,
  width: number,
  scrollOffset: number = 0,
  maxHeight?: number,
  truncated: boolean = false,
  wrapMode: boolean = false,
  showMiddleDots: boolean = false
): string {
  if (!filePath) {
    return '{gray-fg}Select a file to view its contents{/gray-fg}';
  }

  if (!content) {
    return '{gray-fg}Loading...{/gray-fg}';
  }

  // Build base rows with syntax highlighting
  const baseRows = buildExplorerContentRows(content, filePath, truncated);

  if (baseRows.length === 0) {
    return '{gray-fg}(empty file){/gray-fg}';
  }

  // Calculate line number width
  const lineNumWidth = getExplorerContentLineNumWidth(baseRows);

  // Calculate content width for wrapping
  // Layout: lineNum + space(1) + content
  const contentWidth = width - lineNumWidth - 2;

  // Apply wrapping if enabled
  const displayRows = wrapExplorerContentRows(baseRows, contentWidth, wrapMode);

  // Apply scroll offset and max height
  const visibleRows = maxHeight
    ? displayRows.slice(scrollOffset, scrollOffset + maxHeight)
    : displayRows.slice(scrollOffset);

  const lines: string[] = [];

  for (const row of visibleRows) {
    if (row.type === 'truncation') {
      lines.push(`{yellow-fg}${escapeContent(row.content)}{/yellow-fg}`);
      continue;
    }

    // Code row
    const isContinuation = row.isContinuation ?? false;

    // Line number display
    let lineNumDisplay: string;
    if (isContinuation) {
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
      const truncatedHighlight = shouldTruncate
        ? truncateAnsi(row.highlighted, contentWidth)
        : row.highlighted;
      // Convert ANSI to blessed tags
      displayContent = ansiToBlessed(truncatedHighlight);
    } else {
      // Plain content path
      let plainContent = rawContent;

      // Apply middle-dots to raw content
      if (showMiddleDots && !isContinuation) {
        plainContent = applyMiddleDots(plainContent, true);
      }

      // Simple truncation for plain content
      if (shouldTruncate) {
        plainContent = plainContent.slice(0, Math.max(0, contentWidth - 1)) + '...';
      }

      displayContent = escapeContent(plainContent);
    }

    // Format line with line number
    let line = '';
    if (isContinuation) {
      line = `{cyan-fg}${lineNumDisplay}{/cyan-fg} ${displayContent || ' '}`;
    } else {
      line = `{gray-fg}${lineNumDisplay}{/gray-fg} ${displayContent || ' '}`;
    }

    lines.push(line);
  }

  return lines.join('\n');
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
  const contentWidth = width - lineNumWidth - 2;

  return getExplorerContentRowCount(rows, contentWidth, wrapMode);
}
