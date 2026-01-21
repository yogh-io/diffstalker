import React from 'react';
import { Box, Text } from 'ink';
import { ExplorerItem } from '../hooks/useExplorerState.js';
import { ScrollableList } from './ScrollableList.js';

interface ExplorerViewProps {
  currentPath: string;
  items: ExplorerItem[];
  selectedIndex: number;
  scrollOffset: number;
  maxHeight: number;
  isActive: boolean;
  width: number;
  isLoading?: boolean;
  error?: string | null;
}

export function ExplorerView({
  currentPath: _currentPath,
  items,
  selectedIndex,
  scrollOffset,
  maxHeight,
  isActive,
  width,
  isLoading = false,
  error = null,
}: ExplorerViewProps): React.ReactElement {
  if (error) {
    return (
      <Box flexDirection="column">
        <Text color="red">Error: {error}</Text>
      </Box>
    );
  }

  if (isLoading) {
    return (
      <Box flexDirection="column">
        <Text dimColor>Loading...</Text>
      </Box>
    );
  }

  if (items.length === 0) {
    return (
      <Box flexDirection="column">
        <Text dimColor>(empty directory)</Text>
      </Box>
    );
  }

  // Calculate max name width for alignment
  const maxNameWidth = Math.min(
    Math.max(...items.map((item) => item.name.length + (item.isDirectory ? 1 : 0))),
    width - 10
  );

  return (
    <ScrollableList
      items={items}
      maxHeight={maxHeight}
      scrollOffset={scrollOffset}
      getKey={(item) => item.path || item.name}
      renderItem={(item, actualIndex) => {
        const isSelected = actualIndex === selectedIndex && isActive;
        const displayName = item.isDirectory ? `${item.name}/` : item.name;
        const paddedName = displayName.padEnd(maxNameWidth + 1);

        return (
          <Box>
            <Text color={isSelected ? 'cyan' : undefined} bold={isSelected} inverse={isSelected}>
              {item.isDirectory ? (
                <Text color={isSelected ? 'cyan' : 'blue'}>{paddedName}</Text>
              ) : (
                <Text color={isSelected ? 'cyan' : undefined}>{paddedName}</Text>
              )}
            </Text>
          </Box>
        );
      }}
    />
  );
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
 * Get total rows in explorer for scroll calculations.
 */
export function getExplorerTotalRows(items: ExplorerItem[]): number {
  return items.length;
}
