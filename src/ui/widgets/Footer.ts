import type { BottomTab } from '../../types/tabs.js';

/**
 * Calculate visible length by stripping blessed tags.
 */
function calculateVisibleLength(content: string): number {
  // eslint-disable-next-line sonarjs/slow-regex
  return content.replace(/\{[^}]+\}/g, '').length;
}

/**
 * Format footer content as blessed-compatible tagged string.
 */
export function formatFooter(
  activeTab: BottomTab,
  mouseEnabled: boolean,
  autoTabEnabled: boolean,
  wrapMode: boolean,
  followEnabled: boolean,
  showOnlyChanges: boolean,
  width: number
): string {
  // Left side: indicators
  let leftContent = '{gray-fg}?{/gray-fg} ';
  leftContent += mouseEnabled
    ? '{yellow-fg}[scroll]{/yellow-fg}'
    : '{yellow-fg}m:[select]{/yellow-fg}';
  leftContent += ' ';
  leftContent += autoTabEnabled ? '{blue-fg}[auto]{/blue-fg}' : '{gray-fg}[auto]{/gray-fg}';
  leftContent += ' ';
  leftContent += wrapMode ? '{blue-fg}[wrap]{/blue-fg}' : '{gray-fg}[wrap]{/gray-fg}';
  leftContent += ' ';
  leftContent += followEnabled ? '{blue-fg}[follow]{/blue-fg}' : '{gray-fg}[follow]{/gray-fg}';

  if (activeTab === 'explorer') {
    leftContent += ' ';
    leftContent += showOnlyChanges
      ? '{blue-fg}[changes]{/blue-fg}'
      : '{gray-fg}[changes]{/gray-fg}';
  }

  // Right side: tabs
  const tabs: Array<{ key: string; label: string; tab: BottomTab }> = [
    { key: '1', label: 'Diff', tab: 'diff' },
    { key: '2', label: 'Commit', tab: 'commit' },
    { key: '3', label: 'History', tab: 'history' },
    { key: '4', label: 'Compare', tab: 'compare' },
    { key: '5', label: 'Explorer', tab: 'explorer' },
  ];

  const rightContent = tabs
    .map(({ key, label, tab }) => {
      const isActive = activeTab === tab;
      if (isActive) {
        return `{bold}{cyan-fg}[${key}]${label}{/cyan-fg}{/bold}`;
      }
      return `[${key}]${label}`;
    })
    .join(' ');

  // Calculate padding for right alignment
  const leftLen = calculateVisibleLength(leftContent);
  const rightLen = calculateVisibleLength(rightContent);
  const padding = Math.max(1, width - leftLen - rightLen);

  return leftContent + ' '.repeat(padding) + rightContent;
}
