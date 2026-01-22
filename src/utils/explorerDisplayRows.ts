/**
 * Row model for explorer file content view.
 * Follows the same pattern as displayRows.ts - single source of truth
 * for both rendering and scroll calculations.
 */

import { breakLine, getLineRowCount } from './lineBreaking.js';
import { getLanguageFromPath, highlightLine } from './languageDetection.js';

// Base row type for explorer content
export type ExplorerContentRow =
  | { type: 'code'; lineNum: number; content: string; highlighted?: string }
  | { type: 'truncation'; content: string };

// Extended row type with wrap metadata
export type WrappedExplorerContentRow = ExplorerContentRow & {
  isContinuation?: boolean;
};

/**
 * Build display rows from file content with optional syntax highlighting.
 * Each line becomes one row with line number and content.
 *
 * @param content - File content string
 * @param filePath - File path for language detection
 * @param truncated - Whether the file was truncated
 * @returns Array of explorer content rows
 */
export function buildExplorerContentRows(
  content: string | null,
  filePath: string | null,
  truncated?: boolean
): ExplorerContentRow[] {
  if (!content) return [];

  const rows: ExplorerContentRow[] = [];
  const lines = content.split('\n');

  // Detect language for highlighting
  const language = filePath ? getLanguageFromPath(filePath) : null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const highlighted = language ? highlightLine(line, language) : undefined;

    rows.push({
      type: 'code',
      lineNum: i + 1,
      content: line,
      highlighted,
    });
  }

  // Add truncation indicator if needed
  if (truncated) {
    rows.push({
      type: 'truncation',
      content: '(file truncated)',
    });
  }

  return rows;
}

/**
 * Apply line wrapping to explorer content rows.
 * Long lines are broken into multiple rows with continuation markers.
 *
 * @param rows - Original explorer content rows
 * @param contentWidth - Available width for content (after line num and padding)
 * @param wrapEnabled - Whether wrap mode is enabled
 * @returns Array of rows, potentially expanded with continuations
 */
export function wrapExplorerContentRows(
  rows: ExplorerContentRow[],
  contentWidth: number,
  wrapEnabled: boolean
): WrappedExplorerContentRow[] {
  if (!wrapEnabled) return rows;

  const minWidth = 10;
  const effectiveWidth = Math.max(minWidth, contentWidth);
  const result: WrappedExplorerContentRow[] = [];

  for (const row of rows) {
    if (row.type === 'code') {
      const content = row.content;

      // Skip wrapping for empty or short content
      if (!content || content.length <= effectiveWidth) {
        result.push(row);
        continue;
      }

      // Break into segments
      // Note: We don't wrap highlighted content because ANSI codes
      // would be split, so we wrap the raw content and apply highlighting
      // to each segment if available
      const segments = breakLine(content, effectiveWidth);

      for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        result.push({
          type: 'code',
          lineNum: segment.isContinuation ? 0 : row.lineNum,
          content: segment.text,
          // Don't apply per-segment highlighting as it would be incorrect
          // The renderer should handle continuation display
          highlighted: undefined,
          isContinuation: segment.isContinuation,
        });
      }
    } else {
      // Truncation rows - don't wrap
      result.push(row);
    }
  }

  return result;
}

/**
 * Calculate total row count after wrapping.
 * More efficient than wrapExplorerContentRows().length when only count is needed.
 *
 * @param rows - Original explorer content rows
 * @param contentWidth - Available width for content
 * @param wrapEnabled - Whether wrap mode is enabled
 * @returns Total number of rows after wrapping
 */
export function getExplorerContentRowCount(
  rows: ExplorerContentRow[],
  contentWidth: number,
  wrapEnabled: boolean
): number {
  if (!wrapEnabled) return rows.length;

  const minWidth = 10;
  const effectiveWidth = Math.max(minWidth, contentWidth);

  let count = 0;
  for (const row of rows) {
    if (row.type === 'code') {
      const content = row.content;
      if (!content || content.length <= effectiveWidth) {
        count += 1;
      } else {
        count += getLineRowCount(content, effectiveWidth);
      }
    } else {
      count += 1;
    }
  }

  return count;
}

/**
 * Get the line number column width needed for alignment.
 * Returns minimum width of 3 (for lines up to 999).
 *
 * @param rows - Explorer content rows
 * @returns Width needed for line number column
 */
export function getExplorerContentLineNumWidth(rows: ExplorerContentRow[]): number {
  let maxLineNum = 0;
  for (const row of rows) {
    if (row.type === 'code' && row.lineNum > maxLineNum) {
      maxLineNum = row.lineNum;
    }
  }
  return Math.max(3, String(maxLineNum).length);
}

/**
 * Apply middle-dots visualization to content.
 * Replaces leading spaces with middle-dot character (·) for indentation visibility.
 *
 * @param content - Line content
 * @param enabled - Whether middle-dots mode is enabled
 * @returns Content with leading spaces replaced by middle-dots
 */
export function applyMiddleDots(content: string, enabled: boolean): string {
  if (!enabled || !content) return content;

  // Count leading spaces
  let leadingSpaces = 0;
  for (const char of content) {
    if (char === ' ') {
      leadingSpaces++;
    } else if (char === '\t') {
      // Convert tab to equivalent spaces (using 2 spaces per tab)
      leadingSpaces += 2;
    } else {
      break;
    }
  }

  if (leadingSpaces === 0) return content;

  // Replace leading whitespace with dots
  const dots = '·'.repeat(leadingSpaces);
  const rest = content.slice(leadingSpaces);
  return dots + rest;
}
