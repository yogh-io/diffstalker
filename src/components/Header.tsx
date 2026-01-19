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
  width?: number;
}

export function Header({ repoPath, branch, isLoading, error, debug, watcherState, width = 80 }: HeaderProps): React.ReactElement {
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

  // Calculate branch info width for layout
  let branchWidth = 0;
  if (branch) {
    branchWidth = branch.current.length;
    if (branch.tracking) {
      branchWidth += 3 + branch.tracking.length; // " → tracking"
    }
    if (branch.ahead > 0) branchWidth += 3 + String(branch.ahead).length;
    if (branch.behind > 0) branchWidth += 3 + String(branch.behind).length;
  }

  // Calculate left side content width
  let leftWidth = displayPath.length;
  if (isLoading) leftWidth += 2;
  if (isNotGitRepo) leftWidth += 24;
  if (error && !isNotGitRepo) leftWidth += error.length + 3;

  // Determine follow indicator display
  let followText: string | null = null;
  if (watcherState?.enabled && watcherState.sourceFile) {
    const availableForFollow = width - leftWidth - branchWidth - 4; // 4 for spacing
    if (availableForFollow >= 10) { // " (follow)" = 9 chars
      const followPath = shortenPath(watcherState.sourceFile);
      const fullFollow = ` (follow: ${followPath})`;
      if (fullFollow.length <= availableForFollow) {
        followText = fullFollow;
      } else if (availableForFollow >= 9) {
        followText = ' (follow)';
      }
    }
  }

  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between">
        <Box>
          <Text bold color="cyan">{displayPath}</Text>
          {isLoading && <Text color="yellow"> ⟳</Text>}
          {isNotGitRepo && <Text color="yellow"> (not a git repository)</Text>}
          {error && !isNotGitRepo && <Text color="red"> ({error})</Text>}
          {followText && <Text dimColor>{followText}</Text>}
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
