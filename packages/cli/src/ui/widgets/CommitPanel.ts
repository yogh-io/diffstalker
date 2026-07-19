import type { CommitFlowStateData } from '../../state/CommitFlowState.js';
import type { FocusZone } from '../../state/UIState.js';

/**
 * Rows inside the message input box. The blessed textarea App overlays on
 * the drawn box must use the same height.
 */
export const COMMIT_INPUT_HEIGHT = 4;

export interface CommitPanelOptions {
  state: CommitFlowStateData;
  stagedCount: number;
  width: number;
  focusedZone?: FocusZone;
}

/**
 * Build all lines for the commit panel (used for both rendering and totalRows).
 */
export function buildCommitPanelLines(opts: CommitPanelOptions): string[] {
  const { state, stagedCount, width, focusedZone } = opts;
  const lines: string[] = [];

  // Title
  let title = '{bold}Commit Message{/bold}';
  if (state.amend) {
    title += ' {yellow-fg}(amending){/yellow-fg}';
  }
  lines.push(title);
  lines.push('');

  // Message input area - cyan when zone-focused or input-focused
  const messageFocused = state.inputFocused || focusedZone === 'commitMessage';
  const borderColor = messageFocused ? 'cyan' : 'gray';

  // Top border
  const innerWidth = Math.max(20, width - 6);
  lines.push(`{${borderColor}-fg}\u250c${'─'.repeat(innerWidth + 2)}\u2510{/${borderColor}-fg}`);

  // Message content rows (or placeholder on the first row). While the input
  // is focused, the blessed textarea overlays this area and renders itself.
  const messageLines = state.message ? state.message.split('\n') : [];
  if (messageLines.length === 0 && !state.inputFocused) {
    messageLines.push('Press i or Enter to edit...');
  }
  const messageColor = state.message ? '' : '{gray-fg}';
  const messageEnd = state.message ? '' : '{/gray-fg}';

  for (let row = 0; row < COMMIT_INPUT_HEIGHT; row++) {
    let content = messageLines[row] ?? '';
    // Mark overflow beyond the visible rows on the last one
    if (row === COMMIT_INPUT_HEIGHT - 1 && messageLines.length > COMMIT_INPUT_HEIGHT) {
      content += ' \u2026';
    }
    const truncated =
      content.length > innerWidth
        ? content.slice(0, innerWidth - 1) + '\u2026'
        : content.padEnd(innerWidth);
    lines.push(
      `{${borderColor}-fg}\u2502{/${borderColor}-fg} ${messageColor}${truncated}${messageEnd} {${borderColor}-fg}\u2502{/${borderColor}-fg}`
    );
  }

  // Bottom border
  lines.push(`{${borderColor}-fg}\u2514${'─'.repeat(innerWidth + 2)}\u2518{/${borderColor}-fg}`);

  lines.push('');

  // Amend checkbox - cyan marker when zone-focused
  const amendFocused = focusedZone === 'commitAmend';
  const checkbox = state.amend ? '[x]' : '[ ]';
  let checkboxColor = 'gray';
  if (amendFocused) checkboxColor = 'cyan';
  else if (state.amend) checkboxColor = 'green';
  const amendPrefix = amendFocused ? '{cyan-fg}\u25b8 {/cyan-fg}' : '  ';
  lines.push(
    `${amendPrefix}{${checkboxColor}-fg}${checkbox}{/${checkboxColor}-fg} Amend {gray-fg}(a){/gray-fg}`
  );

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

  // Help text - context-sensitive based on focused zone
  let helpText: string;
  if (state.inputFocused) {
    helpText = 'Ctrl+s: commit | Enter: newline | Ctrl+a: amend | Esc: unfocus';
  } else if (focusedZone === 'commitMessage') {
    helpText = 'Tab: next | Space: edit | a: amend';
  } else if (focusedZone === 'commitAmend') {
    helpText = 'Tab: next | Space: toggle | Esc: back';
  } else {
    helpText = 'i/Enter: edit | a: amend | Esc: back';
  }
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
  visibleHeight?: number,
  focusedZone?: FocusZone
): string {
  const allLines = buildCommitPanelLines({
    state,
    stagedCount,
    width,
    focusedZone,
  });

  if (visibleHeight && allLines.length > visibleHeight) {
    return allLines.slice(scrollOffset, scrollOffset + visibleHeight).join('\n');
  }

  return allLines.join('\n');
}
