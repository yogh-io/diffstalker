import React from 'react';
import { Box, Text } from 'ink';

interface FooterProps {
  activeTab: 'diff' | 'commit' | 'history' | 'pr';
  mouseEnabled?: boolean;
}

export function Footer({ activeTab, mouseEnabled = true }: FooterProps): React.ReactElement {
  return (
    <Box justifyContent="space-between">
      <Text>
        <Text dimColor>?</Text> hotkeys
        <Text dimColor> | </Text>
        <Text dimColor>[{mouseEnabled ? 'scroll mode' : 'select mode'}]</Text>
      </Text>

      <Text>
        <Text color={activeTab === 'diff' ? 'cyan' : undefined} bold={activeTab === 'diff'}>
          [1]Diff
        </Text>
        {' '}
        <Text color={activeTab === 'commit' ? 'cyan' : undefined} bold={activeTab === 'commit'}>
          [2]Commit
        </Text>
        {' '}
        <Text color={activeTab === 'history' ? 'cyan' : undefined} bold={activeTab === 'history'}>
          [3]History
        </Text>
        {' '}
        <Text color={activeTab === 'pr' ? 'cyan' : undefined} bold={activeTab === 'pr'}>
          [4]PR
        </Text>
      </Text>
    </Box>
  );
}
