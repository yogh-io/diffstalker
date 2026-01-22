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
      { key: '4', description: 'Compare view' },
      { key: 'a', description: 'Toggle auto-tab mode' },
    ],
  },
  {
    title: 'Other',
    entries: [
      { key: 'm', description: 'Toggle scroll/select mode' },
      { key: 'f', description: 'Toggle follow mode' },
      { key: 'w', description: 'Toggle wrap mode' },
      { key: 't', description: 'Theme picker' },
      { key: 'b', description: 'Base branch picker' },
      { key: 'u', description: 'Toggle uncommitted' },
      { key: '?', description: 'This help' },
    ],
  },
];

export function HotkeysModal({ onClose, width, height }: HotkeysModalProps): React.ReactElement {
  useInput((input, key) => {
    if (key.escape || key.return || input === '?') {
      onClose();
    }
  });

  // Determine if we should use 2 columns (need at least 90 chars width)
  const useTwoColumns = width >= 90;
  const columnWidth = useTwoColumns ? 38 : 30;
  const boxWidth = useTwoColumns ? Math.min(82, width - 4) : Math.min(40, width - 4);

  // Calculate height based on layout
  let boxHeight: number;
  if (useTwoColumns) {
    // Split groups into two columns
    const midpoint = Math.ceil(hotkeyGroups.length / 2);
    const leftGroups = hotkeyGroups.slice(0, midpoint);
    const rightGroups = hotkeyGroups.slice(midpoint);
    const leftLines = leftGroups.reduce((sum, g) => sum + g.entries.length + 2, 0);
    const rightLines = rightGroups.reduce((sum, g) => sum + g.entries.length + 2, 0);
    boxHeight = Math.min(Math.max(leftLines, rightLines) + 5, height - 4);
  } else {
    const totalLines = hotkeyGroups.reduce((sum, g) => sum + g.entries.length + 2, 0) + 4;
    boxHeight = Math.min(totalLines, height - 4);
  }

  // Center the modal
  const { x, y } = centerModal(boxWidth, boxHeight, width, height);

  // Render a single group
  const renderGroup = (group: HotkeyGroup, colWidth: number) => (
    <Box key={group.title} flexDirection="column" marginBottom={1}>
      <Text bold dimColor>
        {group.title}
      </Text>
      {group.entries.map((entry) => (
        <Box key={entry.key}>
          <Box width={13}>
            <Text color="cyan">{entry.key}</Text>
          </Box>
          <Box width={colWidth - 13}>
            <Text>{entry.description}</Text>
          </Box>
        </Box>
      ))}
    </Box>
  );

  if (useTwoColumns) {
    const midpoint = Math.ceil(hotkeyGroups.length / 2);
    const leftGroups = hotkeyGroups.slice(0, midpoint);
    const rightGroups = hotkeyGroups.slice(midpoint);

    return (
      <Modal x={x} y={y} width={boxWidth} height={boxHeight}>
        <Box borderStyle="round" borderColor="cyan" flexDirection="column" width={boxWidth}>
          <Box justifyContent="center" marginBottom={1}>
            <Text bold color="cyan">
              {' '}
              Keyboard Shortcuts{' '}
            </Text>
          </Box>

          <Box>
            <Box flexDirection="column" width={columnWidth} marginRight={2}>
              {leftGroups.map((g) => renderGroup(g, columnWidth))}
            </Box>
            <Box flexDirection="column" width={columnWidth}>
              {rightGroups.map((g) => renderGroup(g, columnWidth))}
            </Box>
          </Box>

          <Box marginTop={1} justifyContent="center">
            <Text dimColor>Press Esc, Enter, or ? to close</Text>
          </Box>
        </Box>
      </Modal>
    );
  }

  return (
    <Modal x={x} y={y} width={boxWidth} height={boxHeight}>
      <Box borderStyle="round" borderColor="cyan" flexDirection="column" width={boxWidth}>
        <Box justifyContent="center" marginBottom={1}>
          <Text bold color="cyan">
            {' '}
            Keyboard Shortcuts{' '}
          </Text>
        </Box>

        {hotkeyGroups.map((group) => renderGroup(group, columnWidth))}

        <Box marginTop={1} justifyContent="center">
          <Text dimColor>Press Esc, Enter, or ? to close</Text>
        </Box>
      </Box>
    </Modal>
  );
}
