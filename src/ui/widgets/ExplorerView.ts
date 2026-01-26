import type { ExplorerItem } from '../../core/ExplorerStateManager.js';

/**
 * Escape blessed tags in content.
 */
function escapeContent(content: string): string {
  return content.replace(/\{/g, '{{').replace(/\}/g, '}}');
}

/**
 * Format the explorer directory listing as blessed-compatible tagged string.
 */
export function formatExplorerView(
  items: ExplorerItem[],
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

  if (items.length === 0) {
    return '{gray-fg}(empty directory){/gray-fg}';
  }

  // Apply scroll offset and max height
  const visibleItems = maxHeight
    ? items.slice(scrollOffset, scrollOffset + maxHeight)
    : items.slice(scrollOffset);

  // Calculate max name width for alignment
  const maxNameWidth = Math.min(
    Math.max(...items.map((item) => item.name.length + (item.isDirectory ? 1 : 0))),
    width - 10
  );

  const lines: string[] = [];

  for (let i = 0; i < visibleItems.length; i++) {
    const item = visibleItems[i];
    const actualIndex = scrollOffset + i;
    const isSelected = actualIndex === selectedIndex;
    const isHighlighted = isSelected && isFocused;

    const displayName = item.isDirectory ? `${item.name}/` : item.name;
    const paddedName = displayName.padEnd(maxNameWidth + 1);

    let line = '';

    if (isHighlighted) {
      // Selected and focused - highlight with cyan
      if (item.isDirectory) {
        line = `{cyan-fg}{bold}{inverse}${escapeContent(paddedName)}{/inverse}{/bold}{/cyan-fg}`;
      } else {
        line = `{cyan-fg}{bold}{inverse}${escapeContent(paddedName)}{/inverse}{/bold}{/cyan-fg}`;
      }
    } else {
      // Not selected or not focused
      if (item.isDirectory) {
        line = `{blue-fg}${escapeContent(paddedName)}{/blue-fg}`;
      } else {
        line = escapeContent(paddedName);
      }
    }

    lines.push(line);
  }

  return lines.join('\n');
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
export function getExplorerTotalRows(items: ExplorerItem[]): number {
  return items.length;
}

/**
 * Get item at index.
 */
export function getExplorerItemAtIndex(items: ExplorerItem[], index: number): ExplorerItem | null {
  return items[index] ?? null;
}
