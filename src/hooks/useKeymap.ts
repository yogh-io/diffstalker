import { useInput } from 'ink';

export type Pane = 'files' | 'diff' | 'commit' | 'history' | 'compare' | 'explorer';
export type BottomTab = 'diff' | 'commit' | 'history' | 'compare' | 'explorer';

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
  onToggleIncludeUncommitted?: () => void;
  onCycleBaseBranch?: () => void;
  onOpenThemePicker?: () => void;
  onShrinkTopPane?: () => void;
  onGrowTopPane?: () => void;
  onOpenHotkeysModal?: () => void;
  onToggleMouse?: () => void;
  onToggleFollow?: () => void;
  onToggleAutoTab?: () => void;
  onToggleWrap?: () => void;
  onToggleMiddleDots?: () => void;
  onToggleHideHiddenFiles?: () => void;
  onToggleHideGitignored?: () => void;
  onExplorerEnter?: () => void;
  onExplorerBack?: () => void;
}

export function useKeymap(
  actions: KeymapActions,
  currentPane: Pane,
  isCommitInputActive: boolean
): void {
  useInput((input, key) => {
    // Don't handle keys when commit input is active - let CommitPanel handle them
    if (isCommitInputActive) {
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

    // Tab switching: 1/2/3
    if (input === '1') {
      actions.onSwitchTab('diff');
      return;
    }
    if (input === '2') {
      actions.onSwitchTab('commit');
      return;
    }
    if (input === '3') {
      actions.onSwitchTab('history');
      return;
    }
    if (input === '4') {
      actions.onSwitchTab('compare');
      return;
    }
    if (input === '5') {
      actions.onSwitchTab('explorer');
      return;
    }

    // Toggle include uncommitted in compare view: u
    if (input === 'u' && actions.onToggleIncludeUncommitted) {
      actions.onToggleIncludeUncommitted();
      return;
    }

    // Cycle base branch in compare view: b
    if (input === 'b' && actions.onCycleBaseBranch) {
      actions.onCycleBaseBranch();
      return;
    }

    // Open theme picker: t
    if (input === 't' && actions.onOpenThemePicker) {
      actions.onOpenThemePicker();
      return;
    }

    // Open hotkeys modal: ?
    if (input === '?' && actions.onOpenHotkeysModal) {
      actions.onOpenHotkeysModal();
      return;
    }

    // Shrink top pane: [
    if (input === '[' && actions.onShrinkTopPane) {
      actions.onShrinkTopPane();
      return;
    }

    // Grow top pane: ]
    if (input === ']' && actions.onGrowTopPane) {
      actions.onGrowTopPane();
      return;
    }

    // Toggle mouse mode: m
    if (input === 'm' && actions.onToggleMouse) {
      actions.onToggleMouse();
      return;
    }

    // Toggle follow mode: f
    if (input === 'f' && actions.onToggleFollow) {
      actions.onToggleFollow();
      return;
    }

    // Toggle auto-tab mode: a
    if (input === 'a' && actions.onToggleAutoTab) {
      actions.onToggleAutoTab();
      return;
    }

    // Toggle wrap mode: w
    if (input === 'w' && actions.onToggleWrap) {
      actions.onToggleWrap();
      return;
    }

    // Toggle middle-dots (indentation visualization): .
    if (input === '.' && actions.onToggleMiddleDots) {
      actions.onToggleMiddleDots();
      return;
    }

    // Toggle hide hidden files: Ctrl+H
    if (key.ctrl && input === 'h' && actions.onToggleHideHiddenFiles) {
      actions.onToggleHideHiddenFiles();
      return;
    }

    // Toggle hide gitignored files: Ctrl+G
    if (key.ctrl && input === 'g' && actions.onToggleHideGitignored) {
      actions.onToggleHideGitignored();
      return;
    }

    // Stage: s, Ctrl+S, or Enter/Space on file
    if (input === 's' || (key.ctrl && input === 's')) {
      actions.onStage();
      return;
    }

    // Unstage: Shift+U (uppercase U)
    if (input === 'U') {
      actions.onUnstage();
      return;
    }

    // Stage all: Shift+A (uppercase A)
    if (input === 'A') {
      actions.onStageAll();
      return;
    }

    // Unstage all: Shift+Z (uppercase Z)
    if (input === 'Z') {
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

    // Explorer: Enter to enter directory, Backspace/h to go up
    if (actions.onExplorerEnter && key.return) {
      actions.onExplorerEnter();
      return;
    }
    if (actions.onExplorerBack && (key.backspace || key.delete || input === 'h')) {
      actions.onExplorerBack();
      return;
    }

    // Enter/Space to toggle stage/unstage for selected file
    if (key.return || input === ' ') {
      actions.onSelect();
      return;
    }
  });
}
