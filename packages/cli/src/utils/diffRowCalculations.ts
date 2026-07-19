/**
 * Utilities for calculating how diff lines wrap in the terminal.
 * Used for accurate scroll calculations when lines exceed terminal width.
 */

import { DiffLine, DiffResult } from '../git/diff.js';
import { isDisplayableDiffLine } from './diffFilters.js';
import { getLineRowCount } from './lineBreaking.js';

/**
 * Get the content of a diff line without the leading +/-/space character.
 */
export function getLineContent(line: DiffLine): string {
  if (line.type === 'addition' || line.type === 'deletion') {
    return line.content.slice(1);
  }
  if (line.type === 'context' && line.content.startsWith(' ')) {
    return line.content.slice(1);
  }
  return line.content;
}

/**
 * Calculate the width of the line number column based on the largest line number.
 */
export function getLineNumWidth(lines: DiffLine[]): number {
  let maxLineNum = 0;
  for (const line of lines) {
    if (line.oldLineNum && line.oldLineNum > maxLineNum) maxLineNum = line.oldLineNum;
    if (line.newLineNum && line.newLineNum > maxLineNum) maxLineNum = line.newLineNum;
  }
  return Math.max(3, String(maxLineNum).length);
}

/**
 * Calculate the rendered width of a diff line in terminal columns.
 *
 * Layout for content lines (addition/deletion/context):
 *   paddingX(1) + lineNum + space(1) + symbol(1) + space(1) + content + paddingX(1)
 *
 * Layout for headers:
 *   paddingX(1) + "── filename ──" or raw content + paddingX(1)
 *
 * Layout for hunk headers:
 *   paddingX(1) + "Lines X-Y → X-Y context" + paddingX(1)
 */
export function getDiffLineWidth(line: DiffLine, lineNumWidth: number): number {
  const PADDING_X = 2; // 1 on each side

  if (line.type === 'header') {
    if (line.content.startsWith('diff --git')) {
      const match = line.content.match(/diff --git a\/.+ b\/(.+)$/);
      if (match) {
        // "── " + filename + " ──" = 6 chars wrapper
        return match[1].length + 6 + PADDING_X;
      }
    }
    return line.content.length + PADDING_X;
  }

  if (line.type === 'hunk') {
    const match = line.content.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
    if (match) {
      const oldStart = parseInt(match[1], 10);
      const oldCount = match[2] ? parseInt(match[2], 10) : 1;
      const newStart = parseInt(match[3], 10);
      const newCount = match[4] ? parseInt(match[4], 10) : 1;
      const context = match[5]?.trim() ?? '';

      const oldEnd = oldStart + oldCount - 1;
      const newEnd = newStart + newCount - 1;

      const oldRange = oldCount === 1 ? `${oldStart}` : `${oldStart}-${oldEnd}`;
      const newRange = newCount === 1 ? `${newStart}` : `${newStart}-${newEnd}`;

      // "Lines X-Y → X-Y" + optional " context"
      const rangeText = `Lines ${oldRange} → ${newRange}`;
      return rangeText.length + (context ? context.length + 1 : 0) + PADDING_X;
    }
    return line.content.length + PADDING_X;
  }

  // Addition/Deletion/Context lines
  // lineNum + space + symbol + space + content
  const content = getLineContent(line);
  return lineNumWidth + 1 + 1 + 1 + content.length + PADDING_X;
}

/**
 * Calculate how many terminal rows a diff line will take when rendered.
 * Uses the same line-breaking logic as the actual rendering for accuracy.
 */
export function getDiffLineRowCount(
  line: DiffLine,
  lineNumWidth: number,
  terminalWidth: number
): number {
  if (terminalWidth <= 0) return 1;

  // Headers and hunks are truncated, so they're always 1 row
  if (line.type === 'header' || line.type === 'hunk') {
    return 1;
  }

  // Content lines (addition/deletion/context) use manual line breaking
  // Layout: paddingX(1) + lineNum + space(1) + symbol(1) + space(1) + content + paddingX(1)
  const contentWidth = terminalWidth - lineNumWidth - 5;
  if (contentWidth <= 0) return 1;

  const content = getLineContent(line);
  return getLineRowCount(content, contentWidth);
}

/**
 * Calculate the total number of terminal rows for a diff.
 */
export function getDiffTotalRows(
  diff: DiffResult | null,
  terminalWidth: number,
  lineNumWidth?: number
): number {
  if (!diff || terminalWidth <= 0) return 0;

  const displayableLines = diff.lines.filter(isDisplayableDiffLine);
  if (displayableLines.length === 0) return 0;

  const lnWidth = lineNumWidth ?? getLineNumWidth(displayableLines);

  let totalRows = 0;
  for (const line of displayableLines) {
    totalRows += getDiffLineRowCount(line, lnWidth, terminalWidth);
  }

  return totalRows;
}
