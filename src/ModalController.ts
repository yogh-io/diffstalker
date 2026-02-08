import type { Widgets } from 'blessed';
import type { UIState } from './state/UIState.js';
import type { GitStateManager } from './core/GitStateManager.js';
import type { ExplorerStateManager } from './core/ExplorerStateManager.js';
import type { FileEntry } from './git/status.js';
import type { ThemeName } from './themes.js';
import type { Modal } from './ui/modals/Modal.js';
import { ThemePicker } from './ui/modals/ThemePicker.js';
import { HotkeysModal } from './ui/modals/HotkeysModal.js';
import { BaseBranchPicker } from './ui/modals/BaseBranchPicker.js';
import { DiscardConfirm } from './ui/modals/DiscardConfirm.js';
import { FileFinder } from './ui/modals/FileFinder.js';
import { CommitActionConfirm } from './ui/modals/CommitActionConfirm.js';
import { RepoPicker } from './ui/modals/RepoPicker.js';
import { saveConfig } from './config.js';
import * as logger from './utils/logger.js';

export type ModalType =
  | 'theme'
  | 'hotkeys'
  | 'baseBranch'
  | 'discard'
  | 'fileFinder'
  | 'commitAction'
  | 'repoPicker';

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
 * Single source of truth for modal state.
 */
export class ModalController {
  private activeModal: Modal | null = null;
  private activeModalType: ModalType | null = null;

  constructor(private ctx: ModalContext) {}

  hasActiveModal(): boolean {
    return this.activeModal !== null;
  }

  getActiveModalType(): ModalType | null {
    return this.activeModalType;
  }

  closeActiveModal(): void {
    if (this.activeModal) {
      this.activeModal.destroy();
      this.activeModal = null;
      this.activeModalType = null;
      this.ctx.render();
    }
  }

  private clearModal(): void {
    this.activeModal = null;
    this.activeModalType = null;
  }

  openThemePicker(): void {
    this.activeModalType = 'theme';
    this.activeModal = new ThemePicker(
      this.ctx.screen,
      this.ctx.getCurrentTheme(),
      (theme) => {
        this.ctx.setCurrentTheme(theme);
        saveConfig({ theme });
        this.clearModal();
        this.ctx.render();
      },
      () => {
        this.clearModal();
      }
    );
    this.activeModal.focus();
  }

  openHotkeysModal(): void {
    this.activeModalType = 'hotkeys';
    this.activeModal = new HotkeysModal(this.ctx.screen, () => {
      this.clearModal();
    });
    this.activeModal.focus();
  }

  openBaseBranchPicker(): void {
    const gm = this.ctx.getGitManager();
    if (!gm) return;

    this.activeModalType = 'baseBranch';
    gm.compare
      .getCandidateBaseBranches()
      .then((branches) => {
        const currentBranch = gm.compare.compareState.compareBaseBranch ?? null;
        const modal = new BaseBranchPicker(
          this.ctx.screen,
          branches,
          currentBranch,
          (branch) => {
            this.clearModal();
            const includeUncommitted = this.ctx.uiState.state.includeUncommitted;
            gm.compare.setCompareBaseBranch(branch, includeUncommitted);
          },
          () => {
            this.clearModal();
          }
        );
        this.activeModal = modal;
        modal.focus();
      })
      .catch((err) => {
        this.clearModal();
        logger.error('Failed to load base branches', err);
      });
  }

  openDiscardConfirm(file: FileEntry): void {
    this.activeModalType = 'discard';
    this.activeModal = new DiscardConfirm(
      this.ctx.screen,
      file.path,
      async () => {
        this.clearModal();
        await this.ctx.getGitManager()?.workingTree.discard(file);
      },
      () => {
        this.clearModal();
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

    this.activeModalType = 'fileFinder';
    this.activeModal = new FileFinder(
      this.ctx.screen,
      allPaths,
      async (selectedPath) => {
        this.clearModal();
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
        this.clearModal();
        this.ctx.render();
      }
    );
    this.activeModal.focus();
  }

  openCherryPickConfirm(): void {
    const commit = this.ctx.getGitManager()?.history.historyState.selectedCommit;
    if (!commit) return;

    this.activeModalType = 'commitAction';
    this.activeModal = new CommitActionConfirm(
      this.ctx.screen,
      'Cherry-pick',
      commit,
      () => {
        this.clearModal();
        this.ctx.getGitManager()?.remote.cherryPick(commit.hash);
      },
      () => {
        this.clearModal();
      }
    );
    this.activeModal.focus();
  }

  openRevertConfirm(): void {
    const commit = this.ctx.getGitManager()?.history.historyState.selectedCommit;
    if (!commit) return;

    this.activeModalType = 'commitAction';
    this.activeModal = new CommitActionConfirm(
      this.ctx.screen,
      'Revert',
      commit,
      () => {
        this.clearModal();
        this.ctx.getGitManager()?.remote.revertCommit(commit.hash);
      },
      () => {
        this.clearModal();
      }
    );
    this.activeModal.focus();
  }

  openRepoPicker(): void {
    const repos = this.ctx.getRecentRepos();
    const currentRepo = this.ctx.getRepoPath();
    this.activeModalType = 'repoPicker';
    this.activeModal = new RepoPicker(
      this.ctx.screen,
      repos,
      currentRepo,
      (selected) => {
        this.clearModal();
        this.ctx.onRepoSwitch(selected);
      },
      () => {
        this.clearModal();
        this.ctx.render();
      }
    );
    this.activeModal.focus();
  }
}
