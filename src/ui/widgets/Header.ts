import type { BranchInfo } from '../../git/status.js';
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

/**
 * Format header content as blessed-compatible tagged string.
 */
export function formatHeader(
  repoPath: string | null,
  branch: BranchInfo | null,
  isLoading: boolean,
  error: string | null,
  width: number
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

    const rightLen = branch
      ? branch.current.length +
        (branch.tracking ? 3 + branch.tracking.length : 0) +
        (branch.ahead > 0 ? 3 + String(branch.ahead).length : 0) +
        (branch.behind > 0 ? 3 + String(branch.behind).length : 0)
      : 0;

    const padding = Math.max(1, width - leftLen - rightLen - 2);
    return leftContent + ' '.repeat(padding) + rightContent;
  }

  return leftContent;
}
