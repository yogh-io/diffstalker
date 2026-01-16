import React from 'react';
import { Box, Text } from 'ink';
import { DiffResult, DiffLine } from '../git/diff.js';

interface DiffViewProps {
  diff: DiffResult | null;
  maxHeight?: number;
  scrollOffset?: number;
}

function DiffLineComponent({ line }: { line: DiffLine }): React.ReactElement {
  let color: string | undefined;
  let dimColor = false;

  switch (line.type) {
    case 'addition':
      color = 'green';
      break;
    case 'deletion':
      color = 'red';
      break;
    case 'hunk':
      color = 'cyan';
      break;
    case 'header':
      color = 'yellow';
      dimColor = true;
      break;
    case 'context':
    default:
      break;
  }

  return (
    <Text color={color} dimColor={dimColor}>
      {line.content}
    </Text>
  );
}

export function DiffView({ diff, maxHeight = 20, scrollOffset = 0 }: DiffViewProps): React.ReactElement {
  if (!diff || diff.lines.length === 0) {
    return (
      <Box paddingX={1}>
        <Text dimColor>No diff to display</Text>
      </Box>
    );
  }

  // Apply scroll offset and limit
  const visibleLines = diff.lines.slice(scrollOffset, scrollOffset + maxHeight);
  const hasMore = diff.lines.length > scrollOffset + maxHeight;
  const hasPrevious = scrollOffset > 0;

  return (
    <Box flexDirection="column" paddingX={1}>
      {hasPrevious && (
        <Text dimColor>↑ {scrollOffset} more lines above</Text>
      )}

      {visibleLines.map((line, i) => (
        <DiffLineComponent key={`${scrollOffset + i}-${line.content.slice(0, 20)}`} line={line} />
      ))}

      {hasMore && (
        <Text dimColor>↓ {diff.lines.length - scrollOffset - maxHeight} more lines below</Text>
      )}
    </Box>
  );
}
