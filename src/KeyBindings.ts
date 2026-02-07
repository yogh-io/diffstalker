import type { Widgets } from 'blessed';
import type { BottomTab } from './types/tabs.js';
import type { UIState, FocusZone } from './state/UIState.js';
import type { FileEntry } from './git/status.js';
import { SPLIT_RATIO_STEP } from './ui/Layout.js';
import { getFileAtIndex } from './ui/widgets/FileList.js';
import type { FlatFileEntry } from './utils/flatFileList.js';
import { getFlatFileAtIndex } from './utils/flatFileList.js';

/**
 * Actions that keyboard bindings can trigger.
 * App implements this interface and passes itself.
 */
export interface KeyBindingActions {
  exit(): void;
  navigateDown(): void;
  navigateUp(): void;
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
  refresh(): void;
  toggleMouseMode(): void;
  toggleFollow(): void;
  showDiscardConfirm(file: FileEntry): void;
  render(): void;
  toggleCurrentHunk(): void;
  navigateNextHunk(): void;
  navigatePrevHunk(): void;
  cherryPickSelected(): void;
  revertSelected(): void;
}

/**
 * Read-only context needed by keyboard handlers to make decisions.
 */
export interface KeyBindingContext {
  hasActiveModal(): boolean;
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
  getCachedFlatFiles(): FlatFileEntry[];
}

/**
 * Register all keyboard bindings on the blessed screen.
 */
export function setupKeyBindings(
  screen: Widgets.Screen,
  actions: KeyBindingActions,
  ctx: KeyBindingContext
): void {
  // Quit
  screen.key(['q', 'C-c'], () => {
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

  // Explorer: toggle show only changes filter
  screen.key(['g'], () => {
    if (ctx.hasActiveModal()) return;
    if (ctx.getBottomTab() === 'explorer') {
      ctx.getExplorerManager()?.toggleShowOnlyChanges();
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

  screen.key(['escape'], () => {
    if (ctx.getBottomTab() === 'commit') {
      if (ctx.isCommitInputFocused()) {
        actions.unfocusCommitInput();
      } else {
        ctx.uiState.setTab('diff');
      }
    }
  });

  // Refresh
  screen.key(['r'], () => actions.refresh());

  // Display toggles
  screen.key(['w'], () => ctx.uiState.toggleWrapMode());
  screen.key(['m'], () => actions.toggleMouseMode());
  screen.key(['S-t'], () => ctx.uiState.toggleAutoTab());

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

  // Theme picker
  screen.key(['t'], () => ctx.uiState.openModal('theme'));

  // Hotkeys modal (only opens; closing is handled by the modal's own key handler)
  screen.key(['?'], () => {
    if (ctx.hasActiveModal()) return;
    ctx.uiState.openModal('hotkeys');
  });

  // Follow toggle
  screen.key(['f'], () => actions.toggleFollow());

  // Compare view: base branch picker
  screen.key(['b'], () => {
    if (ctx.hasActiveModal() || ctx.isCommitInputFocused()) return;
    if (ctx.getBottomTab() === 'compare') {
      ctx.uiState.openModal('baseBranch');
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

  // Discard changes (with confirmation)
  screen.key(['d'], () => {
    if (ctx.getBottomTab() === 'diff') {
      if (ctx.uiState.state.flatViewMode) {
        const flatEntry = getFlatFileAtIndex(ctx.getCachedFlatFiles(), ctx.getSelectedIndex());
        if (flatEntry?.unstagedEntry) {
          const file = flatEntry.unstagedEntry;
          if (file.status !== 'untracked') {
            actions.showDiscardConfirm(file);
          }
        }
      } else {
        const files = ctx.getStatusFiles();
        const selectedFile = getFileAtIndex(files, ctx.getSelectedIndex());
        // Only allow discard for unstaged modified files
        if (selectedFile && !selectedFile.staged && selectedFile.status !== 'untracked') {
          actions.showDiscardConfirm(selectedFile);
        }
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
      actions.cherryPickSelected();
    }
  });

  // Revert selected commit (history tab only)
  screen.key(['v'], () => {
    if (ctx.hasActiveModal() || ctx.isCommitInputFocused()) return;
    if (ctx.getBottomTab() === 'history') {
      actions.revertSelected();
    }
  });
}
