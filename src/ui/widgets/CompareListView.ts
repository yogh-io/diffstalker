import type { CommitInfo } from '../../git/status.js';
import type { CompareFileDiff } from '../../git/diff.js';
import { formatDate } from '../../utils/formatDate.js';
import { formatCommitDisplay } from '../../utils/commitFormat.js';
import { shortenPath } from '../../utils/formatPath.js';

export type CompareListSelectionType = 'commit' | 'file';

export interface CompareListSelection {
  type: CompareListSelectionType;
  index: number;
}

interface RowItem {
  type: 'section-header' | 'commit' | 'file' | 'spacer';
  sectionType?: 'commits' | 'files';
  commitIndex?: number;
  fileIndex?: number;
  commit?: CommitInfo;
  file?: CompareFileDiff;
}

/**
 * Build the list of row items for the compare list view.
 */
export function buildCompareListRows(
  commits: CommitInfo[],
  files: CompareFileDiff[],
  commitsExpanded: boolean = true,
  filesExpanded: boolean = true
): RowItem[] {
  const result: RowItem[] = [];

  // Commits section
  if (commits.length > 0) {
    result.push({ type: 'section-header', sectionType: 'commits' });
    if (commitsExpanded) {
      commits.forEach((commit, i) => {
        result.push({ type: 'commit', commitIndex: i, commit });
      });
    }
  }

  // Files section
  if (files.length > 0) {
    if (commits.length > 0) {
      result.push({ type: 'spacer' });
    }
    result.push({ type: 'section-header', sectionType: 'files' });
    if (filesExpanded) {
      files.forEach((file, i) => {
        result.push({ type: 'file', fileIndex: i, file });
      });
    }
  }

  return result;
}

/**
 * Escape blessed tags in content.
 */
function escapeContent(content: string): string {
  return content.replace(/\{/g, '{{').replace(/\}/g, '}}');
}

/**
 * Format a commit row.
 */
function formatCommitRow(
  commit: CommitInfo,
  isSelected: boolean,
  isFocused: boolean,
  width: number
): string {
  const isHighlighted = isSelected && isFocused;
  const dateStr = formatDate(commit.date);
  // Fixed parts: indent(2) + hash(7) + spaces(4) + date + parens(2)
  const baseWidth = 2 + 7 + 4 + dateStr.length + 2;
  const remainingWidth = Math.max(10, width - baseWidth);

  const { displayMessage, displayRefs } = formatCommitDisplay(
    commit.message,
    commit.refs,
    remainingWidth
  );

  let line = ' ';
  line += `{yellow-fg}${commit.shortHash}{/yellow-fg} `;

  if (isHighlighted) {
    line += `{cyan-fg}{inverse}${escapeContent(displayMessage)}{/inverse}{/cyan-fg}`;
  } else {
    line += escapeContent(displayMessage);
  }

  line += ` {gray-fg}(${dateStr}){/gray-fg}`;

  if (displayRefs) {
    line += ` {green-fg}${escapeContent(displayRefs)}{/green-fg}`;
  }

  return line;
}

/**
 * Format a file row.
 */
function formatFileRow(
  file: CompareFileDiff,
  isSelected: boolean,
  isFocused: boolean,
  maxPathLength: number
): string {
  const isHighlighted = isSelected && isFocused;
  const isUncommitted = file.isUncommitted ?? false;

  const statusColors: Record<CompareFileDiff['status'], string> = {
    added: 'green',
    modified: 'yellow',
    deleted: 'red',
    renamed: 'blue',
  };

  const statusChars: Record<CompareFileDiff['status'], string> = {
    added: 'A',
    modified: 'M',
    deleted: 'D',
    renamed: 'R',
  };

  // Account for stats: " (+123 -456)" and possible "*" for uncommitted
  const statsLength = 5 + String(file.additions).length + String(file.deletions).length;
  const uncommittedLength = isUncommitted ? 14 : 0;
  const availableForPath = Math.max(10, maxPathLength - statsLength - uncommittedLength);

  let line = ' ';

  if (isUncommitted) {
    line += '{magenta-fg}{bold}*{/bold}{/magenta-fg}';
  }

  const statusColor = isUncommitted ? 'magenta' : statusColors[file.status];
  line += `{${statusColor}-fg}{bold}${statusChars[file.status]}{/bold}{/${statusColor}-fg} `;

  const displayPath = shortenPath(file.path, availableForPath);
  if (isHighlighted) {
    line += `{cyan-fg}{inverse}${escapeContent(displayPath)}{/inverse}{/cyan-fg}`;
  } else if (isUncommitted) {
    line += `{magenta-fg}${escapeContent(displayPath)}{/magenta-fg}`;
  } else {
    line += escapeContent(displayPath);
  }

  line += ` {gray-fg}({/gray-fg}{green-fg}+${file.additions}{/green-fg} {red-fg}-${file.deletions}{/red-fg}{gray-fg}){/gray-fg}`;

  if (isUncommitted) {
    line += ' {magenta-fg}[uncommitted]{/magenta-fg}';
  }

  return line;
}

/**
 * Format the compare list view as blessed-compatible tagged string.
 */
export function formatCompareListView(
  commits: CommitInfo[],
  files: CompareFileDiff[],
  selectedItem: CompareListSelection | null,
  isFocused: boolean,
  width: number,
  scrollOffset: number = 0,
  maxHeight?: number
): string {
  if (commits.length === 0 && files.length === 0) {
    return '{gray-fg}No changes compared to base branch{/gray-fg}';
  }

  const rows = buildCompareListRows(commits, files);

  // Apply scroll offset and max height
  const visibleRows = maxHeight
    ? rows.slice(scrollOffset, scrollOffset + maxHeight)
    : rows.slice(scrollOffset);

  const lines: string[] = [];

  for (const row of visibleRows) {
    if (row.type === 'section-header') {
      const isCommits = row.sectionType === 'commits';
      const count = isCommits ? commits.length : files.length;
      const label = isCommits ? 'Commits' : 'Files';
      lines.push(`{cyan-fg}{bold}▼ ${label}{/bold}{/cyan-fg} {gray-fg}(${count}){/gray-fg}`);
    } else if (row.type === 'spacer') {
      lines.push('');
    } else if (row.type === 'commit' && row.commit && row.commitIndex !== undefined) {
      const isSelected = selectedItem?.type === 'commit' && selectedItem.index === row.commitIndex;
      lines.push(formatCommitRow(row.commit, isSelected, isFocused, width));
    } else if (row.type === 'file' && row.file && row.fileIndex !== undefined) {
      const isSelected = selectedItem?.type === 'file' && selectedItem.index === row.fileIndex;
      lines.push(formatFileRow(row.file, isSelected, isFocused, width - 5));
    }
  }

  return lines.join('\n');
}

/**
 * Get the total number of rows in the compare list view (for scroll calculation).
 */
export function getCompareListTotalRows(
  commits: CommitInfo[],
  files: CompareFileDiff[],
  commitsExpanded: boolean = true,
  filesExpanded: boolean = true
): number {
  let count = 0;
  if (commits.length > 0) {
    count += 1; // header
    if (commitsExpanded) count += commits.length;
  }
  if (files.length > 0) {
    if (commits.length > 0) count += 1; // spacer
    count += 1; // header
    if (filesExpanded) count += files.length;
  }
  return count;
}

/**
 * Map a row index to a selection.
 * Returns null if the row is a header or spacer.
 */
export function getCompareSelectionFromRow(
  rowIndex: number,
  commits: CommitInfo[],
  files: CompareFileDiff[],
  commitsExpanded: boolean = true,
  filesExpanded: boolean = true
): CompareListSelection | null {
  const rows = buildCompareListRows(commits, files, commitsExpanded, filesExpanded);
  const row = rows[rowIndex];

  if (!row) return null;

  if (row.type === 'commit' && row.commitIndex !== undefined) {
    return { type: 'commit', index: row.commitIndex };
  }
  if (row.type === 'file' && row.fileIndex !== undefined) {
    return { type: 'file', index: row.fileIndex };
  }

  return null;
}

/**
 * Find the row index for a given selection.
 */
export function getRowFromCompareSelection(
  selection: CompareListSelection,
  commits: CommitInfo[],
  files: CompareFileDiff[],
  commitsExpanded: boolean = true,
  filesExpanded: boolean = true
): number {
  const rows = buildCompareListRows(commits, files, commitsExpanded, filesExpanded);

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (
      selection.type === 'commit' &&
      row.type === 'commit' &&
      row.commitIndex === selection.index
    ) {
      return i;
    }
    if (selection.type === 'file' && row.type === 'file' && row.fileIndex === selection.index) {
      return i;
    }
  }

  return 0;
}

/**
 * Navigate to next selectable item.
 */
export function getNextCompareSelection(
  current: CompareListSelection | null,
  commits: CommitInfo[],
  files: CompareFileDiff[],
  direction: 'up' | 'down'
): CompareListSelection | null {
  const rows = buildCompareListRows(commits, files);

  // Find current row index
  let currentRowIndex = 0;
  if (current) {
    currentRowIndex = getRowFromCompareSelection(current, commits, files);
  }

  // Find next selectable row
  const delta = direction === 'down' ? 1 : -1;
  let nextRowIndex = currentRowIndex + delta;

  while (nextRowIndex >= 0 && nextRowIndex < rows.length) {
    const selection = getCompareSelectionFromRow(nextRowIndex, commits, files);
    if (selection) {
      return selection;
    }
    nextRowIndex += delta;
  }

  // Stay at current if no valid next selection
  return current;
}
