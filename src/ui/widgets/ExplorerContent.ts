import {
  ExplorerContentRow,
  buildExplorerContentRows,
  wrapExplorerContentRows,
  getExplorerContentRowCount,
  getExplorerContentLineNumWidth,
} from '../../utils/explorerDisplayRows.js';
import { truncateAnsi } from '../../utils/ansiTruncate.js';

const ANSI_RESET = '\x1b[0m';
const ANSI_GRAY = '\x1b[90m';
const ANSI_CYAN = '\x1b[36m';
const ANSI_YELLOW = '\x1b[33m';

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
  wrapMode: boolean = false
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
      // Use {escape} with raw ANSI for consistency
      lines.push(`{escape}${ANSI_YELLOW}${row.content}${ANSI_RESET}{/escape}`);
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

    // Use highlighted content if available and not a continuation
    const canUseHighlighting = row.highlighted && !isContinuation;

    let displayContent: string;
    if (canUseHighlighting && row.highlighted) {
      // Use ANSI-aware truncation to preserve syntax highlighting
      displayContent = shouldTruncate
        ? truncateAnsi(row.highlighted, contentWidth)
        : row.highlighted;
    } else {
      // Plain content path
      let plainContent = rawContent;

      // Simple truncation for plain content
      if (shouldTruncate) {
        plainContent = plainContent.slice(0, Math.max(0, contentWidth - 1)) + '...';
      }

      displayContent = plainContent;
    }

    // Format line with line number using raw ANSI (avoids blessed escaping issues)
    const lineNumColor = isContinuation ? ANSI_CYAN : ANSI_GRAY;
    const line = `{escape}${lineNumColor}${lineNumDisplay}${ANSI_RESET} ${displayContent || ' '}{/escape}`;

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
