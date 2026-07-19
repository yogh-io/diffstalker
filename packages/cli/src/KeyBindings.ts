import type { Widgets } from 'blessed';
import type { BottomTab } from './types/tabs.js';
import type { UIState, FocusZone } from './state/UIState.js';
import type { FileEntry } from '@diffstalker/core/git/status';
import type { ModalType } from './ModalController.js';
import { SPLIT_RATIO_STEP } from './ui/Layout.js';

/**
 * Actions that keyboard bindings can trigger.
 * App implements this interface and passes itself.
 */
export interface KeyBindingActions {
  exit(): void;
  navigateDown(): void;
  navigateUp(): void;
  navigatePageDown(): void;
  navigatePageUp(): void;
  jumpToTop(): void;
  jumpToBottom(): void;
  stageSelected(): void;
  unstageSelected(): void;
  stageAll(): void;
  unstageAll(): void;
  toggleSelected(): void;
  enterExplorerDirectory(): void;
  goExplorerUp(): void;
  openFileFinder(): void;
  focusCommitInput(): void;
  unfocusCommitInput(): void;
  openRepoPicker(): void;
  openWorktreeSwitcher(): void;
  openThemePicker(): void;
  openHotkeysModal(): void;
  openBaseBranchPicker(): void;
  closeActiveModal(): void;
  toggleMouseMode(): void;
  toggleFollow(): void;
  openDiscardConfirm(file: FileEntry): void;
  render(): void;
  toggleCurrentHunk(): void;
  navigateNextHunk(): void;
  navigatePrevHunk(): void;
  openCherryPickConfirm(): void;
  openRevertConfirm(): void;
}

/**
 * Read-only context needed by keyboard handlers to make decisions.
 */
export interface KeyBindingContext {
  hasActiveModal(): boolean;
  getActiveModalType(): ModalType | null;
  getBottomTab(): BottomTab;
  getCurrentPane(): string;
  getFocusedZone(): FocusZone;
  isCommitInputFocused(): boolean;
  getStatusFiles(): FileEntry[];
  getSelectedIndex(): number;
  uiState: UIState;
  getExplorerManager(): { toggleShowOnlyChanges(): Promise<void> } | null;
  commitFlowState: { toggleAmend(): void };
  getGitManager(): { compare: { refreshCompareDiff(includeUncommitted: boolean): void } } | null;
  layout: { setSplitRatio(ratio: number): void };
  resolveFileAtIndex(index: number): FileEntry | null;
}

/**
 * Register all keyboard bindings on the blessed screen.
 */
export function setupKeyBindings(
  screen: Widgets.Screen,
  actions: KeyBindingActions,
  ctx: KeyBindingContext
): void {
  // Quit: q closes modal if open, Ctrl+C always exits
  screen.key(['q'], () => {
    if (ctx.hasActiveModal()) {
      actions.closeActiveModal();
      return;
    }
    actions.exit();
  });

  screen.key(['C-c'], () => {
    actions.exit();
  });

  // Navigation (skip if modal is open)
  screen.key(['j', 'down'], () => {
    if (ctx.hasActiveModal()) return;
    actions.navigateDown();
  });

  screen.key(['k', 'up'], () => {
    if (ctx.hasActiveModal()) return;
    actions.navigateUp();
  });

  // Page scrolling (skip if modal is open)
  screen.key(['pagedown', 'C-d'], () => {
    if (ctx.hasActiveModal()) return;
    actions.navigatePageDown();
  });

  screen.key(['pageup', 'C-u'], () => {
    if (ctx.hasActiveModal()) return;
    actions.navigatePageUp();
  });

  // Jump to bottom (g is bound below; on the explorer tab it stays the filter toggle)
  screen.key(['S-g'], () => {
    if (ctx.hasActiveModal()) return;
    actions.jumpToBottom();
  });

  // Tab switching (skip if modal is open)
  const tabs: [string, BottomTab][] = [
    ['1', 'diff'],
    ['2', 'commit'],
    ['3', 'history'],
    ['4', 'compare'],
    ['5', 'explorer'],
  ];
  for (const [key, tab] of tabs) {
    screen.key([key], () => {
      if (ctx.hasActiveModal()) return;
      ctx.uiState.setTab(tab);
    });
  }

  // Focus zone cycling (skip if modal or commit input is active)
  screen.key(['tab'], () => {
    if (ctx.hasActiveModal() || ctx.isCommitInputFocused()) return;
    ctx.uiState.advanceFocus();
  });

  screen.key(['S-tab'], () => {
    if (ctx.hasActiveModal() || ctx.isCommitInputFocused()) return;
    ctx.uiState.retreatFocus();
  });

  // Staging operations (skip if modal is open)
  // Context-aware: hunk staging when diff pane is focused on diff tab
  screen.key(['s'], () => {
    if (ctx.hasActiveModal()) return;
    if (ctx.getBottomTab() === 'diff' && ctx.getCurrentPane() === 'diff') {
      actions.toggleCurrentHunk();
    } else {
      actions.stageSelected();
    }
  });
  screen.key(['S-u'], () => {
    if (ctx.hasActiveModal()) return;
    actions.unstageSelected();
  });
  screen.key(['S-a'], () => {
    if (ctx.hasActiveModal()) return;
    actions.stageAll();
  });
  screen.key(['S-z'], () => {
    if (ctx.hasActiveModal()) return;
    actions.unstageAll();
  });

  // Select/toggle (skip if modal is open)
  screen.key(['enter', 'space'], () => {
    if (ctx.hasActiveModal()) return;
    const zone = ctx.getFocusedZone();
    // Zone-aware dispatch for commit panel elements
    if (zone === 'commitMessage' && !ctx.isCommitInputFocused()) {
      actions.focusCommitInput();
      return;
    }
    if (zone === 'commitAmend') {
      ctx.commitFlowState.toggleAmend();
      actions.render();
      return;
    }
    if (ctx.getBottomTab() === 'explorer' && ctx.getCurrentPane() === 'explorer') {
      actions.enterExplorerDirectory();
    } else {
      actions.toggleSelected();
    }
  });

  // Explorer: go up directory (skip if modal is open)
  screen.key(['backspace'], () => {
    if (ctx.hasActiveModal()) return;
    if (ctx.getBottomTab() === 'explorer' && ctx.getCurrentPane() === 'explorer') {
      actions.goExplorerUp();
    }
  });

  // g: explorer keeps its show-only-changes filter toggle; elsewhere jump to top
  screen.key(['g'], () => {
    if (ctx.hasActiveModal()) return;
    if (ctx.getBottomTab() === 'explorer') {
      ctx.getExplorerManager()?.toggleShowOnlyChanges();
    } else {
      actions.jumpToTop();
    }
  });

  // Explorer: open file finder
  screen.key(['/'], () => {
    if (ctx.hasActiveModal()) return;
    if (ctx.getBottomTab() === 'explorer') {
      actions.openFileFinder();
    }
  });

  // Ctrl+P: open file finder from any tab
  screen.key(['C-p'], () => {
    if (ctx.hasActiveModal()) return;
    actions.openFileFinder();
  });

  // Commit (skip if modal is open)
  screen.key(['c'], () => {
    if (ctx.hasActiveModal()) return;
    ctx.uiState.setTab('commit');
  });

  // Commit panel specific keys (only when on commit tab)
  screen.key(['i'], () => {
    if (ctx.getBottomTab() === 'commit' && !ctx.isCommitInputFocused()) {
      actions.focusCommitInput();
    }
  });

  screen.key(['a'], () => {
    if (ctx.hasActiveModal()) return;
    if (ctx.getBottomTab() === 'commit' && !ctx.isCommitInputFocused()) {
      ctx.commitFlowState.toggleAmend();
      actions.render();
    } else {
      ctx.uiState.toggleAutoTab();
    }
  });

  // Ctrl+a: toggle amend on commit tab (works even when input is focused)
  screen.key(['C-a'], () => {
    if (ctx.getBottomTab() === 'commit') {
      ctx.commitFlowState.toggleAmend();
      actions.render();
    }
  });

  // Escape: close modal first, then commit-tab escape logic
  screen.key(['escape'], () => {
    if (ctx.hasActiveModal()) {
      actions.closeActiveModal();
      return;
    }
    if (ctx.getBottomTab() === 'commit') {
      if (ctx.isCommitInputFocused()) {
        actions.unfocusCommitInput();
      } else {
        ctx.uiState.setTab('diff');
      }
    }
  });

  // Repo picker (toggle)
  screen.key(['r'], () => {
    if (ctx.getActiveModalType() === 'repoPicker') {
      actions.closeActiveModal();
      return;
    }
    if (ctx.hasActiveModal()) return;
    actions.openRepoPicker();
  });

  // Worktree switcher (toggle)
  screen.key(['S-w'], () => {
    if (ctx.getActiveModalType() === 'worktreePicker') {
      actions.closeActiveModal();
      return;
    }
    if (ctx.hasActiveModal()) return;
    actions.openWorktreeSwitcher();
  });

  // Display toggles (guarded)
  screen.key(['w'], () => {
    if (ctx.hasActiveModal()) return;
    ctx.uiState.toggleWrapMode();
  });
  screen.key(['m'], () => {
    if (ctx.hasActiveModal()) return;
    actions.toggleMouseMode();
  });
  screen.key(['S-t'], () => {
    if (ctx.hasActiveModal()) return;
    ctx.uiState.toggleAutoTab();
  });

  // Split ratio adjustments
  screen.key(['-', '_', '['], () => {
    ctx.uiState.adjustSplitRatio(-SPLIT_RATIO_STEP);
    ctx.layout.setSplitRatio(ctx.uiState.state.splitRatio);
    actions.render();
  });

  screen.key(['=', '+', ']'], () => {
    ctx.uiState.adjustSplitRatio(SPLIT_RATIO_STEP);
    ctx.layout.setSplitRatio(ctx.uiState.state.splitRatio);
    actions.render();
  });

  // Theme picker (toggle)
  screen.key(['t'], () => {
    if (ctx.getActiveModalType() === 'theme') {
      actions.closeActiveModal();
      return;
    }
    if (ctx.hasActiveModal()) return;
    actions.openThemePicker();
  });

  // Hotkeys modal (toggle)
  screen.key(['?'], () => {
    if (ctx.getActiveModalType() === 'hotkeys') {
      actions.closeActiveModal();
      return;
    }
    if (ctx.hasActiveModal()) return;
    actions.openHotkeysModal();
  });

  // Follow toggle (guarded)
  screen.key(['f'], () => {
    if (ctx.hasActiveModal()) return;
    actions.toggleFollow();
  });

  // Compare view: base branch picker (toggle)
  screen.key(['b'], () => {
    if (ctx.getActiveModalType() === 'baseBranch') {
      actions.closeActiveModal();
      return;
    }
    if (ctx.hasActiveModal()) return;
    if (ctx.getBottomTab() === 'compare') {
      actions.openBaseBranchPicker();
    }
  });

  // u: toggle uncommitted in compare view
  screen.key(['u'], () => {
    if (ctx.hasActiveModal()) return;
    if (ctx.getBottomTab() === 'compare') {
      ctx.uiState.toggleIncludeUncommitted();
      const includeUncommitted = ctx.uiState.state.includeUncommitted;
      ctx.getGitManager()?.compare.refreshCompareDiff(includeUncommitted);
    }
  });

  // Toggle flat file view (diff/commit tab only)
  screen.key(['h'], () => {
    if (ctx.hasActiveModal()) return;
    const tab = ctx.getBottomTab();
    if (tab === 'diff' || tab === 'commit') {
      ctx.uiState.toggleFlatViewMode();
    }
  });

  // Discard changes / delete untracked file (with confirmation, guarded)
  screen.key(['d'], () => {
    if (ctx.hasActiveModal()) return;
    if (ctx.getBottomTab() === 'diff') {
      const file = ctx.resolveFileAtIndex(ctx.getSelectedIndex());
      if (file && !file.staged) {
        actions.openDiscardConfirm(file);
      }
    }
  });

  // Hunk navigation (only when diff pane focused on diff tab)
  screen.key(['n'], () => {
    if (ctx.hasActiveModal()) return;
    if (ctx.getBottomTab() === 'diff' && ctx.getCurrentPane() === 'diff') {
      actions.navigateNextHunk();
    }
  });

  screen.key(['S-n'], () => {
    if (ctx.hasActiveModal()) return;
    if (ctx.getBottomTab() === 'diff' && ctx.getCurrentPane() === 'diff') {
      actions.navigatePrevHunk();
    }
  });

  // Cherry-pick selected commit (history tab only)
  screen.key(['p'], () => {
    if (ctx.hasActiveModal() || ctx.isCommitInputFocused()) return;
    if (ctx.getBottomTab() === 'history') {
      actions.openCherryPickConfirm();
    }
  });

  // Revert selected commit (history tab only)
  screen.key(['v'], () => {
    if (ctx.hasActiveModal() || ctx.isCommitInputFocused()) return;
    if (ctx.getBottomTab() === 'history') {
      actions.openRevertConfirm();
    }
  });
}
