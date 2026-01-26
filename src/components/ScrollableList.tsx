import React, { ReactNode, useMemo } from 'react';
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
  /** Optional function to get item height in rows (for wrapped lines). Defaults to 1. */
  getItemHeight?: (item: T, index: number) => number;
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
  getItemHeight,
}: ScrollableListProps<T>): React.ReactElement {
  // If getItemHeight is not provided, use simple item-based scrolling
  const hasVariableHeight = !!getItemHeight;

  // Calculate cumulative row positions for variable height items
  const { itemRowStarts, totalRows } = useMemo(() => {
    if (!hasVariableHeight) {
      return { itemRowStarts: [] as number[], totalRows: items.length };
    }
    const starts: number[] = [];
    let cumulative = 0;
    for (let i = 0; i < items.length; i++) {
      starts.push(cumulative);
      cumulative += getItemHeight!(items[i], i);
    }
    return { itemRowStarts: starts, totalRows: cumulative };
  }, [items, getItemHeight, hasVariableHeight]);

  // Calculate available space for actual content
  let availableHeight = maxHeight;

  // Reserve space for header if present
  if (header) {
    availableHeight--;
  }

  const hasPrevious = scrollOffset > 0;
  const contentTotal = hasVariableHeight ? totalRows : items.length;
  const needsScrolling = contentTotal > maxHeight;

  // Simple rule: if content needs scrolling, ALWAYS reserve 2 rows for indicators
  // No clever predictions - just consistent, predictable behavior
  if (showIndicators && needsScrolling) {
    availableHeight -= 2;
  }

  // Ensure we have at least 1 line for content
  availableHeight = Math.max(1, availableHeight);

  // Find visible items based on scroll offset (in rows)
  const visibleItems: { item: T; index: number }[] = [];
  let usedRows = 0;
  let rowsAbove = 0;
  let rowsBelow = 0;

  if (hasVariableHeight) {
    // Find first visible item (the one that contains scrollOffset row)
    let startIdx = 0;
    for (let i = 0; i < items.length; i++) {
      const itemHeight = getItemHeight!(items[i], i);
      if (itemRowStarts[i] + itemHeight > scrollOffset) {
        startIdx = i;
        break;
      }
    }

    // Collect items that fit in available height
    for (let i = startIdx; i < items.length && usedRows < availableHeight; i++) {
      const itemHeight = getItemHeight!(items[i], i);
      visibleItems.push({ item: items[i], index: i });
      usedRows += itemHeight;
    }

    rowsAbove = scrollOffset;
    // Simple calculation: total rows minus what we've scrolled past minus what we're showing
    rowsBelow = Math.max(0, totalRows - scrollOffset - usedRows);
  } else {
    // Simple item-based scrolling (1 item = 1 row)
    const endIdx = Math.min(scrollOffset + availableHeight, items.length);
    for (let i = scrollOffset; i < endIdx; i++) {
      visibleItems.push({ item: items[i], index: i });
      usedRows++;
    }
    rowsAbove = scrollOffset;
    rowsBelow = Math.max(0, items.length - scrollOffset - usedRows);
  }

  return (
    <Box flexDirection="column" overflowX="hidden" height={maxHeight} overflow="hidden">
      {header}

      {showIndicators &&
        needsScrolling &&
        (hasPrevious ? <Text dimColor>↑ {rowsAbove} more above</Text> : <Text> </Text>)}

      {visibleItems.map(({ item, index }) => (
        <Box key={getKey(item, index)}>{renderItem(item, index)}</Box>
      ))}

      {showIndicators &&
        needsScrolling &&
        (rowsBelow > 0 ? <Text dimColor>↓ {rowsBelow} more below</Text> : <Text> </Text>)}
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
