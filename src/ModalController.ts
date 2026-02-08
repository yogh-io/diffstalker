import type { Widgets } from 'blessed';
import type { UIState } from './state/UIState.js';
import type { GitStateManager } from './core/GitStateManager.js';
import type { ExplorerStateManager } from './core/ExplorerStateManager.js';
import type { FileEntry } from './git/status.js';
import type { ThemeName } from './themes.js';
import { ThemePicker } from './ui/modals/ThemePicker.js';
import { HotkeysModal } from './ui/modals/HotkeysModal.js';
import { BaseBranchPicker } from './ui/modals/BaseBranchPicker.js';
import { DiscardConfirm } from './ui/modals/DiscardConfirm.js';
import { FileFinder } from './ui/modals/FileFinder.js';
import { CommitActionConfirm } from './ui/modals/CommitActionConfirm.js';
import { RepoPicker } from './ui/modals/RepoPicker.js';
import { saveConfig } from './config.js';
import * as logger from './utils/logger.js';

/**
 * Read-only context provided by App for modal management.
 */
export interface ModalContext {
  screen: Widgets.Screen;
  uiState: UIState;
  getGitManager(): GitStateManager | null;
  getExplorerManager(): ExplorerStateManager | null;
  getTopPaneHeight(): number;
  getCurrentTheme(): ThemeName;
  setCurrentTheme(theme: ThemeName): void;
  getRepoPath(): string;
  getRecentRepos(): string[];
  onRepoSwitch(repoPath: string): void;
  render(): void;
}

/**
 * Manages all modal dialogs: creation, focus, and dismissal.
 * Owns the activeModal state.
 */
export class ModalController {
  private activeModal:
    | ThemePicker
    | HotkeysModal
    | BaseBranchPicker
    | DiscardConfirm
    | FileFinder
    | CommitActionConfirm
    | RepoPicker
    | null = null;

  constructor(private ctx: ModalContext) {}

  hasActiveModal(): boolean {
    return this.activeModal !== null;
  }

  /**
   * Handle modal open/close triggered by UIState modal-change events.
   */
  handleModalChange(modal: string | null): void {
    if (this.activeModal) {
      this.activeModal = null;
    }

    if (modal === 'theme') {
      this.activeModal = new ThemePicker(
        this.ctx.screen,
        this.ctx.getCurrentTheme(),
        (theme) => {
          this.ctx.setCurrentTheme(theme);
          saveConfig({ theme });
          this.activeModal = null;
          this.ctx.uiState.closeModal();
          this.ctx.render();
        },
        () => {
          this.activeModal = null;
          this.ctx.uiState.closeModal();
        }
      );
      this.activeModal.focus();
    } else if (modal === 'hotkeys') {
      this.activeModal = new HotkeysModal(this.ctx.screen, () => {
        this.activeModal = null;
        // Delay UIState cleanup so the screen-level ? handler still sees
        // the modal as active and won't immediately re-open it
        setImmediate(() => this.ctx.uiState.closeModal());
      });
      this.activeModal.focus();
    } else if (modal === 'baseBranch') {
      const gm = this.ctx.getGitManager();
      gm?.compare
        .getCandidateBaseBranches()
        .then((branches) => {
          const currentBranch = gm?.compare.compareState.compareBaseBranch ?? null;
          this.activeModal = new BaseBranchPicker(
            this.ctx.screen,
            branches,
            currentBranch,
            (branch) => {
              this.activeModal = null;
              this.ctx.uiState.closeModal();
              const includeUncommitted = this.ctx.uiState.state.includeUncommitted;
              gm?.compare.setCompareBaseBranch(branch, includeUncommitted);
            },
            () => {
              this.activeModal = null;
              this.ctx.uiState.closeModal();
            }
          );
          this.activeModal.focus();
        })
        .catch((err) => logger.error('Failed to load base branches', err));
    }
  }

  showDiscardConfirm(file: FileEntry): void {
    this.activeModal = new DiscardConfirm(
      this.ctx.screen,
      file.path,
      async () => {
        this.activeModal = null;
        await this.ctx.getGitManager()?.workingTree.discard(file);
      },
      () => {
        this.activeModal = null;
      }
    );
    this.activeModal.focus();
  }

  async openFileFinder(): Promise<void> {
    const explorer = this.ctx.getExplorerManager();
    let allPaths = explorer?.getCachedFilePaths() ?? [];
    if (allPaths.length === 0) {
      await explorer?.loadFilePaths();
      allPaths = explorer?.getCachedFilePaths() ?? [];
    }
    if (allPaths.length === 0) return;

    this.activeModal = new FileFinder(
      this.ctx.screen,
      allPaths,
      async (selectedPath) => {
        this.activeModal = null;
        if (this.ctx.uiState.state.bottomTab !== 'explorer') {
          this.ctx.uiState.setTab('explorer');
        }
        const success = await explorer?.navigateToPath(selectedPath);
        if (success) {
          const selectedIndex = explorer?.state.selectedIndex ?? 0;
          this.ctx.uiState.setExplorerSelectedIndex(selectedIndex);
          this.ctx.uiState.setExplorerFileScrollOffset(0);
          const visibleHeight = this.ctx.getTopPaneHeight();
          if (selectedIndex >= visibleHeight) {
            this.ctx.uiState.setExplorerScrollOffset(selectedIndex - Math.floor(visibleHeight / 2));
          } else {
            this.ctx.uiState.setExplorerScrollOffset(0);
          }
        }
        this.ctx.render();
      },
      () => {
        this.activeModal = null;
        this.ctx.render();
      }
    );
    this.activeModal.focus();
  }

  cherryPickSelected(): void {
    const commit = this.ctx.getGitManager()?.history.historyState.selectedCommit;
    if (!commit) return;

    this.activeModal = new CommitActionConfirm(
      this.ctx.screen,
      'Cherry-pick',
      commit,
      () => {
        this.activeModal = null;
        this.ctx.getGitManager()?.remote.cherryPick(commit.hash);
      },
      () => {
        this.activeModal = null;
      }
    );
    this.activeModal.focus();
  }

  revertSelected(): void {
    const commit = this.ctx.getGitManager()?.history.historyState.selectedCommit;
    if (!commit) return;

    this.activeModal = new CommitActionConfirm(
      this.ctx.screen,
      'Revert',
      commit,
      () => {
        this.activeModal = null;
        this.ctx.getGitManager()?.remote.revertCommit(commit.hash);
      },
      () => {
        this.activeModal = null;
      }
    );
    this.activeModal.focus();
  }

  openRepoPicker(): void {
    const repos = this.ctx.getRecentRepos();
    const currentRepo = this.ctx.getRepoPath();
    this.activeModal = new RepoPicker(
      this.ctx.screen,
      repos,
      currentRepo,
      (selected) => {
        this.activeModal = null;
        this.ctx.onRepoSwitch(selected);
      },
      () => {
        this.activeModal = null;
        this.ctx.render();
      }
    );
    this.activeModal.focus();
  }
}
