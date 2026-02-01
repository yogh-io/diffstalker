import type { FlatFileEntry, StagingState } from '../../utils/flatFileList.js';
import {
  getStatusChar,
  getStatusColor,
  formatStats,
  formatSelectionIndicator,
  formatFilePath,
  formatOriginalPath,
} from './fileRowFormatters.js';

function getStagingButton(state: StagingState): { text: string; color: string } {
  switch (state) {
    case 'unstaged':
      return { text: '[+]', color: 'green' };
    case 'staged':
      return { text: '[-]', color: 'red' };
    case 'partial':
      return { text: '[~]', color: 'yellow' };
  }
}

function formatFlatHunkIndicator(entry: FlatFileEntry): string {
  if (entry.totalHunks === 0) return '';

  // Always show staged/total in flat view
  return ` {cyan-fg}@${entry.stagedHunks}/${entry.totalHunks}{/cyan-fg}`;
}

function formatFlatFileRow(
  entry: FlatFileEntry,
  index: number,
  selectedIndex: number,
  isFocused: boolean,
  maxPathLength: number
): string {
  const isSelected = index === selectedIndex;

  const statusChar = getStatusChar(entry.status);
  const statusColor = getStatusColor(entry.status);
  const button = getStagingButton(entry.stagingState);

  const stats = formatStats(entry.insertions, entry.deletions);
  const hunkIndicator = formatFlatHunkIndicator(entry);
  const statsLength = stats.replace(/\{[^}]+\}/g, '').length;
  const hunkLength = hunkIndicator.replace(/\{[^}]+\}/g, '').length;
  const availableForPath = maxPathLength - statsLength - hunkLength;

  let line = formatSelectionIndicator(isSelected, isFocused);
  line += `{${button.color}-fg}${button.text}{/${button.color}-fg} `;
  line += `{${statusColor}-fg}${statusChar}{/${statusColor}-fg} `;
  line += formatFilePath(entry.path, isSelected, isFocused, availableForPath);
  line += formatOriginalPath(entry.originalPath);
  line += stats;
  line += hunkIndicator;
  return line;
}

/**
 * Format the flat file list as blessed-compatible tagged string.
 * Row 0 is a header; files start at row 1.
 */
export function formatFlatFileList(
  flatFiles: FlatFileEntry[],
  selectedIndex: number,
  isFocused: boolean,
  width: number,
  scrollOffset: number = 0,
  maxHeight?: number
): string {
  if (flatFiles.length === 0) {
    return '{gray-fg} No changes{/gray-fg}';
  }

  const maxPathLength = width - 12;

  // Build all rows: header + file rows
  const allRows: string[] = [];
  allRows.push('{bold}{gray-fg}All files (h):{/gray-fg}{/bold}');
  for (let i = 0; i < flatFiles.length; i++) {
    allRows.push(formatFlatFileRow(flatFiles[i], i, selectedIndex, isFocused, maxPathLength));
  }

  // Apply scroll offset and max height
  const visibleRows = maxHeight
    ? allRows.slice(scrollOffset, scrollOffset + maxHeight)
    : allRows.slice(scrollOffset);

  return visibleRows.join('\n');
}

/**
 * Total rows in the flat file list (header + files).
 */
export function getFlatFileListTotalRows(flatFiles: FlatFileEntry[]): number {
  if (flatFiles.length === 0) return 0;
  return flatFiles.length + 1; // +1 for header
}
