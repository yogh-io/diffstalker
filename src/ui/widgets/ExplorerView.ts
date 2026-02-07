import type { ExplorerDisplayRow } from '../../core/ExplorerStateManager.js';
import type { FileStatus } from '../../git/status.js';
import {
  ANSI_RESET,
  ANSI_BOLD,
  ANSI_GRAY,
  ANSI_CYAN,
  ANSI_YELLOW,
  ANSI_GREEN,
  ANSI_RED,
  ANSI_BLUE,
  ANSI_MAGENTA,
  ANSI_INVERSE,
} from '../../utils/ansi.js';

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
    default:
      return '';
  }
}

/**
 * Get color for git status.
 */
function getStatusColor(status: FileStatus | undefined): string {
  if (!status) return ANSI_RESET;
  switch (status) {
    case 'modified':
      return ANSI_YELLOW;
    case 'added':
      return ANSI_GREEN;
    case 'deleted':
      return ANSI_RED;
    case 'untracked':
      return ANSI_GRAY;
    case 'renamed':
      return ANSI_BLUE;
    case 'copied':
      return ANSI_MAGENTA;
    default:
      return ANSI_RESET;
  }
}

/**
 * Format a single explorer row as a raw ANSI string.
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
  const statusColor = getStatusColor(node.gitStatus);
  const statusDisplay = statusMarker ? `${statusColor}${statusMarker}${ANSI_RESET} ` : '';

  const dirStatusDisplay =
    node.isDirectory && node.hasChangedChildren ? `${ANSI_YELLOW}●${ANSI_RESET} ` : '';

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

  let line = `${ANSI_GRAY}${prefix}${ANSI_RESET}`;

  if (node.isDirectory) {
    line += `${ANSI_BLUE}${icon}${ANSI_RESET}`;
    line += dirStatusDisplay;

    if (isHighlighted) {
      line += `${ANSI_CYAN}${ANSI_BOLD}${ANSI_INVERSE}${displayName}${ANSI_RESET}`;
    } else {
      line += `${ANSI_BLUE}${displayName}${ANSI_RESET}`;
    }
  } else {
    line += statusDisplay;

    if (isHighlighted) {
      line += `${ANSI_CYAN}${ANSI_BOLD}${ANSI_INVERSE}${displayName}${ANSI_RESET}`;
    } else if (node.gitStatus) {
      line += `${statusColor}${displayName}${ANSI_RESET}`;
    } else {
      line += displayName;
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
    lines.push(`{escape}${line}{/escape}`);
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
 * Build breadcrumb segments from a path.
 * Returns segments like ["src", "components"] for "src/components"
 */
export function buildBreadcrumbs(currentPath: string): string[] {
  if (!currentPath) return [];
  return currentPath.split('/').filter(Boolean);
}

/**
 * Format breadcrumbs for display.
 */
export function formatBreadcrumbs(currentPath: string, repoName: string): string {
  const segments = buildBreadcrumbs(currentPath);
  if (segments.length === 0) {
    return `{bold}${escapeContent(repoName)}{/bold}`;
  }

  const parts = [repoName, ...segments];
  return parts
    .map((part, i) => {
      if (i === parts.length - 1) {
        return `{bold}${escapeContent(part)}{/bold}`;
      }
      return `{gray-fg}${escapeContent(part)}{/gray-fg}`;
    })
    .join('{gray-fg}/{/gray-fg}');
}

/**
 * Get total rows in explorer for scroll calculations.
 */
export function getExplorerTotalRows(displayRows: ExplorerDisplayRow[]): number {
  return displayRows.length;
}

/**
 * Get row at index.
 */
export function getExplorerRowAtIndex(
  displayRows: ExplorerDisplayRow[],
  index: number
): ExplorerDisplayRow | null {
  return displayRows[index] ?? null;
}
