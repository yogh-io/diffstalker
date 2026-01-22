import React from 'react';
import { Box, Text } from 'ink';

interface FooterProps {
  activeTab: 'diff' | 'commit' | 'history' | 'compare' | 'explorer';
  mouseEnabled?: boolean;
  autoTabEnabled?: boolean;
  wrapMode?: boolean;
  showMiddleDots?: boolean;
}

export function Footer({
  activeTab,
  mouseEnabled = true,
  autoTabEnabled = false,
  wrapMode = false,
  showMiddleDots = false,
}: FooterProps): React.ReactElement {
  // Layout: "? [scroll] [auto] [wrap] [dots]" with spaces between
  return (
    <Box justifyContent="space-between">
      <Text>
        <Text dimColor>?</Text>{' '}
        <Text color="yellow">{mouseEnabled ? '[scroll]' : 'm:[select]'}</Text>{' '}
        <Text color={autoTabEnabled ? 'blue' : undefined} dimColor={!autoTabEnabled}>
          [auto]
        </Text>{' '}
        <Text color={wrapMode ? 'blue' : undefined} dimColor={!wrapMode}>
          [wrap]
        </Text>
        {activeTab === 'explorer' && (
          <>
            {' '}
            <Text color={showMiddleDots ? 'blue' : undefined} dimColor={!showMiddleDots}>
              [dots]
            </Text>
          </>
        )}
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
