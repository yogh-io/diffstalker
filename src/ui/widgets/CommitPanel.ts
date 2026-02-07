import type { CommitFlowStateData } from '../../state/CommitFlowState.js';

export interface CommitPanelOptions {
  state: CommitFlowStateData;
  stagedCount: number;
  width: number;
}

/**
 * Build all lines for the commit panel (used for both rendering and totalRows).
 */
export function buildCommitPanelLines(opts: CommitPanelOptions): string[] {
  const { state, stagedCount, width } = opts;
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
  scrollOffset: number = 0,
  visibleHeight?: number
): string {
  const allLines = buildCommitPanelLines({
    state,
    stagedCount,
    width,
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
