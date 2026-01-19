import React from 'react';
import { Box, Text, useInput } from 'ink';
import { Modal, centerModal } from './Modal.js';

interface HotkeysModalProps {
  onClose: () => void;
  width: number;
  height: number;
}

interface HotkeyEntry {
  key: string;
  description: string;
}

interface HotkeyGroup {
  title: string;
  entries: HotkeyEntry[];
}

const hotkeyGroups: HotkeyGroup[] = [
  {
    title: 'Navigation',
    entries: [
      { key: '↑/k', description: 'Move up' },
      { key: '↓/j', description: 'Move down' },
      { key: 'Tab', description: 'Toggle pane focus' },
    ],
  },
  {
    title: 'Staging',
    entries: [
      { key: '^S', description: 'Stage file' },
      { key: '^U', description: 'Unstage file' },
      { key: '^A', description: 'Stage all' },
      { key: '^Z', description: 'Unstage all' },
      { key: 'Space/Enter', description: 'Toggle stage' },
    ],
  },
  {
    title: 'Actions',
    entries: [
      { key: 'c', description: 'Open commit panel' },
      { key: 'r', description: 'Refresh' },
      { key: 'q', description: 'Quit' },
    ],
  },
  {
    title: 'Pane Resize',
    entries: [
      { key: '[', description: 'Shrink top pane' },
      { key: ']', description: 'Grow top pane' },
    ],
  },
  {
    title: 'Tabs',
    entries: [
      { key: '1', description: 'Diff view' },
      { key: '2', description: 'Commit panel' },
      { key: '3', description: 'History view' },
      { key: '4', description: 'PR view' },
    ],
  },
  {
    title: 'Other',
    entries: [
      { key: 'm', description: 'Toggle scroll/select mode' },
      { key: 'f', description: 'Toggle follow mode' },
      { key: 't', description: 'Theme picker' },
      { key: 'b', description: 'Base branch picker (PR)' },
      { key: 'u', description: 'Toggle uncommitted (PR)' },
      { key: '?', description: 'This help' },
    ],
  },
];

export function HotkeysModal({
  onClose,
  width,
  height,
}: HotkeysModalProps): React.ReactElement {
  useInput((input, key) => {
    if (key.escape || key.return || input === '?') {
      onClose();
    }
  });

  // Calculate box dimensions
  const boxWidth = Math.min(60, width - 4);
  const totalLines = hotkeyGroups.reduce((sum, g) => sum + g.entries.length + 2, 0) + 4; // +2 per group for title+spacing, +4 for header/footer/borders
  const boxHeight = Math.min(totalLines, height - 4);

  // Center the modal
  const { x, y } = centerModal(boxWidth, boxHeight, width, height);

  return (
    <Modal x={x} y={y} width={boxWidth} height={boxHeight}>
      <Box borderStyle="round" borderColor="cyan" flexDirection="column" width={boxWidth}>
        <Box justifyContent="center" marginBottom={1}>
          <Text bold color="cyan"> Keyboard Shortcuts </Text>
        </Box>

        {hotkeyGroups.map((group) => (
          <Box key={group.title} flexDirection="column" marginBottom={1}>
            <Text bold dimColor>{group.title}</Text>
            {group.entries.map((entry) => (
              <Box key={entry.key}>
                <Box width={15}>
                  <Text color="cyan">{entry.key}</Text>
                </Box>
                <Text>{entry.description}</Text>
              </Box>
            ))}
          </Box>
        ))}

        <Box marginTop={1} justifyContent="center">
          <Text dimColor>Press Esc, Enter, or ? to close</Text>
        </Box>
      </Box>
    </Modal>
  );
}
