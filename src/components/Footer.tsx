import React from 'react';
import { Box, Text } from 'ink';

interface FooterProps {
  activeTab: 'diff' | 'commit' | 'history' | 'pr';
}

export function Footer({ activeTab }: FooterProps): React.ReactElement {
  return (
    <Box justifyContent="space-between">
      <Text>
        <Text dimColor>^S</Text> stage{' '}
        <Text dimColor>^U</Text> unstage{' '}
        <Text dimColor>^A</Text> stage all{' '}
        <Text dimColor>rclick</Text> discard{' '}
        <Text dimColor>c</Text> commit{' '}
        {activeTab === 'pr' && (
          <>
            <Text dimColor>u</Text> uncommitted{' '}
          </>
        )}
        <Text dimColor>q</Text> quit
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
