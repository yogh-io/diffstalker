import type { ExplorerDisplayRow } from '../../state/ExplorerViewModel.js';
import type { FileStatus } from '@diffstalker/core/git/status';

/**
 * Build tree prefix characters (│ ├ └).
 */
function buildTreePrefix(row: ExplorerDisplayRow): string {
  let prefix = '';

  // Add vertical lines for parent levels
  for (let i = 0; i < row.depth; i++) {
    if (row.parentIsLast[i]) {
      prefix += '  '; // Parent was last, no line needed
    } else {
      prefix += '│ '; // Parent has siblings below, draw line
    }
  }

  // Add connector for this item
  if (row.depth > 0 || row.parentIsLast.length === 0) {
    if (row.isLast) {
      prefix += '└ ';
    } else {
      prefix += '├ ';
    }
  }

  return prefix;
}

/**
 * Get status marker for git status.
 *
 * Exhaustive with no `default`, like getStatusColorName below: the next
 * FileStatus should be a compile error, not a blank marker.
 */
function getStatusMarker(status: FileStatus | undefined): string {
  if (!status) return '';
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
    // git's own porcelain letter for an unmerged path.
    case 'conflicted':
      return 'U';
  }
}

/**
 * Get the blessed tag colour name for a git status.
 *
 * Explorer rows are emitted as blessed tags (like every other widget), not
 * raw ANSI. Raw ANSI wrapped in {escape} does not survive neo-blessed's cell
 * renderer — the SGR-terminator letters (the `m` in \x1b[..m) leak onto the
 * screen as stray glyphs and the colours are lost.
 */
function getStatusColorName(status: FileStatus | undefined): string | null {
  if (!status) return null;
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
      return 'magenta';
    case 'conflicted':
      return 'brightred';
  }
}

/** Wrap text in a blessed foreground colour tag. */
function fg(color: string, text: string): string {
  return `{${color}-fg}${text}{/${color}-fg}`;
}

/**
 * Format a single explorer row as a blessed-tagged string. Tree glyphs are
 * safe literals; file/dir names are escaped so a `{` or `}` in a filename
 * cannot be parsed as a tag.
 */
function formatExplorerRow(
  row: ExplorerDisplayRow,
  isSelected: boolean,
  isFocused: boolean,
  width: number
): string {
  const isHighlighted = isSelected && isFocused;
  const node = row.node;

  const prefix = buildTreePrefix(row);

  let icon = '';
  if (node.isDirectory) {
    icon = node.expanded ? '▾ ' : '▸ ';
  }

  const statusMarker = getStatusMarker(node.gitStatus);
  const statusColorName = getStatusColorName(node.gitStatus);
  const statusDisplay =
    statusMarker && statusColorName ? `${fg(statusColorName, statusMarker)} ` : '';

  const dirStatusDisplay =
    node.isDirectory && node.hasChangedChildren ? `${fg('yellow', '●')} ` : '';

  const prefixLen =
    prefix.length +
    icon.length +
    (statusMarker ? 2 : 0) +
    (node.hasChangedChildren && node.isDirectory ? 2 : 0);
  const maxNameLen = Math.max(5, width - prefixLen - 2);

  let displayName = node.isDirectory ? `${node.name}/` : node.name;
  if (displayName.length > maxNameLen) {
    displayName = displayName.slice(0, maxNameLen - 1) + '…';
  }
  const safeName = escapeContent(displayName);

  const highlightedName = `{cyan-fg}{bold}{inverse}${safeName}{/inverse}{/bold}{/cyan-fg}`;

  let line = fg('gray', prefix);

  if (node.isDirectory) {
    line += fg('blue', icon);
    line += dirStatusDisplay;
    line += isHighlighted ? highlightedName : fg('blue', safeName);
  } else {
    line += statusDisplay;
    if (isHighlighted) {
      line += highlightedName;
    } else if (statusColorName) {
      line += fg(statusColorName, safeName);
    } else {
      line += safeName;
    }
  }

  return line;
}

/**
 * Format the explorer tree view as blessed-compatible tagged string.
 */
export function formatExplorerView(
  displayRows: ExplorerDisplayRow[],
  selectedIndex: number,
  isFocused: boolean,
  width: number,
  scrollOffset: number = 0,
  maxHeight?: number,
  isLoading: boolean = false,
  error: string | null = null
): string {
  if (error) {
    return `{red-fg}Error: ${escapeContent(error)}{/red-fg}`;
  }

  if (isLoading) {
    return '{gray-fg}Loading...{/gray-fg}';
  }

  if (displayRows.length === 0) {
    return '{gray-fg}(empty directory){/gray-fg}';
  }

  const visibleRows = maxHeight
    ? displayRows.slice(scrollOffset, scrollOffset + maxHeight)
    : displayRows.slice(scrollOffset);

  const lines: string[] = [];

  for (let i = 0; i < visibleRows.length; i++) {
    const actualIndex = scrollOffset + i;
    const line = formatExplorerRow(visibleRows[i], actualIndex === selectedIndex, isFocused, width);
    lines.push(line);
  }

  return lines.join('\n');
}

/**
 * Escape blessed tags in content.
 */
function escapeContent(content: string): string {
  return content.replace(/\{/g, '{{').replace(/\}/g, '}}');
}

/**
 * Get total rows in explorer for scroll calculations.
 */
export function getExplorerTotalRows(displayRows: ExplorerDisplayRow[]): number {
  return displayRows.length;
}
