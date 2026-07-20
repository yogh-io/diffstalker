import type { CommitInfo } from '@diffstalker/core/git/status';
import type { CompareFileDiff } from '@diffstalker/core/git/diff';
import { formatDate } from '../../utils/formatDate.js';
import { formatCommitDisplay } from '../../utils/commitFormat.js';
import { buildFileTree, flattenTree, buildTreePrefix, TreeRowItem } from '../../utils/fileTree.js';

/** Escape blessed tag braces in user-supplied text (names, messages, refs). */
function escapeContent(content: string): string {
  return content.replace(/\{/g, '{{').replace(/\}/g, '}}');
}

/** Wrap text in a blessed foreground colour tag. */
function fg(color: string, text: string): string {
  return `{${color}-fg}${text}{/${color}-fg}`;
}

/** Selected+focused highlight: inverse cyan. */
function highlight(text: string): string {
  return `{cyan-fg}{inverse}${text}{/inverse}{/cyan-fg}`;
}

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

  let line = ` ${fg('yellow', commit.shortHash)} `;

  if (isHighlighted) {
    line += highlight(escapeContent(displayMessage));
  } else {
    line += escapeContent(displayMessage);
  }

  const dateTag = fg('gray', `(${dateStr})`);
  line += ` ${dateTag}`;

  if (displayRefs) {
    line += ` ${fg('green', escapeContent(displayRefs))}`;
  }

  return line;
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

  const line = fg('gray', prefix) + fg('blue', `${icon}${escapeContent(name)}`);
  return line;
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
    added: 'green',
    modified: 'yellow',
    deleted: 'red',
    renamed: 'blue',
  };

  // File icon based on status
  const statusIcons: Record<CompareFileDiff['status'], string> = {
    added: '+',
    modified: '●',
    deleted: '−',
    renamed: '→',
  };

  const statusColor = isUncommitted ? 'magenta' : statusColors[file.status];
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

  let line = fg('gray', prefix);
  line += `${fg(statusColor, icon)} `;

  const safeName = escapeContent(name);
  if (isHighlighted) {
    line += highlight(safeName);
  } else if (isUncommitted) {
    line += fg('magenta', safeName);
  } else {
    line += safeName;
  }

  line +=
    ` {gray-fg}({/gray-fg}` +
    `{green-fg}+${file.additions}{/green-fg} {red-fg}-${file.deletions}{/red-fg}` +
    `{gray-fg}){/gray-fg}`;

  if (isUncommitted) {
    line += ` ${fg('magenta', '[uncommitted]')}`;
  }

  return line;
}

/**
 * Check if a row is currently selected.
 */
function isRowSelected(row: RowItem, selectedItem: CompareListSelection | null): boolean {
  if (!selectedItem) return false;
  if (row.type === 'commit' && row.commitIndex !== undefined) {
    return selectedItem.type === 'commit' && selectedItem.index === row.commitIndex;
  }
  if (row.type === 'file' && row.fileIndex !== undefined) {
    return selectedItem.type === 'file' && selectedItem.index === row.fileIndex;
  }
  return false;
}

/**
 * Format a section header line (e.g. "▼ Commits (5)").
 */
function formatSectionHeader(label: string, count: number): string {
  const countTag = fg('gray', `(${count})`);
  return `{cyan-fg}{bold}▼ ${escapeContent(label)}{/bold}{/cyan-fg} ${countTag}`;
}

/**
 * Format a single compare list row, returning null for unrenderable rows.
 */
function formatCompareRow(
  row: RowItem,
  selectedItem: CompareListSelection | null,
  isFocused: boolean,
  commits: CommitInfo[],
  files: CompareFileDiff[],
  width: number
): string | null {
  if (row.type === 'section-header') {
    const isCommits = row.sectionType === 'commits';
    return formatSectionHeader(
      isCommits ? 'Commits' : 'Files',
      isCommits ? commits.length : files.length
    );
  }
  if (row.type === 'spacer') return '';
  if (row.type === 'directory' && row.treeRow) return formatDirectoryRow(row.treeRow, width);

  const selected = isRowSelected(row, selectedItem);
  if (row.type === 'commit' && row.commit && row.commitIndex !== undefined) {
    return formatCommitRow(row.commit, selected, isFocused, width);
  }
  if (row.type === 'file' && row.file && row.fileIndex !== undefined && row.treeRow) {
    return formatFileRow(row.file, row.treeRow, selected, isFocused, width);
  }
  return null;
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
  maxHeight?: number,
  includeUncommitted: boolean = false,
  noBaseBranch: boolean = false
): string {
  // Checkbox header line (always shown, outside scroll area)
  const checkbox = includeUncommitted
    ? `${fg('magenta', '[x] Include uncommitted')} ${fg('gray', '(u)')}`
    : `${fg('yellow', '[ ] Include uncommitted')} ${fg('gray', '(u)')}`;

  // No base branch to diff against is a distinct state from "diffed and found
  // nothing". Base detection only considers remote refs (e.g. origin/main),
  // so a repo with no remote has none — say so instead of "No changes".
  if (noBaseBranch) {
    return (
      checkbox +
      '\n{gray-fg}No base branch to compare against — base detection uses remote' +
      ' branches (e.g. origin/main) and this repo has none. Pick one with (b).{/gray-fg}'
    );
  }

  if (commits.length === 0 && files.length === 0) {
    return checkbox + '\n{gray-fg}No changes compared to base branch{/gray-fg}';
  }

  const rows = buildCompareListRows(commits, files);

  // Apply scroll offset and max height
  const visibleRows = maxHeight
    ? rows.slice(scrollOffset, scrollOffset + maxHeight)
    : rows.slice(scrollOffset);

  const lines: string[] = visibleRows
    .map((row) => formatCompareRow(row, selectedItem, isFocused, commits, files, width))
    .filter((line) => line !== null);

  return checkbox + '\n' + lines.join('\n');
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
