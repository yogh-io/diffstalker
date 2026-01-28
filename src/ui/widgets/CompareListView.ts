import type { CommitInfo } from '../../git/status.js';
import type { CompareFileDiff } from '../../git/diff.js';
import { formatDate } from '../../utils/formatDate.js';
import { formatCommitDisplay } from '../../utils/commitFormat.js';
import { buildFileTree, flattenTree, buildTreePrefix, TreeRowItem } from '../../utils/fileTree.js';

export type CompareListSelectionType = 'commit' | 'file';

export interface CompareListSelection {
  type: CompareListSelectionType;
  index: number;
}

interface RowItem {
  type: 'section-header' | 'commit' | 'directory' | 'file' | 'spacer';
  sectionType?: 'commits' | 'files';
  commitIndex?: number;
  fileIndex?: number;
  commit?: CommitInfo;
  file?: CompareFileDiff;
  treeRow?: TreeRowItem;
}

// ANSI escape codes for raw terminal output (avoids blessed tag escaping issues)
const ANSI_RESET = '\x1b[0m';
const ANSI_BOLD = '\x1b[1m';
const ANSI_GRAY = '\x1b[90m';
const ANSI_CYAN = '\x1b[36m';
const ANSI_YELLOW = '\x1b[33m';
const ANSI_GREEN = '\x1b[32m';
const ANSI_RED = '\x1b[31m';
const ANSI_BLUE = '\x1b[34m';
const ANSI_MAGENTA = '\x1b[35m';
const ANSI_INVERSE = '\x1b[7m';

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

  // Files section with tree view
  if (files.length > 0) {
    if (commits.length > 0) {
      result.push({ type: 'spacer' });
    }
    result.push({ type: 'section-header', sectionType: 'files' });
    if (filesExpanded) {
      // Build tree from files
      const tree = buildFileTree(files);
      const treeRows = flattenTree(tree);

      for (const treeRow of treeRows) {
        if (treeRow.type === 'directory') {
          result.push({ type: 'directory', treeRow });
        } else {
          const file = files[treeRow.fileIndex!];
          result.push({ type: 'file', fileIndex: treeRow.fileIndex, file, treeRow });
        }
      }
    }
  }

  return result;
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

  let line = ` ${ANSI_YELLOW}${commit.shortHash}${ANSI_RESET} `;

  if (isHighlighted) {
    line += `${ANSI_CYAN}${ANSI_INVERSE}${displayMessage}${ANSI_RESET}`;
  } else {
    line += displayMessage;
  }

  line += ` ${ANSI_GRAY}(${dateStr})${ANSI_RESET}`;

  if (displayRefs) {
    line += ` ${ANSI_GREEN}${displayRefs}${ANSI_RESET}`;
  }

  return `{escape}${line}{/escape}`;
}

/**
 * Format a directory row in tree view.
 */
function formatDirectoryRow(treeRow: TreeRowItem, width: number): string {
  const prefix = buildTreePrefix(treeRow);
  const icon = '▸ '; // Collapsed folder icon (we don't support expanding individual folders yet)

  // Truncate name if needed
  const maxNameLen = width - prefix.length - icon.length - 2;
  let name = treeRow.name;
  if (name.length > maxNameLen) {
    name = name.slice(0, maxNameLen - 1) + '…';
  }

  const line = `${ANSI_GRAY}${prefix}${ANSI_RESET}${ANSI_BLUE}${icon}${name}${ANSI_RESET}`;
  return `{escape}${line}{/escape}`;
}

/**
 * Format a file row in tree view.
 */
function formatFileRow(
  file: CompareFileDiff,
  treeRow: TreeRowItem,
  isSelected: boolean,
  isFocused: boolean,
  width: number
): string {
  const isHighlighted = isSelected && isFocused;
  const isUncommitted = file.isUncommitted ?? false;

  const prefix = buildTreePrefix(treeRow);

  const statusColors: Record<CompareFileDiff['status'], string> = {
    added: ANSI_GREEN,
    modified: ANSI_YELLOW,
    deleted: ANSI_RED,
    renamed: ANSI_BLUE,
  };

  // File icon based on status
  const statusIcons: Record<CompareFileDiff['status'], string> = {
    added: '+',
    modified: '●',
    deleted: '−',
    renamed: '→',
  };

  const statusColor = isUncommitted ? ANSI_MAGENTA : statusColors[file.status];
  const icon = statusIcons[file.status];

  // Calculate available width for filename
  const statsStr = `(+${file.additions} -${file.deletions})`;
  const uncommittedStr = isUncommitted ? ' [uncommitted]' : '';
  const fixedWidth = prefix.length + 2 + statsStr.length + uncommittedStr.length + 2;
  const maxNameLen = Math.max(5, width - fixedWidth);

  let name = treeRow.name;
  if (name.length > maxNameLen) {
    name = name.slice(0, maxNameLen - 1) + '…';
  }

  let line = `${ANSI_GRAY}${prefix}${ANSI_RESET}`;
  line += `${statusColor}${icon}${ANSI_RESET} `;

  if (isHighlighted) {
    line += `${ANSI_CYAN}${ANSI_INVERSE}${name}${ANSI_RESET}`;
  } else if (isUncommitted) {
    line += `${ANSI_MAGENTA}${name}${ANSI_RESET}`;
  } else {
    line += name;
  }

  line += ` ${ANSI_GRAY}(${ANSI_GREEN}+${file.additions}${ANSI_RESET} ${ANSI_RED}-${file.deletions}${ANSI_GRAY})${ANSI_RESET}`;

  if (isUncommitted) {
    line += ` ${ANSI_MAGENTA}[uncommitted]${ANSI_RESET}`;
  }

  return `{escape}${line}{/escape}`;
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
      lines.push(
        `{escape}${ANSI_CYAN}${ANSI_BOLD}▼ ${label}${ANSI_RESET} ${ANSI_GRAY}(${count})${ANSI_RESET}{/escape}`
      );
    } else if (row.type === 'spacer') {
      lines.push('');
    } else if (row.type === 'commit' && row.commit && row.commitIndex !== undefined) {
      const isSelected = selectedItem?.type === 'commit' && selectedItem.index === row.commitIndex;
      lines.push(formatCommitRow(row.commit, isSelected, isFocused, width));
    } else if (row.type === 'directory' && row.treeRow) {
      lines.push(formatDirectoryRow(row.treeRow, width));
    } else if (row.type === 'file' && row.file && row.fileIndex !== undefined && row.treeRow) {
      const isSelected = selectedItem?.type === 'file' && selectedItem.index === row.fileIndex;
      lines.push(formatFileRow(row.file, row.treeRow, isSelected, isFocused, width));
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
  return buildCompareListRows(commits, files, commitsExpanded, filesExpanded).length;
}

/**
 * Map a row index to a selection.
 * Returns null if the row is a header, spacer, or directory.
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
