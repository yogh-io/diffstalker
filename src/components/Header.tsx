import React from 'react';
import { Box, Text } from 'ink';
import { BranchInfo } from '../git/status.js';
import { shortenPath } from '../config.js';
import { WatcherState } from '../hooks/useWatcher.js';

/**
 * Calculate the header height based on whether content needs to wrap.
 * Returns 1 for single line, 2 if branch wraps to second line.
 */
export function getHeaderHeight(
  repoPath: string | null,
  branch: BranchInfo | null,
  watcherState: WatcherState | undefined,
  width: number,
  error: string | null = null,
  isLoading: boolean = false
): number {
  if (!repoPath) return 1;

  const displayPath = shortenPath(repoPath);
  const isNotGitRepo = error === 'Not a git repository';

  // Calculate branch width
  let branchWidth = 0;
  if (branch) {
    branchWidth = branch.current.length;
    if (branch.tracking) branchWidth += 3 + branch.tracking.length;
    if (branch.ahead > 0) branchWidth += 3 + String(branch.ahead).length;
    if (branch.behind > 0) branchWidth += 3 + String(branch.behind).length;
  }

  // Calculate left side width
  let leftWidth = displayPath.length;
  if (isLoading) leftWidth += 2;
  if (isNotGitRepo) leftWidth += 24;
  if (error && !isNotGitRepo) leftWidth += error.length + 3;

  // Check if follow indicator causes wrap
  if (watcherState?.enabled && watcherState.sourceFile) {
    const followPath = shortenPath(watcherState.sourceFile);
    const fullFollow = ` (follow: ${followPath})`;
    const availableOneLine = width - leftWidth - branchWidth - 4;

    if (fullFollow.length > availableOneLine) {
      // Would need to wrap
      const availableWithWrap = width - leftWidth - 2;
      if (fullFollow.length <= availableWithWrap) {
        return 2; // Branch wraps to second line
      }
    }
  }

  return 1;
}

interface HeaderProps {
  repoPath: string | null;
  branch: BranchInfo | null;
  isLoading: boolean;
  error: string | null;
  debug?: boolean;
  watcherState?: WatcherState;
  width?: number;
}

function BranchDisplay({ branch }: { branch: BranchInfo }): React.ReactElement {
  return (
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
  );
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

  // Calculate left side content width (without follow)
  let leftWidth = displayPath.length;
  if (isLoading) leftWidth += 2;
  if (isNotGitRepo) leftWidth += 24;
  if (error && !isNotGitRepo) leftWidth += error.length + 3;

  // Determine follow indicator display and layout
  let followText: string | null = null;
  let wrapBranch = false;

  if (watcherState?.enabled && watcherState.sourceFile) {
    const followPath = shortenPath(watcherState.sourceFile);
    const fullFollow = ` (follow: ${followPath})`;

    const availableOneLine = width - leftWidth - branchWidth - 4; // 4 for spacing

    if (fullFollow.length <= availableOneLine) {
      // Everything fits on one line
      followText = fullFollow;
    } else {
      // Need to wrap branch to second line
      const availableWithWrap = width - leftWidth - 2;
      if (fullFollow.length <= availableWithWrap) {
        followText = fullFollow;
        wrapBranch = true;
      }
      // If it doesn't fit, don't show follow at all
    }
  }

  return (
    <Box flexDirection="column">
      {wrapBranch ? (
        // Two-line layout: path + follow on first line, branch on second
        <>
          <Box>
            <Text bold color="cyan">{displayPath}</Text>
            {isLoading && <Text color="yellow"> ⟳</Text>}
            {isNotGitRepo && <Text color="yellow"> (not a git repository)</Text>}
            {error && !isNotGitRepo && <Text color="red"> ({error})</Text>}
            {followText && <Text dimColor>{followText}</Text>}
          </Box>
          {branch && <BranchDisplay branch={branch} />}
        </>
      ) : (
        // Single-line layout
        <Box justifyContent="space-between">
          <Box>
            <Text bold color="cyan">{displayPath}</Text>
            {isLoading && <Text color="yellow"> ⟳</Text>}
            {isNotGitRepo && <Text color="yellow"> (not a git repository)</Text>}
            {error && !isNotGitRepo && <Text color="red"> ({error})</Text>}
            {followText && <Text dimColor>{followText}</Text>}
          </Box>
          {branch && <BranchDisplay branch={branch} />}
        </Box>
      )}

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
