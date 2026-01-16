import { useInput } from 'ink';

export type Pane = 'files' | 'diff' | 'commit';
export type BottomTab = 'diff' | 'commit';

export interface KeymapActions {
  onStage: () => void;
  onUnstage: () => void;
  onStageAll: () => void;
  onUnstageAll: () => void;
  onCommit: () => void;
  onQuit: () => void;
  onRefresh: () => void;
  onNavigateUp: () => void;
  onNavigateDown: () => void;
  onTogglePane: () => void;
  onSwitchTab: (tab: BottomTab) => void;
  onSelect: () => void;
}

export function useKeymap(
  actions: KeymapActions,
  currentPane: Pane,
  isCommitInputActive: boolean
): void {
  useInput((input, key) => {
    // Don't handle keys when commit input is active (except Escape and Ctrl+C)
    if (isCommitInputActive) {
      if (key.escape) {
        actions.onSwitchTab('diff');
      }
      return;
    }

    // Quit: Ctrl+C or q
    if (key.ctrl && input === 'c') {
      actions.onQuit();
      return;
    }
    if (input === 'q') {
      actions.onQuit();
      return;
    }

    // Navigation (these can stay simple - j/k or arrows)
    if (input === 'j' || key.downArrow) {
      actions.onNavigateDown();
      return;
    }
    if (input === 'k' || key.upArrow) {
      actions.onNavigateUp();
      return;
    }

    // Pane switching: Tab
    if (key.tab) {
      actions.onTogglePane();
      return;
    }

    // Tab switching: 1/2
    if (input === '1') {
      actions.onSwitchTab('diff');
      return;
    }
    if (input === '2') {
      actions.onSwitchTab('commit');
      return;
    }

    // Stage: Ctrl+S or Enter/Space on file
    if (key.ctrl && input === 's') {
      actions.onStage();
      return;
    }

    // Unstage: Ctrl+U
    if (key.ctrl && input === 'u') {
      actions.onUnstage();
      return;
    }

    // Stage all: Ctrl+A
    if (key.ctrl && input === 'a') {
      actions.onStageAll();
      return;
    }

    // Unstage all: Ctrl+Shift+A (detected as Ctrl+A with shift, but terminal might not support)
    // Use Ctrl+Z as alternative for unstage all
    if (key.ctrl && input === 'z') {
      actions.onUnstageAll();
      return;
    }

    // Commit: Ctrl+Enter (c as fallback since Ctrl+Enter is hard in terminals)
    if (input === 'c') {
      actions.onCommit();
      return;
    }

    // Refresh: Ctrl+R or r
    if (key.ctrl && input === 'r') {
      actions.onRefresh();
      return;
    }
    if (input === 'r') {
      actions.onRefresh();
      return;
    }

    // Enter/Space to toggle stage/unstage for selected file
    if (key.return || input === ' ') {
      actions.onSelect();
      return;
    }
  });
}
