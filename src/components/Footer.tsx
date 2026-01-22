import React from 'react';
import { Box, Text } from 'ink';

interface FooterProps {
  activeTab: 'diff' | 'commit' | 'history' | 'compare' | 'explorer';
  mouseEnabled?: boolean;
  autoTabEnabled?: boolean;
  wrapMode?: boolean;
}

export function Footer({
  activeTab,
  mouseEnabled = true,
  autoTabEnabled = false,
  wrapMode = false,
}: FooterProps): React.ReactElement {
  // Layout: "? [scroll] [auto] [wrap]" with spaces between
  // Positions (1-indexed): ? at 1, [scroll]/[select] at 3-10, [auto] at 12-17, [wrap] at 19-24
  return (
    <Box justifyContent="space-between">
      <Text>
        <Text dimColor>?</Text> <Text color="yellow">[{mouseEnabled ? 'scroll' : 'select'}]</Text>{' '}
        <Text color={autoTabEnabled ? 'blue' : undefined} dimColor={!autoTabEnabled}>
          [auto]
        </Text>{' '}
        <Text color={wrapMode ? 'blue' : undefined} dimColor={!wrapMode}>
          [wrap]
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
        </Text>{' '}
        <Text color={activeTab === 'explorer' ? 'cyan' : undefined} bold={activeTab === 'explorer'}>
          [5]Explorer
        </Text>
      </Text>
    </Box>
  );
}
