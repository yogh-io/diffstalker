import React, { ReactNode } from 'react';
import { Box, Text } from 'ink';

interface ScrollableListProps<T> {
  items: T[];
  renderItem: (item: T, index: number) => ReactNode;
  maxHeight: number;
  scrollOffset: number;
  /** Unique key for each item */
  getKey: (item: T, index: number) => string;
  /** Optional header that takes 1 line */
  header?: ReactNode;
  /** Show scroll indicators when content overflows */
  showIndicators?: boolean;
}

/**
 * A generic scrollable list component that properly handles:
 * - Scroll indicators (↑/↓) taking up space
 * - Consistent height calculations
 * - Proper React keys for re-rendering
 *
 * Usage:
 * ```tsx
 * <ScrollableList
 *   items={myItems}
 *   renderItem={(item, i) => <MyRow item={item} />}
 *   maxHeight={20}
 *   scrollOffset={offset}
 *   getKey={(item, i) => item.id}
 * />
 * ```
 */
export function ScrollableList<T>({
  items,
  renderItem,
  maxHeight,
  scrollOffset,
  getKey,
  header,
  showIndicators = true,
}: ScrollableListProps<T>): React.ReactElement {
  // Calculate available space for actual content
  let availableHeight = maxHeight;

  // Reserve space for header if present
  if (header) {
    availableHeight--;
  }

  // Check if we need scroll indicators
  const hasPrevious = scrollOffset > 0;
  const totalItems = items.length;

  // Tentatively check if we'd have more items after showing availableHeight
  const wouldHaveMore = totalItems > scrollOffset + availableHeight;

  // Reserve space for indicators if they'll be shown
  if (showIndicators) {
    if (hasPrevious) availableHeight--;
    if (wouldHaveMore) availableHeight--;
  }

  // Ensure we have at least 1 line for content
  availableHeight = Math.max(1, availableHeight);

  // Slice the visible items
  const visibleItems = items.slice(scrollOffset, scrollOffset + availableHeight);
  const hasMore = totalItems > scrollOffset + availableHeight;

  // Calculate counts for indicators
  const aboveCount = scrollOffset;
  const belowCount = totalItems - scrollOffset - visibleItems.length;

  return (
    <Box flexDirection="column" overflowX="hidden">
      {header}

      {showIndicators && hasPrevious && <Text dimColor>↑ {aboveCount} more above</Text>}

      {visibleItems.map((item, i) => (
        <Box key={`${scrollOffset}-${i}-${getKey(item, scrollOffset + i)}`} overflowX="hidden">
          {renderItem(item, scrollOffset + i)}
        </Box>
      ))}

      {showIndicators && hasMore && <Text dimColor>↓ {belowCount} more below</Text>}
    </Box>
  );
}

/**
 * Calculate the maximum scroll offset for a list.
 */
export function getMaxScrollOffset(
  totalItems: number,
  maxHeight: number,
  hasHeader: boolean = false,
  showIndicators: boolean = true
): number {
  let availableHeight = maxHeight;
  if (hasHeader) availableHeight--;

  // When scrolled, we always show "↑ above" indicator
  // and usually "↓ below" indicator, so subtract 2
  if (showIndicators && totalItems > availableHeight) {
    availableHeight -= 2;
  }

  availableHeight = Math.max(1, availableHeight);
  return Math.max(0, totalItems - availableHeight);
}

/**
 * Calculate visible item count for a given configuration.
 * Useful for scroll calculations in parent components.
 */
export function getVisibleItemCount(
  totalItems: number,
  maxHeight: number,
  scrollOffset: number,
  hasHeader: boolean = false,
  showIndicators: boolean = true
): number {
  let availableHeight = maxHeight;
  if (hasHeader) availableHeight--;

  if (showIndicators) {
    if (scrollOffset > 0) availableHeight--;
    if (totalItems > scrollOffset + availableHeight) availableHeight--;
  }

  availableHeight = Math.max(1, availableHeight);
  return Math.min(availableHeight, totalItems - scrollOffset);
}
