import type { CommitFlowStateData } from '../../state/CommitFlowState.js';
import type { BranchInfo, StashEntry, CommitInfo } from '../../git/status.js';
import type { RemoteOperationState } from '../../types/remote.js';

export interface CommitPanelOptions {
  state: CommitFlowStateData;
  stagedCount: number;
  width: number;
  branch?: BranchInfo | null;
  remoteState?: RemoteOperationState | null;
  stashList?: StashEntry[];
  headCommit?: CommitInfo | null;
}

/**
 * Build all lines for the commit panel (used for both rendering and totalRows).
 */
export function buildCommitPanelLines(opts: CommitPanelOptions): string[] {
  const { state, stagedCount, width, branch, remoteState, stashList, headCommit } = opts;
  const lines: string[] = [];

  // Title
  let title = '{bold}Commit Message{/bold}';
  if (state.amend) {
    title += ' {yellow-fg}(amending){/yellow-fg}';
  }
  lines.push(title);
  lines.push('');

  // Message input area
  const borderColor = state.inputFocused ? 'cyan' : 'gray';

  // Top border
  const innerWidth = Math.max(20, width - 6);
  lines.push(`{${borderColor}-fg}\u250c${'─'.repeat(innerWidth + 2)}\u2510{/${borderColor}-fg}`);

  // Message content (or placeholder)
  const displayMessage = state.message || (state.inputFocused ? '' : 'Press i or Enter to edit...');
  const messageColor = state.message ? '' : '{gray-fg}';
  const messageEnd = state.message ? '' : '{/gray-fg}';

  // Truncate message if needed
  const truncatedMessage =
    displayMessage.length > innerWidth
      ? displayMessage.slice(0, innerWidth - 1) + '\u2026'
      : displayMessage.padEnd(innerWidth);

  lines.push(
    `{${borderColor}-fg}\u2502{/${borderColor}-fg} ${messageColor}${truncatedMessage}${messageEnd} {${borderColor}-fg}\u2502{/${borderColor}-fg}`
  );

  // Bottom border
  lines.push(`{${borderColor}-fg}\u2514${'─'.repeat(innerWidth + 2)}\u2518{/${borderColor}-fg}`);

  lines.push('');

  // Amend checkbox
  const checkbox = state.amend ? '[x]' : '[ ]';
  const checkboxColor = state.amend ? 'green' : 'gray';
  lines.push(`{${checkboxColor}-fg}${checkbox}{/${checkboxColor}-fg} Amend {gray-fg}(a){/gray-fg}`);

  // Error message
  if (state.error) {
    lines.push('');
    lines.push(`{red-fg}${state.error}{/red-fg}`);
  }

  // Committing status
  if (state.isCommitting) {
    lines.push('');
    lines.push('{yellow-fg}Committing...{/yellow-fg}');
  }

  lines.push('');

  // Help text
  const helpText = state.inputFocused
    ? 'Enter: commit | Ctrl+a: amend | Esc: unfocus'
    : 'i/Enter: edit | a: amend | Esc: back';
  lines.push(`{gray-fg}Staged: ${stagedCount} file(s) | ${helpText}{/gray-fg}`);

  // Stash section
  const stashEntries = stashList ?? [];
  lines.push('');
  lines.push(`{gray-fg}${'─'.repeat(3)} Stash (${stashEntries.length}) ${'─'.repeat(3)}{/gray-fg}`);
  if (stashEntries.length > 0) {
    const maxShow = 5;
    for (let i = 0; i < Math.min(stashEntries.length, maxShow); i++) {
      const entry = stashEntries[i];
      const msg =
        entry.message.length > width - 10
          ? entry.message.slice(0, width - 13) + '\u2026'
          : entry.message;
      lines.push(`{gray-fg}{${i}}{/gray-fg}: ${msg}`);
    }
    if (stashEntries.length > maxShow) {
      lines.push(`{gray-fg}... ${stashEntries.length - maxShow} more{/gray-fg}`);
    }
  } else {
    lines.push('{gray-fg}(empty){/gray-fg}');
  }
  lines.push('{gray-fg}S: save | o: pop | l: list{/gray-fg}');

  // Branch section
  if (branch) {
    lines.push('');
    lines.push(`{gray-fg}${'─'.repeat(3)} Branch ${'─'.repeat(3)}{/gray-fg}`);

    let branchLine = `{bold}* ${branch.current}{/bold}`;
    if (branch.tracking) {
      branchLine += ` {gray-fg}\u2192{/gray-fg} ${branch.tracking}`;
    }
    lines.push(branchLine);
    lines.push('{gray-fg}b: switch/create{/gray-fg}');
  }

  // Undo section
  lines.push('');
  lines.push(`{gray-fg}${'─'.repeat(3)} Undo ${'─'.repeat(3)}{/gray-fg}`);
  if (headCommit) {
    lines.push(
      `{gray-fg}HEAD: {yellow-fg}${headCommit.shortHash}{/yellow-fg} ${headCommit.message}{/gray-fg}`
    );
  }
  lines.push('{gray-fg}X: soft reset HEAD~1{/gray-fg}');

  // Remote section
  if (branch) {
    lines.push('');
    lines.push(`{gray-fg}${'─'.repeat(3)} Remote ${'─'.repeat(3)}{/gray-fg}`);

    // Tracking info
    if (branch.tracking) {
      let tracking = `${branch.current} {gray-fg}\u2192{/gray-fg} ${branch.tracking}`;
      if (branch.ahead > 0) tracking += ` {green-fg}\u2191${branch.ahead}{/green-fg}`;
      if (branch.behind > 0) tracking += ` {red-fg}\u2193${branch.behind}{/red-fg}`;
      lines.push(tracking);
    } else {
      lines.push(`{gray-fg}${branch.current} (no remote tracking){/gray-fg}`);
    }

    // Remote status
    if (remoteState?.inProgress && remoteState.operation) {
      const labels: Record<string, string> = {
        push: 'Pushing...',
        fetch: 'Fetching...',
        pull: 'Rebasing...',
        stash: 'Stashing...',
        stashPop: 'Popping stash...',
        branchSwitch: 'Switching branch...',
        branchCreate: 'Creating branch...',
        softReset: 'Resetting...',
        cherryPick: 'Cherry-picking...',
        revert: 'Reverting...',
      };
      lines.push(`{yellow-fg}${labels[remoteState.operation] ?? ''}{/yellow-fg}`);
    } else if (remoteState?.error) {
      const brief =
        remoteState.error.length > 50
          ? remoteState.error.slice(0, 50) + '\u2026'
          : remoteState.error;
      lines.push(`{red-fg}${brief}{/red-fg}`);
    } else if (remoteState?.lastResult) {
      lines.push(`{green-fg}${remoteState.lastResult}{/green-fg}`);
    }

    lines.push('{gray-fg}P: push | F: fetch | R: pull --rebase{/gray-fg}');
  }

  return lines;
}

/**
 * Get total row count for the commit panel (for scroll calculations).
 */
export function getCommitPanelTotalRows(opts: CommitPanelOptions): number {
  return buildCommitPanelLines(opts).length;
}

/**
 * Format the commit panel as blessed-compatible tagged string.
 */
export function formatCommitPanel(
  state: CommitFlowStateData,
  stagedCount: number,
  width: number,
  branch?: BranchInfo | null,
  remoteState?: RemoteOperationState | null,
  stashList?: StashEntry[],
  headCommit?: CommitInfo | null,
  scrollOffset: number = 0,
  visibleHeight?: number
): string {
  const allLines = buildCommitPanelLines({
    state,
    stagedCount,
    width,
    branch,
    remoteState,
    stashList,
    headCommit,
  });

  if (visibleHeight && allLines.length > visibleHeight) {
    return allLines.slice(scrollOffset, scrollOffset + visibleHeight).join('\n');
  }

  return allLines.join('\n');
}

/**
 * Format inactive commit panel.
 */
export function formatCommitPanelInactive(): string {
  return "{gray-fg}Press '2' or 'c' to open commit panel{/gray-fg}";
}
