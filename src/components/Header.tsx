import React from 'react';
import { Box, Text } from 'ink';
import { BranchInfo } from '../git/status.js';
import { shortenPath } from '../config.js';
import { WatcherState } from '../hooks/useWatcher.js';

interface HeaderProps {
  repoPath: string | null;
  branch: BranchInfo | null;
  isLoading: boolean;
  error: string | null;
  debug?: boolean;
  watcherState?: WatcherState;
}

export function Header({ repoPath, branch, isLoading, error, debug, watcherState }: HeaderProps): React.ReactElement {
  if (!repoPath) {
    return (
      <Box flexDirection="column">
        <Box>
          <Text dimColor>Waiting for target path...</Text>
          <Text dimColor> (write path to ~/.cache/diffstalker/target)</Text>
        </Box>
        {debug && watcherState && watcherState.enabled && watcherState.sourceFile && (
          <Box>
            <Text dimColor>[debug] source: {shortenPath(watcherState.sourceFile)}</Text>
            {watcherState.rawContent && (
              <Text dimColor> | raw: "{watcherState.rawContent}"</Text>
            )}
          </Box>
        )}
      </Box>
    );
  }

  const displayPath = shortenPath(repoPath);
  const isNotGitRepo = error === 'Not a git repository';

  const formatTime = (date: Date | null): string => {
    if (!date) return '';
    return date.toLocaleTimeString();
  };

  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between">
        <Box>
          <Text bold color="cyan">{displayPath}</Text>
          {isLoading && <Text color="yellow"> ⟳</Text>}
          {isNotGitRepo && <Text color="yellow"> (not a git repository)</Text>}
          {error && !isNotGitRepo && <Text color="red"> ({error})</Text>}
          {watcherState?.enabled && watcherState.sourceFile && (
            <Text dimColor> (follow: {shortenPath(watcherState.sourceFile)})</Text>
          )}
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

      {debug && watcherState && watcherState.enabled && watcherState.sourceFile && (
        <Box>
          <Text dimColor>[debug] source: {shortenPath(watcherState.sourceFile)}</Text>
          <Text dimColor> | raw: "{watcherState.rawContent}"</Text>
          {watcherState.lastUpdate && (
            <Text dimColor> | updated: {formatTime(watcherState.lastUpdate)}</Text>
          )}
        </Box>
      )}
    </Box>
  );
}
