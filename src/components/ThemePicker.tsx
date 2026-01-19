import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { ThemeName, Theme, themes, themeOrder, getTheme } from '../themes.js';
import { Modal, centerModal } from './Modal.js';

interface ThemePickerProps {
  currentTheme: ThemeName;
  onSelect: (theme: ThemeName) => void;
  onCancel: () => void;
  width: number;
  height: number;
}

// Preview sample for theme visualization
function ThemePreview({ theme }: { theme: Theme }): React.ReactElement {
  const { colors } = theme;

  return (
    <Box flexDirection="column" marginLeft={2}>
      <Box>
        <Text backgroundColor={colors.delBg} color={colors.delLineNum}>{'  5 '}</Text>
        <Text backgroundColor={colors.delBg} color={colors.delSymbol} bold>{'- '}</Text>
        <Text backgroundColor={colors.delBg} color={colors.text}>{'const '}</Text>
        <Text backgroundColor={colors.delHighlight} color={colors.text}>{'old'}</Text>
        <Text backgroundColor={colors.delBg} color={colors.text}>{' = value;'}</Text>
      </Box>
      <Box>
        <Text backgroundColor={colors.addBg} color={colors.addLineNum}>{'  5 '}</Text>
        <Text backgroundColor={colors.addBg} color={colors.addSymbol} bold>{'+ '}</Text>
        <Text backgroundColor={colors.addBg} color={colors.text}>{'const '}</Text>
        <Text backgroundColor={colors.addHighlight} color={colors.text}>{'new'}</Text>
        <Text backgroundColor={colors.addBg} color={colors.text}>{' = value;'}</Text>
      </Box>
    </Box>
  );
}

export function ThemePicker({
  currentTheme,
  onSelect,
  onCancel,
  width,
  height,
}: ThemePickerProps): React.ReactElement {
  const [selectedIndex, setSelectedIndex] = useState(() => {
    const idx = themeOrder.indexOf(currentTheme);
    return idx >= 0 ? idx : 0;
  });

  const previewTheme = getTheme(themeOrder[selectedIndex]);

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
    } else if (key.return) {
      onSelect(themeOrder[selectedIndex]);
    } else if (key.upArrow || input === 'k') {
      setSelectedIndex(prev => Math.max(0, prev - 1));
    } else if (key.downArrow || input === 'j') {
      setSelectedIndex(prev => Math.min(themeOrder.length - 1, prev + 1));
    }
  });

  // Calculate box dimensions
  const boxWidth = Math.min(50, width - 4);
  const boxHeight = Math.min(themeOrder.length + 10, height - 4); // +10 for header, preview, footer, borders

  // Center the modal
  const { x, y } = centerModal(boxWidth, boxHeight, width, height);

  return (
    <Modal x={x} y={y} width={boxWidth} height={boxHeight}>
      <Box borderStyle="round" borderColor="cyan" flexDirection="column" width={boxWidth}>
        <Box justifyContent="center" marginBottom={1}>
          <Text bold color="cyan"> Select Theme </Text>
        </Box>

        {/* Theme list */}
        {themeOrder.map((themeName, index) => {
          const theme = themes[themeName];
          const isSelected = index === selectedIndex;
          const isCurrent = themeName === currentTheme;

          return (
            <Box key={themeName}>
              <Text color={isSelected ? 'cyan' : undefined}>
                {isSelected ? '▸ ' : '  '}
              </Text>
              <Text
                bold={isSelected}
                color={isSelected ? 'cyan' : undefined}
              >
                {theme.displayName}
              </Text>
              {isCurrent && (
                <Text dimColor> (current)</Text>
              )}
            </Box>
          );
        })}

        {/* Preview section */}
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>Preview:</Text>
          <ThemePreview theme={previewTheme} />
        </Box>

        {/* Footer */}
        <Box marginTop={1} justifyContent="center">
          <Text dimColor>↑↓ navigate • Enter select • Esc cancel</Text>
        </Box>
      </Box>
    </Modal>
  );
}
