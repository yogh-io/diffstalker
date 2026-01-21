import { DiffLine } from '../git/diff.js';

/**
 * Check if a diff header line should be displayed.
 * Filters out redundant headers like index, ---, +++, and similarity index.
 * This is used consistently across DiffView, CompareView, and HistoryDiffView.
 */
export function isDisplayableDiffHeader(content: string): boolean {
  return !(
    content.startsWith('index ') ||
    content.startsWith('--- ') ||
    content.startsWith('+++ ') ||
    content.startsWith('similarity index')
  );
}

/**
 * Check if a diff line should be displayed.
 * Non-header lines are always displayed.
 * Header lines are filtered using isDisplayableDiffHeader.
 */
export function isDisplayableDiffLine(line: DiffLine): boolean {
  if (line.type !== 'header') return true;
  return isDisplayableDiffHeader(line.content);
}
