import React from 'react';
import { Box, Text } from 'ink';

interface ModalProps {
  x: number;
  y: number;
  width: number;
  height: number;
  children: React.ReactNode;
}

/**
 * A modal overlay that blankets only its own area before rendering children.
 * Use this to create popups that cover the content behind them.
 */
export function Modal({ x, y, width, height, children }: ModalProps): React.ReactElement {
  const blankLine = ' '.repeat(width);

  return (
    <Box position="absolute" marginLeft={x} marginTop={y} flexDirection="column">
      {/* Blank the modal area */}
      {Array.from({ length: height }).map((_, i) => (
        <Text key={`blank-${i}`}>{blankLine}</Text>
      ))}
      {/* Render content on top */}
      <Box position="absolute" flexDirection="column">
        {children}
      </Box>
    </Box>
  );
}

/**
 * Helper to calculate centered modal position.
 */
export function centerModal(
  modalWidth: number,
  modalHeight: number,
  screenWidth: number,
  screenHeight: number
): { x: number; y: number } {
  return {
    x: Math.floor((screenWidth - modalWidth) / 2),
    y: Math.floor((screenHeight - modalHeight) / 2),
  };
}
