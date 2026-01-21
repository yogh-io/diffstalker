import React from 'react';
import { Box, Text } from 'ink';

interface FooterProps {
  activeTab: 'diff' | 'commit' | 'history' | 'compare';
  mouseEnabled?: boolean;
  autoTabEnabled?: boolean;
}

export function Footer({
  activeTab,
  mouseEnabled = true,
  autoTabEnabled = false,
}: FooterProps): React.ReactElement {
  return (
    <Box justifyContent="space-between">
      <Text>
        <Text dimColor>?</Text> hotkeys
        <Text dimColor> | </Text>
        <Text color="yellow">[{mouseEnabled ? 'scroll' : 'select'}]</Text>
        <Text dimColor> | </Text>
        <Text color={autoTabEnabled ? 'blue' : undefined} dimColor={!autoTabEnabled}>
          [auto-tab:{autoTabEnabled ? 'on' : 'off'}]
        </Text>
      </Text>

      <Text>
        <Text color={activeTab === 'diff' ? 'cyan' : undefined} bold={activeTab === 'diff'}>
          [1]Diff
        </Text>{' '}
        <Text color={activeTab === 'commit' ? 'cyan' : undefined} bold={activeTab === 'commit'}>
          [2]Commit
        </Text>{' '}
        <Text color={activeTab === 'history' ? 'cyan' : undefined} bold={activeTab === 'history'}>
          [3]History
        </Text>{' '}
        <Text color={activeTab === 'compare' ? 'cyan' : undefined} bold={activeTab === 'compare'}>
          [4]Compare
        </Text>
      </Text>
    </Box>
  );
}
