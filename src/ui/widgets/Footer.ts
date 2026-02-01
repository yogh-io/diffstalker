import type { BottomTab } from '../../types/tabs.js';

/**
 * Calculate visible length by stripping blessed tags.
 */
function calculateVisibleLength(content: string): number {
  return content.replace(/\{[^}]+\}/g, '').length;
}

/**
 * Format a toggle indicator: blue when on, gray when off.
 */
function toggleIndicator(label: string, enabled: boolean): string {
  return enabled ? `{blue-fg}[${label}]{/blue-fg}` : `{gray-fg}[${label}]{/gray-fg}`;
}

/**
 * Build the left-side indicators for the standard (non-hunk) footer.
 */
function buildStandardIndicators(
  mouseEnabled: boolean,
  autoTabEnabled: boolean,
  wrapMode: boolean,
  followEnabled: boolean,
  showOnlyChanges: boolean,
  activeTab: BottomTab
): string {
  const parts: string[] = [];
  parts.push(
    mouseEnabled ? '{yellow-fg}[scroll]{/yellow-fg}' : '{yellow-fg}m:[select]{/yellow-fg}'
  );
  parts.push(toggleIndicator('auto', autoTabEnabled));
  parts.push(toggleIndicator('wrap', wrapMode));
  parts.push(toggleIndicator('follow', followEnabled));
  if (activeTab === 'explorer') {
    parts.push(toggleIndicator('changes', showOnlyChanges));
  }
  return parts.join(' ');
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
  width: number,
  currentPane?: string
): string {
  // Left side: indicators
  let leftContent = '{gray-fg}?{/gray-fg} ';

  leftContent += buildStandardIndicators(
    mouseEnabled,
    autoTabEnabled,
    wrapMode,
    followEnabled,
    showOnlyChanges,
    activeTab
  );

  // Show hunk key hints when diff pane is focused on diff tab
  if (activeTab === 'diff' && currentPane === 'diff') {
    leftContent += ' {gray-fg}n/N:hunk s:toggle{/gray-fg}';
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
