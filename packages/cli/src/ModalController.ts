import type { Widgets } from 'blessed';
import type { UIState } from './state/UIState.js';
import type { RepoSession } from './daemon/RepoSession.js';
import type { ExplorerViewModel } from './state/ExplorerViewModel.js';
import type { FileEntry } from '@diffstalker/core/git/status';
import type { ThemeName } from './themes.js';
import type { Modal } from './ui/modals/Modal.js';
import { ThemePicker } from './ui/modals/ThemePicker.js';
import { HotkeysModal } from './ui/modals/HotkeysModal.js';
import { BaseBranchPicker } from './ui/modals/BaseBranchPicker.js';
import { DiscardConfirm } from './ui/modals/DiscardConfirm.js';
import { FileFinder } from './ui/modals/FileFinder.js';
import { CommitActionConfirm } from './ui/modals/CommitActionConfirm.js';
import { RepoPicker } from './ui/modals/RepoPicker.js';
import { WorktreePicker } from './ui/modals/WorktreePicker.js';
import type { WorktreeInfo } from '@diffstalker/core/git/worktree';
import { saveConfig } from './config.js';
import * as logger from '@diffstalker/core/utils/logger';

export type ModalType =
  | 'theme'
  | 'hotkeys'
  | 'baseBranch'
  | 'discard'
  | 'fileFinder'
  | 'commitAction'
  | 'repoPicker'
  | 'worktreePicker';

/**
 * Read-only context provided by App for modal management.
 */
export interface ModalContext {
  screen: Widgets.Screen;
  uiState: UIState;
  getSession(): RepoSession | null;
  getExplorerManager(): ExplorerViewModel | null;
  getTopPaneHeight(): number;
  getCurrentTheme(): ThemeName;
  setCurrentTheme(theme: ThemeName): void;
  getRepoPath(): string;
  getRecentRepos(): string[];
  onRepoSwitch(repoPath: string): void;
  /** Quit the app. Needed because a focused modal can swallow Ctrl+C. */
  exit(): void;
  render(): void;
}

/**
 * Manages all modal dialogs: creation, focus, and dismissal.
 * Single source of truth for modal state.
 */
export class ModalController {
  private activeModal: Modal | null = null;
  private activeModalType: ModalType | null = null;
  /**
   * A modal that has to fetch before it can be constructed holds the slot
   * while it waits. Without this, hammering the trigger key on a slow
   * daemon builds one widget per press and leaks all but the last.
   */
  private opening = false;

  constructor(private ctx: ModalContext) {}

  hasActiveModal(): boolean {
    return this.activeModal !== null || this.opening;
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
    const session = this.ctx.getSession();
    if (!session) return;

    this.activeModalType = 'baseBranch';
    session
      .getCandidateBaseBranches()
      .then((branches) => {
        const currentBranch = session.compare.baseBranch ?? null;
        const modal = new BaseBranchPicker(
          this.ctx.screen,
          branches,
          currentBranch,
          (branch) => {
            this.clearModal();
            const includeUncommitted = this.ctx.uiState.state.includeUncommitted;
            session.setCompareBaseBranch(branch, includeUncommitted);
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
      file.status === 'untracked',
      async () => {
        this.clearModal();
        await this.ctx.getSession()?.discard(file);
      },
      () => {
        this.clearModal();
      }
    );
    this.activeModal.focus();
  }

  async openFileFinder(): Promise<void> {
    if (this.hasActiveModal()) return;

    const explorer = this.ctx.getExplorerManager();
    let allPaths: string[];
    // Claim the slot across the await — see `opening`.
    this.opening = true;
    try {
      allPaths = (await explorer?.getFilePaths()) ?? [];
    } finally {
      this.opening = false;
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
      },
      () => {
        this.clearModal();
        this.ctx.exit();
      }
    );
    this.activeModal.focus();
  }

  openCherryPickConfirm(): void {
    const commit = this.ctx.getSession()?.history.selectedCommit;
    if (!commit) return;

    this.activeModalType = 'commitAction';
    this.activeModal = new CommitActionConfirm(
      this.ctx.screen,
      'Cherry-pick',
      commit,
      () => {
        this.clearModal();
        this.ctx.getSession()?.cherryPick(commit.hash);
      },
      () => {
        this.clearModal();
      }
    );
    this.activeModal.focus();
  }

  openRevertConfirm(): void {
    const commit = this.ctx.getSession()?.history.selectedCommit;
    if (!commit) return;

    this.activeModalType = 'commitAction';
    this.activeModal = new CommitActionConfirm(
      this.ctx.screen,
      'Revert',
      commit,
      () => {
        this.clearModal();
        this.ctx.getSession()?.revertCommit(commit.hash);
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

  openWorktreePicker(worktrees: WorktreeInfo[], currentPath: string): void {
    this.activeModalType = 'worktreePicker';
    this.activeModal = new WorktreePicker(
      this.ctx.screen,
      worktrees,
      currentPath,
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
