import React, { useState, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';

interface BaseBranchPickerProps {
  candidates: string[];
  currentBranch: string | null;
  onSelect: (branch: string) => void;
  onCancel: () => void;
  width: number;
  height: number;
}

export function BaseBranchPicker({
  candidates,
  currentBranch,
  onSelect,
  onCancel,
  width,
  height,
}: BaseBranchPickerProps): React.ReactElement {
  const [inputValue, setInputValue] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Filter candidates based on input
  const filteredCandidates = useMemo(() => {
    if (!inputValue) return candidates;
    const lower = inputValue.toLowerCase();
    return candidates.filter(c => c.toLowerCase().includes(lower));
  }, [candidates, inputValue]);

  // Clamp selected index to valid range
  const clampedIndex = Math.min(selectedIndex, Math.max(0, filteredCandidates.length - 1));

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
    } else if (key.return) {
      // If input matches no candidates but has value, use the input as custom branch
      if (filteredCandidates.length === 0 && inputValue) {
        onSelect(inputValue);
      } else if (filteredCandidates.length > 0) {
        onSelect(filteredCandidates[clampedIndex]);
      }
    } else if (key.upArrow) {
      setSelectedIndex(prev => Math.max(0, prev - 1));
    } else if (key.downArrow) {
      setSelectedIndex(prev => Math.min(filteredCandidates.length - 1, prev + 1));
    } else if (key.backspace || key.delete) {
      setInputValue(prev => prev.slice(0, -1));
      setSelectedIndex(0);
    } else if (input && !key.ctrl && !key.meta) {
      setInputValue(prev => prev + input);
      setSelectedIndex(0);
    }
  });

  // Calculate box dimensions
  const boxWidth = Math.min(60, width - 4);
  const maxListHeight = Math.min(10, height - 10);
  const boxHeight = Math.min(maxListHeight + 7, height - 4);

  // Center the modal
  const paddingLeft = Math.floor((width - boxWidth) / 2);
  const paddingTop = Math.floor((height - boxHeight) / 2);

  // Visible candidates (with scroll)
  const scrollOffset = Math.max(0, clampedIndex - maxListHeight + 1);
  const visibleCandidates = filteredCandidates.slice(scrollOffset, scrollOffset + maxListHeight);

  return (
    <Box flexDirection="column" width={width} height={height}>
      {/* Fill entire screen with blank lines to cover content behind */}
      {Array.from({ length: height }).map((_, i) => (
        <Text key={`bg-${i}`}>{' '.repeat(width)}</Text>
      ))}
      {/* Modal positioned absolutely on top */}
      <Box
        position="absolute"
        marginTop={paddingTop}
        marginLeft={paddingLeft}
        flexDirection="column"
      >
        <Box borderStyle="round" borderColor="cyan" flexDirection="column" width={boxWidth}>
          <Box justifyContent="center" marginBottom={1}>
            <Text bold color="cyan"> Select Base Branch </Text>
          </Box>

          {/* Text input */}
          <Box marginBottom={1}>
            <Text dimColor>Filter: </Text>
            <Text color="cyan">{inputValue}</Text>
            <Text color="cyan">▌</Text>
          </Box>

          {/* Candidate list */}
          <Box flexDirection="column" height={maxListHeight}>
            {visibleCandidates.length > 0 ? (
              visibleCandidates.map((branch, index) => {
                const actualIndex = scrollOffset + index;
                const isSelected = actualIndex === clampedIndex;
                const isCurrent = branch === currentBranch;

                return (
                  <Box key={branch}>
                    <Text color={isSelected ? 'cyan' : undefined}>
                      {isSelected ? '▸ ' : '  '}
                    </Text>
                    <Text
                      bold={isSelected}
                      color={isSelected ? 'cyan' : undefined}
                    >
                      {branch}
                    </Text>
                    {isCurrent && (
                      <Text dimColor> (current)</Text>
                    )}
                  </Box>
                );
              })
            ) : inputValue ? (
              <Box>
                <Text dimColor>  No matches. Press Enter to use: </Text>
                <Text color="yellow">{inputValue}</Text>
              </Box>
            ) : (
              <Text dimColor>  No candidates found</Text>
            )}
          </Box>

          {/* Scroll indicator */}
          {filteredCandidates.length > maxListHeight && (
            <Box>
              <Text dimColor>
                {scrollOffset > 0 ? '↑ ' : '  '}
                {scrollOffset + maxListHeight < filteredCandidates.length ? '↓ more' : ''}
              </Text>
            </Box>
          )}

          {/* Footer */}
          <Box marginTop={1} justifyContent="center">
            <Text dimColor>↑↓ navigate • Enter select • Esc cancel</Text>
          </Box>
        </Box>
      </Box>
    </Box>
  );
}
