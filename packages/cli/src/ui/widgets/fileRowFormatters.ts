import type { FileStatus } from '../../git/status.js';
import { shortenPath } from '../../utils/formatPath.js';

export function getStatusChar(status: FileStatus): string {
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

export function getStatusColor(status: FileStatus): string {
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

export function formatStats(insertions?: number, deletions?: number): string {
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

export function formatSelectionIndicator(isSelected: boolean, isFocused: boolean): string {
  if (isSelected && isFocused) {
    return '{cyan-fg}{bold}\u25b8 {/bold}{/cyan-fg}';
  } else if (isSelected) {
    return '{gray-fg}\u25b8 {/gray-fg}';
  }
  return '  ';
}

export function formatFilePath(
  path: string,
  isSelected: boolean,
  isFocused: boolean,
  maxLength: number
): string {
  const displayPath = shortenPath(path, maxLength);
  if (isSelected && isFocused) {
    return `{cyan-fg}{inverse}${displayPath}{/inverse}{/cyan-fg}`;
  } else if (isSelected) {
    return `{cyan-fg}${displayPath}{/cyan-fg}`;
  }
  return displayPath;
}

export function formatOriginalPath(originalPath?: string): string {
  if (!originalPath) return '';
  return ` {gray-fg}\u2190 ${shortenPath(originalPath, 30)}{/gray-fg}`;
}
