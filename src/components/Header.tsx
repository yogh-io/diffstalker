import React from 'react';
import { Box, Text } from 'ink';
import { BranchInfo } from '../git/status.js';
import { shortenPath } from '../config.js';

interface HeaderProps {
  repoPath: string | null;
  branch: BranchInfo | null;
  isLoading: boolean;
  error: string | null;
}

export function Header({ repoPath, branch, isLoading, error }: HeaderProps): React.ReactElement {
  if (!repoPath) {
    return (
      <Box>
        <Text dimColor>Waiting for target path...</Text>
        <Text dimColor> (write path to ~/.cache/diffstalker/target)</Text>
      </Box>
    );
  }

  const displayPath = shortenPath(repoPath);
  const isNotGitRepo = error === 'Not a git repository';

  return (
    <Box justifyContent="space-between">
      <Box>
        <Text bold color="cyan">{displayPath}</Text>
        {isLoading && <Text color="yellow"> ⟳</Text>}
        {isNotGitRepo && <Text color="yellow"> (not a git repository)</Text>}
        {error && !isNotGitRepo && <Text color="red"> ({error})</Text>}
      </Box>

      {branch && (
        <Box>
          <Text color="green" bold>{branch.current}</Text>
          {branch.tracking && (
            <>
              <Text dimColor> → </Text>
              <Text color="blue">{branch.tracking}</Text>
            </>
          )}
          {(branch.ahead > 0 || branch.behind > 0) && (
            <Text>
              {branch.ahead > 0 && <Text color="green"> ↑{branch.ahead}</Text>}
              {branch.behind > 0 && <Text color="red"> ↓{branch.behind}</Text>}
            </Text>
          )}
        </Box>
      )}
    </Box>
  );
}
