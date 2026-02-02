import type { BranchInfo } from '../../git/status.js';
import type { RemoteOperationState } from '../../types/remote.js';
import { abbreviateHomePath } from '../../config.js';

/**
 * Calculate header height based on content.
 * Currently always returns 1 (single line header).
 */
export function getHeaderHeight(): number {
  return 1;
}

/**
 * Format branch info as blessed-compatible tagged string.
 */
function formatBranch(branch: BranchInfo): string {
  let result = `{bold}{green-fg}${branch.current}{/green-fg}{/bold}`;

  if (branch.tracking) {
    result += ` {gray-fg}\u2192{/gray-fg} {blue-fg}${branch.tracking}{/blue-fg}`;
  }

  if (branch.ahead > 0) {
    result += ` {green-fg}\u2191${branch.ahead}{/green-fg}`;
  }

  if (branch.behind > 0) {
    result += ` {red-fg}\u2193${branch.behind}{/red-fg}`;
  }

  return result;
}

function computeBranchVisibleLength(branch: BranchInfo): number {
  let len = branch.current.length;
  if (branch.tracking) {
    len += 3 + branch.tracking.length;
  }
  if (branch.ahead > 0) {
    len += 3 + String(branch.ahead).length;
  }
  if (branch.behind > 0) {
    len += 3 + String(branch.behind).length;
  }
  return len;
}

/**
 * Format header content as blessed-compatible tagged string.
 */
export function formatHeader(
  repoPath: string | null,
  branch: BranchInfo | null,
  isLoading: boolean,
  error: string | null,
  width: number,
  remoteState?: RemoteOperationState | null
): string {
  if (!repoPath) {
    return '{gray-fg}Waiting for target path...{/gray-fg}';
  }

  const displayPath = abbreviateHomePath(repoPath);
  const isNotGitRepo = error === 'Not a git repository';

  // Build left side content
  let leftContent = `{bold}{cyan-fg}${displayPath}{/cyan-fg}{/bold}`;

  if (isLoading) {
    leftContent += ' {yellow-fg}\u27f3{/yellow-fg}';
  }

  if (isNotGitRepo) {
    leftContent += ' {yellow-fg}(not a git repository){/yellow-fg}';
  } else if (error) {
    leftContent += ` {red-fg}(${error}){/red-fg}`;
  }

  // Remote operation status (shown after left content)
  let remoteStatus = '';
  let remoteStatusLen = 0;
  if (remoteState) {
    if (remoteState.inProgress && remoteState.operation) {
      const labels: Record<string, string> = {
        push: 'pushing...',
        fetch: 'fetching...',
        pull: 'rebasing...',
        stash: 'stashing...',
        stashPop: 'popping stash...',
        branchSwitch: 'switching branch...',
        branchCreate: 'creating branch...',
        softReset: 'resetting...',
        cherryPick: 'cherry-picking...',
        revert: 'reverting...',
      };
      const label = labels[remoteState.operation] ?? '';
      remoteStatus = ` {yellow-fg}${label}{/yellow-fg}`;
      remoteStatusLen = 1 + label.length;
    } else if (remoteState.error) {
      const brief =
        remoteState.error.length > 40
          ? remoteState.error.slice(0, 40) + '\u2026'
          : remoteState.error;
      remoteStatus = ` {red-fg}${brief}{/red-fg}`;
      remoteStatusLen = 1 + brief.length;
    } else if (remoteState.lastResult) {
      remoteStatus = ` {green-fg}${remoteState.lastResult}{/green-fg}`;
      remoteStatusLen = 1 + remoteState.lastResult.length;
    }
  }

  // Build right side content (branch info)
  const rightContent = branch ? formatBranch(branch) : '';

  if (rightContent) {
    // Calculate visible text length for left side (excluding ANSI/tags)
    let leftLen = displayPath.length;
    if (isLoading) leftLen += 2; // " ⟳"
    if (isNotGitRepo) {
      leftLen += 24; // " (not a git repository)"
    } else if (error) {
      leftLen += error.length + 3; // " (error)"
    }
    leftLen += remoteStatusLen;

    const rightLen = branch ? computeBranchVisibleLength(branch) : 0;

    const padding = Math.max(1, width - leftLen - rightLen - 2);
    return leftContent + remoteStatus + ' '.repeat(padding) + rightContent;
  }

  return leftContent + remoteStatus;
}
