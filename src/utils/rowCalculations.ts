import { CommitInfo } from '../git/status.js';
import { CompareDiff, DiffResult, DiffLine } from '../git/diff.js';
import { isDisplayableDiffLine } from './diffFilters.js';
import { formatDateAbsolute } from './formatDate.js';
import { getDiffTotalRows, getDiffLineRowCount } from './diffRowCalculations.js';

// ============================================================================
// History View Row Calculations
// ============================================================================

/**
 * Map a visual row index to the commit index in HistoryView.
 * Since each commit takes 1 row, this is simply visualRow + scrollOffset.
 */
export function getCommitIndexFromRow(
  visualRow: number,
  commits: CommitInfo[],
  _terminalWidth: number,
  scrollOffset: number = 0
): number {
  const index = visualRow + scrollOffset;
  if (index < 0 || index >= commits.length) {
    return -1;
  }
  return index;
}

/**
 * Get the total number of visual rows for all commits in HistoryView.
 * Since each commit takes 1 row, this equals commits.length.
 */
export function getHistoryTotalRows(commits: CommitInfo[], _terminalWidth: number): number {
  return commits.length;
}

/**
 * Get the visual row offset for a given commit index in HistoryView.
 * Since each commit takes 1 row, this equals commitIndex.
 */
export function getHistoryRowOffset(
  _commits: CommitInfo[],
  commitIndex: number,
  _terminalWidth: number
): number {
  return commitIndex;
}

// ============================================================================
// History Diff View Row Calculations
// ============================================================================

export interface HistoryDiffRow {
  type: 'commit-header' | 'commit-message' | 'spacer' | 'diff-line';
  content?: string;
  diffLine?: DiffLine;
}

/**
 * Build all displayable rows for the history diff view.
 * This includes commit metadata, message, and diff lines.
 * Single source of truth for both rendering and row counting.
 */
export function buildHistoryDiffRows(
  commit: CommitInfo | null,
  diff: DiffResult | null
): HistoryDiffRow[] {
  const rows: HistoryDiffRow[] = [];

  if (commit) {
    // Commit header: hash, author, date
    rows.push({
      type: 'commit-header',
      content: `commit ${commit.hash}`,
    });
    rows.push({
      type: 'commit-header',
      content: `Author: ${commit.author}`,
    });
    rows.push({
      type: 'commit-header',
      content: `Date:   ${formatDateAbsolute(commit.date)}`,
    });

    // Blank line before message
    rows.push({ type: 'spacer' });

    // Commit message (can be multi-line)
    const messageLines = commit.message.split('\n');
    for (const line of messageLines) {
      rows.push({
        type: 'commit-message',
        content: `    ${line}`,
      });
    }

    // Blank line after message, before diff
    rows.push({ type: 'spacer' });
  }

  // Diff lines (filter same as DiffView)
  if (diff) {
    for (const line of diff.lines) {
      if (isDisplayableDiffLine(line)) {
        rows.push({ type: 'diff-line', diffLine: line });
      }
    }
  }

  return rows;
}

/**
 * Get the visual row count for a single HistoryDiffRow.
 * Headers, spacers, and commit messages are always 1 row.
 * Diff lines may wrap based on terminal width.
 */
export function getHistoryDiffRowHeight(
  row: HistoryDiffRow,
  lineNumWidth: number,
  terminalWidth: number
): number {
  if (row.type !== 'diff-line' || !row.diffLine) {
    return 1; // Headers, spacers, commit messages don't wrap
  }
  return getDiffLineRowCount(row.diffLine, lineNumWidth, terminalWidth);
}

/**
 * Get total displayable rows for history diff scroll calculation.
 * Uses getDiffTotalRows for the diff portion to account for line wrapping.
 */
export function getHistoryDiffTotalRows(
  commit: CommitInfo | null,
  diff: DiffResult | null,
  terminalWidth: number
): number {
  // Count header rows (these don't wrap - they're short metadata)
  let headerRows = 0;
  if (commit) {
    headerRows += 3; // hash, author, date
    headerRows += 1; // spacer before message
    headerRows += commit.message.split('\n').length; // message lines
    headerRows += 1; // spacer after message
  }

  // Use getDiffTotalRows for diff portion (handles line wrapping)
  const diffRows = getDiffTotalRows(diff, terminalWidth);

  return headerRows + diffRows;
}

// ============================================================================
// Compare View Row Calculations
// ============================================================================

/**
 * Build a combined DiffResult from all compare files.
 * This is the single source of truth for compare diff content.
 */
export function buildCombinedCompareDiff(compareDiff: CompareDiff | null): DiffResult {
  if (!compareDiff || compareDiff.files.length === 0) {
    return { raw: '', lines: [] };
  }

  const allLines: DiffLine[] = [];
  const rawParts: string[] = [];

  for (const file of compareDiff.files) {
    // Include all lines from each file's diff (including headers)
    for (const line of file.diff.lines) {
      allLines.push(line);
    }
    rawParts.push(file.diff.raw);
  }

  return {
    raw: rawParts.join('\n'),
    lines: allLines,
  };
}

/**
 * Calculate the total number of displayable lines in the compare diff.
 * This accounts for header filtering done by DiffView.
 */
export function getCompareDiffTotalRows(compareDiff: CompareDiff | null): number {
  const combined = buildCombinedCompareDiff(compareDiff);
  return combined.lines.filter(isDisplayableDiffLine).length;
}

/**
 * Calculate the row offset to scroll to a specific file in the compare diff.
 * Returns the row index where the file's diff --git header starts.
 */
export function getFileScrollOffset(compareDiff: CompareDiff | null, fileIndex: number): number {
  if (!compareDiff || fileIndex < 0 || fileIndex >= compareDiff.files.length) return 0;

  const combined = buildCombinedCompareDiff(compareDiff);
  let displayableRow = 0;
  let currentFileIndex = 0;

  for (const line of combined.lines) {
    // Check if this is a file boundary
    if (line.type === 'header' && line.content.startsWith('diff --git')) {
      if (currentFileIndex === fileIndex) {
        return displayableRow;
      }
      currentFileIndex++;
    }

    // Skip lines that DiffView filters out
    if (!isDisplayableDiffLine(line)) {
      continue;
    }
    displayableRow++;
  }

  return 0;
}

// ============================================================================
// Compare List View Row Calculations
// ============================================================================

/**
 * Map a visual row index to the item index in CompareListView.
 * Returns the commit index for commits, or commitCount + fileIndex for files.
 * Returns -1 if the row is a header, spacer, or out of bounds.
 *
 * Row structure (when both commits and files exist, both expanded):
 *   Row 0:    "▼ Commits" header
 *   Row 1..N: commits
 *   Row N+1:  spacer
 *   Row N+2:  "▼ Files" header
 *   Rows N+3..: files
 */
export function getCompareItemIndexFromRow(
  row: number,
  commitCount: number,
  fileCount: number,
  commitsExpanded: boolean = true,
  filesExpanded: boolean = true
): number {
  let currentRow = 0;

  // Commits section
  if (commitCount > 0) {
    if (row === currentRow) return -1; // "▼ Commits" header
    currentRow++;

    if (commitsExpanded) {
      if (row < currentRow + commitCount) {
        return row - currentRow; // Commit index
      }
      currentRow += commitCount;
    }
  }

  // Files section
  if (fileCount > 0) {
    if (commitCount > 0) {
      if (row === currentRow) return -1; // Spacer
      currentRow++;
    }

    if (row === currentRow) return -1; // "▼ Files" header
    currentRow++;

    if (filesExpanded) {
      if (row < currentRow + fileCount) {
        return commitCount + (row - currentRow); // File index (offset by commit count)
      }
    }
  }

  return -1; // Out of bounds
}
