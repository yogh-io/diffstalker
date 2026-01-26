import type { CommitInfo } from '../../git/status.js';
import { formatDate } from '../../utils/formatDate.js';
import { formatCommitDisplay } from '../../utils/commitFormat.js';

/**
 * Format the history view as blessed-compatible tagged string.
 */
export function formatHistoryView(
  commits: CommitInfo[],
  selectedIndex: number,
  isFocused: boolean,
  width: number,
  scrollOffset: number = 0,
  maxHeight?: number
): string {
  if (commits.length === 0) {
    return '{gray-fg}No commits yet{/gray-fg}';
  }

  // Apply scroll offset and max height
  const visibleCommits = maxHeight
    ? commits.slice(scrollOffset, scrollOffset + maxHeight)
    : commits.slice(scrollOffset);

  const lines: string[] = [];

  for (let i = 0; i < visibleCommits.length; i++) {
    const commit = visibleCommits[i];
    const actualIndex = scrollOffset + i;
    const isSelected = actualIndex === selectedIndex;
    const isHighlighted = isSelected && isFocused;

    const dateStr = formatDate(commit.date);
    // Fixed parts: hash(7) + spaces(4) + date + parens(2) + selection indicator(2)
    const baseWidth = 7 + 4 + dateStr.length + 2 + 2;
    const remainingWidth = Math.max(10, width - baseWidth);

    const { displayMessage, displayRefs } = formatCommitDisplay(
      commit.message,
      commit.refs,
      remainingWidth
    );

    let line = '';

    // Selection indicator
    if (isHighlighted) {
      line += '{cyan-fg}{bold}▸ {/bold}{/cyan-fg}';
    } else {
      line += '  ';
    }

    // Short hash
    line += `{yellow-fg}${commit.shortHash}{/yellow-fg} `;

    // Message (with highlighting)
    if (isHighlighted) {
      line += `{cyan-fg}{inverse}${escapeContent(displayMessage)}{/inverse}{/cyan-fg}`;
    } else {
      line += escapeContent(displayMessage);
    }

    // Date
    line += ` {gray-fg}(${dateStr}){/gray-fg}`;

    // Refs (branch names, tags)
    if (displayRefs) {
      line += ` {green-fg}${escapeContent(displayRefs)}{/green-fg}`;
    }

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
 * Get the total number of rows in the history view (for scroll calculation).
 */
export function getHistoryTotalRows(commits: CommitInfo[]): number {
  return commits.length;
}

/**
 * Get the commit at a specific index.
 */
export function getCommitAtIndex(commits: CommitInfo[], index: number): CommitInfo | null {
  return commits[index] ?? null;
}
