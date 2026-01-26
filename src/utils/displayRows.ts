// Unified row model for all diff views
// Every row = exactly 1 terminal row

import { DiffResult, DiffLine, CompareDiff } from '../git/diff.js';
import { CommitInfo } from '../git/status.js';
import { formatDateAbsolute } from './formatDate.js';
import { isDisplayableDiffLine } from './diffFilters.js';
import { breakLine, getLineRowCount } from './lineBreaking.js';

// Unified display row types - every type renders as exactly 1 terminal row
export type DisplayRow =
  | { type: 'diff-header'; content: string }
  | { type: 'diff-hunk'; content: string }
  | { type: 'diff-add'; lineNum?: number; content: string }
  | { type: 'diff-del'; lineNum?: number; content: string }
  | { type: 'diff-context'; lineNum?: number; content: string }
  | { type: 'commit-header'; content: string }
  | { type: 'commit-message'; content: string }
  | { type: 'spacer' };

/**
 * Get the text content from a diff line (strip leading +/-/space)
 */
function getLineContent(line: DiffLine): string {
  if (line.type === 'addition' || line.type === 'deletion') {
    return line.content.slice(1);
  }
  if (line.type === 'context') {
    // Context lines start with space
    return line.content.startsWith(' ') ? line.content.slice(1) : line.content;
  }
  return line.content;
}

/**
 * Convert a DiffLine to a DisplayRow
 */
function convertDiffLineToDisplayRow(line: DiffLine): DisplayRow {
  switch (line.type) {
    case 'header':
      return { type: 'diff-header', content: line.content };
    case 'hunk':
      return { type: 'diff-hunk', content: line.content };
    case 'addition':
      return {
        type: 'diff-add',
        lineNum: line.newLineNum,
        content: getLineContent(line),
      };
    case 'deletion':
      return {
        type: 'diff-del',
        lineNum: line.oldLineNum,
        content: getLineContent(line),
      };
    case 'context':
      return {
        type: 'diff-context',
        lineNum: line.oldLineNum ?? line.newLineNum,
        content: getLineContent(line),
      };
  }
}

/**
 * Build display rows from a DiffResult.
 * Filters out non-displayable lines (index, ---, +++ headers).
 */
export function buildDiffDisplayRows(diff: DiffResult | null): DisplayRow[] {
  if (!diff) return [];
  return diff.lines.filter(isDisplayableDiffLine).map(convertDiffLineToDisplayRow);
}

/**
 * Build display rows from commit + diff (for History tab).
 * Includes commit metadata, message, then diff lines.
 */
export function buildHistoryDisplayRows(
  commit: CommitInfo | null,
  diff: DiffResult | null
): DisplayRow[] {
  const rows: DisplayRow[] = [];

  if (commit) {
    rows.push({ type: 'commit-header', content: `commit ${commit.hash}` });
    rows.push({ type: 'commit-header', content: `Author: ${commit.author}` });
    rows.push({ type: 'commit-header', content: `Date:   ${formatDateAbsolute(commit.date)}` });
    rows.push({ type: 'spacer' });

    for (const line of commit.message.split('\n')) {
      rows.push({ type: 'commit-message', content: `    ${line}` });
    }
    rows.push({ type: 'spacer' });
  }

  rows.push(...buildDiffDisplayRows(diff));
  return rows;
}

/**
 * Build display rows for compare view from CompareDiff.
 * Combines all file diffs into a single DisplayRow array.
 */
export function buildCompareDisplayRows(compareDiff: CompareDiff | null): DisplayRow[] {
  if (!compareDiff || compareDiff.files.length === 0) {
    return [];
  }

  const rows: DisplayRow[] = [];

  for (const file of compareDiff.files) {
    rows.push(...buildDiffDisplayRows(file.diff));
  }

  return rows;
}

/**
 * Get the maximum line number width needed for alignment.
 * Scans all rows with line numbers and returns the digit count.
 */
export function getDisplayRowsLineNumWidth(rows: DisplayRow[]): number {
  let max = 0;
  for (const row of rows) {
    if ('lineNum' in row && row.lineNum !== undefined) {
      max = Math.max(max, row.lineNum);
    }
  }
  return Math.max(3, String(max).length);
}

// Extended row type with wrap metadata
export type WrappedDisplayRow = DisplayRow & {
  isContinuation?: boolean;
};

/**
 * Expand display rows for wrap mode.
 * Long content lines are broken into multiple rows with continuation markers.
 * Headers, hunks, and metadata rows remain truncated (not wrapped).
 *
 * @param rows - Original display rows
 * @param contentWidth - Available width for content (after line num, symbol, padding)
 * @param wrapEnabled - Whether wrap mode is enabled
 * @returns Array of rows, potentially expanded with continuations
 */
export function wrapDisplayRows(
  rows: DisplayRow[],
  contentWidth: number,
  wrapEnabled: boolean
): WrappedDisplayRow[] {
  if (!wrapEnabled) return rows;

  // Minimum content width to prevent excessive segments
  const minWidth = 10;
  const effectiveWidth = Math.max(minWidth, contentWidth);

  const result: WrappedDisplayRow[] = [];

  for (const row of rows) {
    // Only wrap diff content lines (add, del, context)
    if (row.type === 'diff-add' || row.type === 'diff-del' || row.type === 'diff-context') {
      const content = row.content;

      // Skip wrapping for empty or short content
      if (!content || content.length <= effectiveWidth) {
        result.push(row);
        continue;
      }

      const segments = breakLine(content, effectiveWidth);

      for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        result.push({
          ...row,
          content: segment.text,
          lineNum: segment.isContinuation ? undefined : row.lineNum,
          isContinuation: segment.isContinuation,
        });
      }
    } else {
      // Headers, hunks, commit metadata - don't wrap
      result.push(row);
    }
  }

  return result;
}

/**
 * Calculate the total row count after wrapping.
 * More efficient than wrapDisplayRows().length when you only need the count.
 */
export function getWrappedRowCount(
  rows: DisplayRow[],
  contentWidth: number,
  wrapEnabled: boolean
): number {
  if (!wrapEnabled) return rows.length;

  const minWidth = 10;
  const effectiveWidth = Math.max(minWidth, contentWidth);

  let count = 0;
  for (const row of rows) {
    if (row.type === 'diff-add' || row.type === 'diff-del' || row.type === 'diff-context') {
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
