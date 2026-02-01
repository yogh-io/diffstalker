import type { FileEntry, FileStatus } from '../../git/status.js';
import type { FileHunkCounts } from '../../core/GitStateManager.js';
import { categorizeFiles } from '../../utils/fileCategories.js';
import { shortenPath } from '../../utils/formatPath.js';

function getStatusChar(status: FileStatus): string {
  switch (status) {
    case 'modified':
      return 'M';
    case 'added':
      return 'A';
    case 'deleted':
      return 'D';
    case 'untracked':
      return '?';
    case 'renamed':
      return 'R';
    case 'copied':
      return 'C';
    default:
      return ' ';
  }
}

function getStatusColor(status: FileStatus): string {
  switch (status) {
    case 'modified':
      return 'yellow';
    case 'added':
      return 'green';
    case 'deleted':
      return 'red';
    case 'untracked':
      return 'gray';
    case 'renamed':
      return 'blue';
    case 'copied':
      return 'cyan';
    default:
      return 'white';
  }
}

function formatStats(insertions?: number, deletions?: number): string {
  if (insertions === undefined && deletions === undefined) return '';
  const parts: string[] = [];
  if (insertions !== undefined && insertions > 0) {
    parts.push(`{green-fg}+${insertions}{/green-fg}`);
  }
  if (deletions !== undefined && deletions > 0) {
    parts.push(`{red-fg}-${deletions}{/red-fg}`);
  }
  return parts.length > 0 ? ' ' + parts.join(' ') : '';
}

interface RowItem {
  type: 'header' | 'file' | 'spacer';
  content?: string;
  headerColor?: string;
  file?: FileEntry;
  fileIndex?: number;
}

/**
 * Build the list of row items for the file list.
 */
export function buildFileListRows(files: FileEntry[]): RowItem[] {
  const { modified, untracked, staged } = categorizeFiles(files);
  const rows: RowItem[] = [];
  let currentFileIndex = 0;

  if (modified.length > 0) {
    rows.push({ type: 'header', content: 'Modified:', headerColor: 'yellow' });
    modified.forEach((file) => {
      rows.push({ type: 'file', file, fileIndex: currentFileIndex++ });
    });
  }

  if (untracked.length > 0) {
    if (modified.length > 0) {
      rows.push({ type: 'spacer' });
    }
    rows.push({ type: 'header', content: 'Untracked:', headerColor: 'gray' });
    untracked.forEach((file) => {
      rows.push({ type: 'file', file, fileIndex: currentFileIndex++ });
    });
  }

  if (staged.length > 0) {
    if (modified.length > 0 || untracked.length > 0) {
      rows.push({ type: 'spacer' });
    }
    rows.push({ type: 'header', content: 'Staged:', headerColor: 'green' });
    staged.forEach((file) => {
      rows.push({ type: 'file', file, fileIndex: currentFileIndex++ });
    });
  }

  return rows;
}

/**
 * Format a single file row as blessed-compatible tagged string.
 */
/**
 * Format hunk count indicator for a file, e.g. "@2/3".
 * Returns empty string if not applicable.
 */
function formatHunkIndicator(file: FileEntry, hunkCounts: FileHunkCounts | null): string {
  if (!hunkCounts) return '';

  const stagedHunks = hunkCounts.staged.get(file.path) ?? 0;
  const unstagedHunks = hunkCounts.unstaged.get(file.path) ?? 0;
  const total = stagedHunks + unstagedHunks;

  if (total === 0) return '';

  const thisCount = file.staged ? stagedHunks : unstagedHunks;
  // Show just @total when all hunks are in this state, otherwise @n/total
  if (thisCount === total) return ` {cyan-fg}@${total}{/cyan-fg}`;

  return ` {cyan-fg}@${thisCount}/${total}{/cyan-fg}`;
}

function formatFileRow(
  file: FileEntry,
  fileIndex: number,
  selectedIndex: number,
  isFocused: boolean,
  maxPathLength: number,
  hunkCounts: FileHunkCounts | null
): string {
  const isSelected = fileIndex === selectedIndex;

  const statusChar = getStatusChar(file.status);
  const statusColor = getStatusColor(file.status);
  const actionButton = file.staged ? '[-]' : '[+]';
  const buttonColor = file.staged ? 'red' : 'green';

  // Calculate available space for path
  const stats = formatStats(file.insertions, file.deletions);
  const hunkIndicator = formatHunkIndicator(file, hunkCounts);
  const statsLength = stats.replace(/\{[^}]+\}/g, '').length;
  const hunkLength = hunkIndicator.replace(/\{[^}]+\}/g, '').length;
  const availableForPath = maxPathLength - statsLength - hunkLength;
  const displayPath = shortenPath(file.path, availableForPath);

  // Build the line — always show indicator for selected file, bright when focused
  let indicator: string;
  if (isSelected && isFocused) {
    indicator = '{cyan-fg}{bold}\u25b8 {/bold}{/cyan-fg}';
  } else if (isSelected) {
    indicator = '{gray-fg}\u25b8 {/gray-fg}';
  } else {
    indicator = '  ';
  }

  let line = indicator;
  line += `{${buttonColor}-fg}${actionButton}{/${buttonColor}-fg} `;
  line += `{${statusColor}-fg}${statusChar}{/${statusColor}-fg} `;

  if (isSelected && isFocused) {
    line += `{cyan-fg}{inverse}${displayPath}{/inverse}{/cyan-fg}`;
  } else if (isSelected) {
    line += `{cyan-fg}${displayPath}{/cyan-fg}`;
  } else {
    line += displayPath;
  }

  if (file.originalPath) {
    line += ` {gray-fg}\u2190 ${shortenPath(file.originalPath, 30)}{/gray-fg}`;
  }

  line += stats;
  line += hunkIndicator;
  return line;
}

/**
 * Format the file list as blessed-compatible tagged string.
 */
export function formatFileList(
  files: FileEntry[],
  selectedIndex: number,
  isFocused: boolean,
  width: number,
  scrollOffset: number = 0,
  maxHeight?: number,
  hunkCounts?: FileHunkCounts | null
): string {
  if (files.length === 0) {
    return '{gray-fg} No changes{/gray-fg}';
  }

  const rows = buildFileListRows(files);
  const maxPathLength = width - 12; // Account for prefix chars

  // Apply scroll offset and max height
  const visibleRows = maxHeight
    ? rows.slice(scrollOffset, scrollOffset + maxHeight)
    : rows.slice(scrollOffset);

  const lines: string[] = [];

  for (const row of visibleRows) {
    switch (row.type) {
      case 'header':
        lines.push(`{bold}{${row.headerColor}-fg}${row.content}{/${row.headerColor}-fg}{/bold}`);
        break;
      case 'spacer':
        lines.push('');
        break;
      case 'file':
        if (row.file && row.fileIndex !== undefined) {
          lines.push(
            formatFileRow(
              row.file,
              row.fileIndex,
              selectedIndex,
              isFocused,
              maxPathLength,
              hunkCounts ?? null
            )
          );
        }
        break;
    }
  }

  return lines.join('\n');
}

/**
 * Get the total number of rows in the file list (for scroll calculation).
 */
export function getFileListTotalRows(files: FileEntry[]): number {
  return buildFileListRows(files).length;
}

/**
 * Get the file at a specific index (accounting for category ordering).
 */
export function getFileAtIndex(files: FileEntry[], index: number): FileEntry | null {
  const { ordered } = categorizeFiles(files);
  return ordered[index] ?? null;
}

/**
 * Get the file index from a visual row (accounting for headers and spacers).
 * Returns null if the row is a header or spacer.
 */
export function getFileIndexFromRow(row: number, files: FileEntry[]): number | null {
  const rows = buildFileListRows(files);
  const rowItem = rows[row];
  if (rowItem?.type === 'file' && rowItem.fileIndex !== undefined) {
    return rowItem.fileIndex;
  }
  return null;
}

/**
 * Get the visual row index for a file index.
 */
export function getRowFromFileIndex(fileIndex: number, files: FileEntry[]): number {
  const rows = buildFileListRows(files);
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].type === 'file' && rows[i].fileIndex === fileIndex) {
      return i;
    }
  }
  return 0;
}
