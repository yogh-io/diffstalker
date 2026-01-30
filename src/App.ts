import blessed from 'neo-blessed';
import type { Widgets } from 'blessed';
import { LayoutManager } from './ui/Layout.js';
import { setupKeyBindings } from './KeyBindings.js';
import { renderTopPane, renderBottomPane } from './ui/PaneRenderers.js';
import { setupMouseHandlers } from './MouseHandlers.js';
import { FollowMode, FollowModeWatcherState } from './FollowMode.js';
import { formatHeader } from './ui/widgets/Header.js';

import { formatFooter } from './ui/widgets/Footer.js';
import { getFileAtIndex, getRowFromFileIndex } from './ui/widgets/FileList.js';
import { getCommitAtIndex } from './ui/widgets/HistoryView.js';
import {
  getNextCompareSelection,
  getRowFromCompareSelection,
  type CompareListSelection,
} from './ui/widgets/CompareListView.js';
import {
  ExplorerStateManager,
  ExplorerOptions,
  GitStatusMap,
} from './core/ExplorerStateManager.js';
import { ThemePicker } from './ui/modals/ThemePicker.js';
import { HotkeysModal } from './ui/modals/HotkeysModal.js';
import { BaseBranchPicker } from './ui/modals/BaseBranchPicker.js';
import { DiscardConfirm } from './ui/modals/DiscardConfirm.js';
import { FileFinder } from './ui/modals/FileFinder.js';
import { CommitFlowState } from './state/CommitFlowState.js';
import { UIState } from './state/UIState.js';
import {
  GitStateManager,
  getManagerForRepo,
  removeManagerForRepo,
} from './core/GitStateManager.js';
import { Config, saveConfig } from './config.js';
import type { FileEntry } from './git/status.js';
import {
  getCategoryForIndex,
  getIndexForCategoryPosition,
  type CategoryName,
} from './utils/fileCategories.js';
import type { CommandServer, CommandHandler, AppState } from './ipc/CommandServer.js';
import type { BottomTab } from './types/tabs.js';
import type { ThemeName } from './themes.js';

export interface AppOptions {
  config: Config;
  initialPath?: string;
  commandServer?: CommandServer | null;
}

/**
 * Main application controller.
 * Coordinates between GitStateManager, UIState, and blessed widgets.
 */
export class App {
  private screen: Widgets.Screen;
  private layout: LayoutManager;
  private uiState: UIState;
  private gitManager: GitStateManager | null = null;
  private followMode: FollowMode | null = null;
  private explorerManager: ExplorerStateManager | null = null;
  private config: Config;
  private commandServer: CommandServer | null;

  // Current state
  private repoPath: string;
  private currentTheme: ThemeName;

  // Commit flow state
  private commitFlowState: CommitFlowState;
  private commitTextarea: Widgets.TextareaElement | null = null;

  // Active modals
  private activeModal:
    | ThemePicker
    | HotkeysModal
    | BaseBranchPicker
    | DiscardConfirm
    | FileFinder
    | null = null;

  // Cached total rows for scroll bounds (single source of truth from render)
  private bottomPaneTotalRows: number = 0;

  // Selection anchor: remembers category + position before stage/unstage
  private pendingSelectionAnchor: { category: CategoryName; categoryIndex: number } | null = null;

  constructor(options: AppOptions) {
    this.config = options.config;
    this.commandServer = options.commandServer ?? null;
    this.repoPath = options.initialPath ?? process.cwd();
    this.currentTheme = options.config.theme;

    // Initialize UI state with config values
    this.uiState = new UIState({
      splitRatio: options.config.splitRatio ?? 0.4,
    });

    // Create blessed screen
    this.screen = blessed.screen({
      smartCSR: true,
      fullUnicode: true,
      title: 'diffstalker',
      mouse: true,
      terminal: 'xterm-256color',
    });

    // Force 256-color support (terminfo detection can be unreliable)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const screenAny = this.screen as any;
    if (screenAny.tput) {
      screenAny.tput.colors = 256;
    }
    if (screenAny.program?.tput) {
      screenAny.program.tput.colors = 256;
    }

    // Create layout
    this.layout = new LayoutManager(this.screen, this.uiState.state.splitRatio);

    // Handle screen resize - re-render content
    // Use setImmediate to ensure screen dimensions are fully updated
    this.screen.on('resize', () => {
      setImmediate(() => this.render());
    });

    // Initialize commit flow state
    this.commitFlowState = new CommitFlowState({
      getHeadMessage: () => this.gitManager?.getHeadCommitMessage() ?? Promise.resolve(''),
      onCommit: async (message, amend) => {
        await this.gitManager?.commit(message, amend);
      },
      onSuccess: () => {
        this.uiState.setTab('diff');
        this.render();
      },
    });

    // Create commit textarea (hidden initially)
    this.commitTextarea = blessed.textarea({
      parent: this.layout.bottomPane,
      top: 3,
      left: 1,
      width: '100%-4',
      height: 1,
      inputOnFocus: true,
      hidden: true,
      style: {
        fg: 'white',
        bg: 'default',
      },
    });

    // Handle textarea submission
    this.commitTextarea.on('submit', () => {
      this.commitFlowState.submit();
    });

    // Sync textarea value with commit state
    this.commitTextarea.on('keypress', () => {
      // Defer to next tick to get updated value
      setImmediate(() => {
        const value = this.commitTextarea?.getValue() ?? '';
        this.commitFlowState.setMessage(value);
      });
    });

    // Setup keyboard handlers
    this.setupKeyboardHandlers();

    // Setup mouse handlers
    this.setupMouseEventHandlers();

    // Setup state change listeners
    this.setupStateListeners();

    // Setup follow mode if enabled
    if (this.config.watcherEnabled) {
      this.followMode = new FollowMode(this.config.targetFile, () => this.repoPath, {
        onRepoChange: (newPath, state) => this.handleFollowRepoChange(newPath, state),
        onFileNavigate: (rawContent) => this.handleFollowFileNavigate(rawContent),
      });
      this.followMode.start();
    }

    // Setup IPC command handler if command server provided
    if (this.commandServer) {
      this.setupCommandHandler();
    }

    // Initialize git manager for current repo
    this.initGitManager();

    // Initial render
    this.render();
  }

  private setupKeyboardHandlers(): void {
    setupKeyBindings(
      this.screen,
      {
        exit: () => this.exit(),
        navigateDown: () => this.navigateDown(),
        navigateUp: () => this.navigateUp(),
        stageSelected: () => this.stageSelected(),
        unstageSelected: () => this.unstageSelected(),
        stageAll: () => this.stageAll(),
        unstageAll: () => this.unstageAll(),
        toggleSelected: () => this.toggleSelected(),
        enterExplorerDirectory: () => this.enterExplorerDirectory(),
        goExplorerUp: () => this.goExplorerUp(),
        openFileFinder: () => this.openFileFinder(),
        focusCommitInput: () => this.focusCommitInput(),
        unfocusCommitInput: () => this.unfocusCommitInput(),
        refresh: () => this.refresh(),
        toggleMouseMode: () => this.toggleMouseMode(),
        toggleFollow: () => this.toggleFollow(),
        showDiscardConfirm: (file) => this.showDiscardConfirm(file),
        render: () => this.render(),
      },
      {
        hasActiveModal: () => this.activeModal !== null,
        getBottomTab: () => this.uiState.state.bottomTab,
        getCurrentPane: () => this.uiState.state.currentPane,
        isCommitInputFocused: () => this.commitFlowState.state.inputFocused,
        getStatusFiles: () => this.gitManager?.state.status?.files ?? [],
        getSelectedIndex: () => this.uiState.state.selectedIndex,
        uiState: this.uiState,
        explorerManager: this.explorerManager,
        commitFlowState: this.commitFlowState,
        gitManager: this.gitManager,
        layout: this.layout,
      }
    );
  }

  private setupMouseEventHandlers(): void {
    setupMouseHandlers(
      this.layout,
      {
        selectHistoryCommitByIndex: (index) => this.selectHistoryCommitByIndex(index),
        selectCompareItem: (selection) => this.selectCompareItem(selection),
        selectFileByIndex: (index) => this.selectFileByIndex(index),
        toggleFileByIndex: (index) => this.toggleFileByIndex(index),
        toggleMouseMode: () => this.toggleMouseMode(),
        toggleFollow: () => this.toggleFollow(),
        render: () => this.render(),
      },
      {
        uiState: this.uiState,
        explorerManager: this.explorerManager,
        getStatusFiles: () => this.gitManager?.state.status?.files ?? [],
        getHistoryCommitCount: () => this.gitManager?.historyState.commits.length ?? 0,
        getCompareCommits: () => this.gitManager?.compareState?.compareDiff?.commits ?? [],
        getCompareFiles: () => this.gitManager?.compareState?.compareDiff?.files ?? [],
        getBottomPaneTotalRows: () => this.bottomPaneTotalRows,
        getScreenWidth: () => (this.screen.width as number) || 80,
      }
    );
  }

  private async toggleFileByIndex(index: number): Promise<void> {
    const files = this.gitManager?.state.status?.files ?? [];
    const file = getFileAtIndex(files, index);
    if (file) {
      this.pendingSelectionAnchor = getCategoryForIndex(files, this.uiState.state.selectedIndex);
      if (file.staged) {
        await this.gitManager?.unstage(file);
      } else {
        await this.gitManager?.stage(file);
      }
    }
  }

  private setupStateListeners(): void {
    // Update footer when UI state changes
    this.uiState.on('change', () => {
      this.render();
    });

    // Load data when switching tabs
    this.uiState.on('tab-change', (tab) => {
      if (tab === 'history') {
        this.gitManager?.loadHistory();
      } else if (tab === 'compare') {
        this.gitManager?.refreshCompareDiff(this.uiState.state.includeUncommitted);
      } else if (tab === 'explorer') {
        // Explorer is already loaded on init, but refresh if needed
        if (!this.explorerManager?.state.displayRows.length) {
          this.explorerManager?.loadDirectory('');
        }
      }
    });

    // Handle modal opening/closing
    this.uiState.on('modal-change', (modal) => {
      // Close any existing modal
      if (this.activeModal) {
        this.activeModal = null;
      }

      // Open new modal if requested
      if (modal === 'theme') {
        this.activeModal = new ThemePicker(
          this.screen,
          this.currentTheme,
          (theme) => {
            this.currentTheme = theme;
            saveConfig({ theme });
            this.activeModal = null;
            this.uiState.closeModal();
            this.render();
          },
          () => {
            this.activeModal = null;
            this.uiState.closeModal();
          }
        );
        this.activeModal.focus();
      } else if (modal === 'hotkeys') {
        this.activeModal = new HotkeysModal(this.screen, () => {
          this.activeModal = null;
          this.uiState.closeModal();
        });
        this.activeModal.focus();
      } else if (modal === 'baseBranch') {
        // Load candidate branches and show picker
        this.gitManager?.getCandidateBaseBranches().then((branches) => {
          const currentBranch = this.gitManager?.compareState.compareBaseBranch ?? null;
          this.activeModal = new BaseBranchPicker(
            this.screen,
            branches,
            currentBranch,
            (branch) => {
              this.activeModal = null;
              this.uiState.closeModal();
              // Set base branch and refresh compare view
              const includeUncommitted = this.uiState.state.includeUncommitted;
              this.gitManager?.setCompareBaseBranch(branch, includeUncommitted);
            },
            () => {
              this.activeModal = null;
              this.uiState.closeModal();
            }
          );
          this.activeModal.focus();
        });
      }
    });

    // Save split ratio to config when it changes
    let saveTimer: ReturnType<typeof setTimeout> | null = null;
    this.uiState.on('change', (state) => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        if (state.splitRatio !== this.config.splitRatio) {
          saveConfig({ splitRatio: state.splitRatio });
        }
      }, 500);
    });
  }

  private handleFollowRepoChange(newPath: string, _state: FollowModeWatcherState): void {
    const oldRepoPath = this.repoPath;
    this.repoPath = newPath;
    this.initGitManager(oldRepoPath);
    this.resetRepoSpecificState();
    this.loadCurrentTabData();
    this.render();
  }

  private handleFollowFileNavigate(rawContent: string): void {
    this.navigateToFile(rawContent);
    this.render();
  }

  private initGitManager(oldRepoPath?: string): void {
    // Clean up existing manager
    if (this.gitManager) {
      this.gitManager.removeAllListeners();
      // Use oldRepoPath if provided (when switching repos), otherwise use current path
      removeManagerForRepo(oldRepoPath ?? this.repoPath);
    }

    // Get or create manager for this repo
    this.gitManager = getManagerForRepo(this.repoPath);

    // Listen to state changes
    this.gitManager.on('state-change', () => {
      const files = this.gitManager?.state.status?.files ?? [];

      if (this.pendingSelectionAnchor) {
        // Restore selection to same category + position after stage/unstage
        const anchor = this.pendingSelectionAnchor;
        this.pendingSelectionAnchor = null;
        const newIndex = getIndexForCategoryPosition(files, anchor.category, anchor.categoryIndex);
        this.uiState.setSelectedIndex(newIndex);
        this.selectFileByIndex(newIndex);
      } else if (files.length > 0) {
        // Default: clamp selected index to valid range
        const maxIndex = files.length - 1;
        if (this.uiState.state.selectedIndex > maxIndex) {
          this.uiState.setSelectedIndex(maxIndex);
        }
      }

      // Update explorer git status when git state changes
      this.updateExplorerGitStatus();
      this.render();
    });

    this.gitManager.on('history-state-change', (historyState) => {
      // Auto-select first commit when history loads
      if (historyState.commits.length > 0 && !historyState.selectedCommit) {
        const state = this.uiState.state;
        if (state.bottomTab === 'history') {
          this.selectHistoryCommitByIndex(state.historySelectedIndex);
        }
      }
      this.render();
    });

    this.gitManager.on('compare-state-change', () => {
      this.render();
    });

    this.gitManager.on('compare-selection-change', () => {
      this.render();
    });

    // Start watching and do initial refresh
    this.gitManager.startWatching();
    this.gitManager.refresh();

    // Initialize explorer manager
    this.initExplorerManager();
  }

  private initExplorerManager(): void {
    // Clean up existing manager
    if (this.explorerManager) {
      this.explorerManager.dispose();
    }

    // Create new manager with options
    const options: Partial<ExplorerOptions> = {
      hideHidden: true,
      hideGitignored: true,
      showOnlyChanges: false,
    };
    this.explorerManager = new ExplorerStateManager(this.repoPath, options);

    // Listen to state changes
    this.explorerManager.on('state-change', () => {
      this.render();
    });

    // Load root directory
    this.explorerManager.loadDirectory('');

    // Update git status after tree is loaded
    this.updateExplorerGitStatus();
  }

  /**
   * Build git status map and update explorer.
   */
  private updateExplorerGitStatus(): void {
    if (!this.explorerManager || !this.gitManager) return;

    const files = this.gitManager.state.status?.files ?? [];
    const statusMap: GitStatusMap = {
      files: new Map(),
      directories: new Set(),
    };

    for (const file of files) {
      statusMap.files.set(file.path, { status: file.status, staged: file.staged });

      // Mark all parent directories as having changed children
      const parts = file.path.split('/');
      let dirPath = '';
      for (let i = 0; i < parts.length - 1; i++) {
        dirPath = dirPath ? `${dirPath}/${parts[i]}` : parts[i];
        statusMap.directories.add(dirPath);
      }
      // Also mark root as having changes
      statusMap.directories.add('');
    }

    this.explorerManager.setGitStatus(statusMap);
  }

  /**
   * Reset UI state that's specific to a repository.
   * Called when switching to a new repo via file watcher.
   */
  private resetRepoSpecificState(): void {
    // Reset compare selection (App-level state)
    this.compareSelection = null;

    // Reset UI state scroll offsets and selections
    this.uiState.resetForNewRepo();
  }

  /**
   * Load data for the current tab.
   * Called after switching repos to refresh tab-specific data.
   */
  private loadCurrentTabData(): void {
    const tab = this.uiState.state.bottomTab;
    if (tab === 'history') {
      this.gitManager?.loadHistory();
    } else if (tab === 'compare') {
      this.gitManager?.refreshCompareDiff(this.uiState.state.includeUncommitted);
    }
    // Diff tab data is loaded by gitManager.refresh() in initGitManager
    // Explorer data is loaded by initExplorerManager()
  }

  private setupCommandHandler(): void {
    if (!this.commandServer) return;

    const handler: CommandHandler = {
      navigateUp: () => this.navigateUp(),
      navigateDown: () => this.navigateDown(),
      switchTab: (tab: BottomTab) => this.uiState.setTab(tab),
      togglePane: () => this.uiState.togglePane(),
      stage: async () => this.stageSelected(),
      unstage: async () => this.unstageSelected(),
      stageAll: async () => this.stageAll(),
      unstageAll: async () => this.unstageAll(),
      commit: async (message: string) => this.commit(message),
      refresh: async () => this.refresh(),
      getState: (): AppState => this.getAppState(),
      quit: () => this.exit(),
    };

    this.commandServer.setHandler(handler);
    this.commandServer.notifyReady();
  }

  private getAppState(): AppState {
    const state = this.uiState.state;
    const gitState = this.gitManager?.state;
    const historyState = this.gitManager?.historyState;
    const files = gitState?.status?.files ?? [];
    const commits = historyState?.commits ?? [];

    return {
      currentTab: state.bottomTab,
      currentPane: state.currentPane,
      selectedIndex: state.selectedIndex,
      totalFiles: files.length,
      stagedCount: files.filter((f) => f.staged).length,
      files: files.map((f) => ({
        path: f.path,
        status: f.status,
        staged: f.staged,
      })),
      historySelectedIndex: state.historySelectedIndex,
      historyCommitCount: commits.length,
      compareSelectedIndex: state.compareSelectedIndex,
      compareTotalItems: 0,
      includeUncommitted: state.includeUncommitted,
      explorerPath: this.repoPath,
      explorerSelectedIndex: state.explorerSelectedIndex,
      explorerItemCount: 0,
      wrapMode: state.wrapMode,
      mouseEnabled: state.mouseEnabled,
      autoTabEnabled: state.autoTabEnabled,
    };
  }

  // Navigation methods
  private navigateUp(): void {
    const state = this.uiState.state;

    if (state.bottomTab === 'history') {
      if (state.currentPane === 'history') {
        this.navigateHistoryUp();
      } else if (state.currentPane === 'diff') {
        this.uiState.setDiffScrollOffset(Math.max(0, state.diffScrollOffset - 3));
      }
      return;
    }

    if (state.bottomTab === 'compare') {
      if (state.currentPane === 'compare') {
        this.navigateCompareUp();
      } else if (state.currentPane === 'diff') {
        this.uiState.setDiffScrollOffset(Math.max(0, state.diffScrollOffset - 3));
      }
      return;
    }

    if (state.bottomTab === 'explorer') {
      if (state.currentPane === 'explorer') {
        this.navigateExplorerUp();
      } else if (state.currentPane === 'diff') {
        this.uiState.setExplorerFileScrollOffset(Math.max(0, state.explorerFileScrollOffset - 3));
      }
      return;
    }

    if (state.currentPane === 'files') {
      const files = this.gitManager?.state.status?.files ?? [];
      const newIndex = Math.max(0, state.selectedIndex - 1);
      this.uiState.setSelectedIndex(newIndex);
      this.selectFileByIndex(newIndex);

      // Keep selection visible - scroll up if needed
      const row = getRowFromFileIndex(newIndex, files);
      if (row < state.fileListScrollOffset) {
        this.uiState.setFileListScrollOffset(row);
      }
    } else if (state.currentPane === 'diff') {
      this.uiState.setDiffScrollOffset(Math.max(0, state.diffScrollOffset - 3));
    }
  }

  private navigateDown(): void {
    const state = this.uiState.state;
    const files = this.gitManager?.state.status?.files ?? [];

    if (state.bottomTab === 'history') {
      if (state.currentPane === 'history') {
        this.navigateHistoryDown();
      } else if (state.currentPane === 'diff') {
        this.uiState.setDiffScrollOffset(state.diffScrollOffset + 3);
      }
      return;
    }

    if (state.bottomTab === 'compare') {
      if (state.currentPane === 'compare') {
        this.navigateCompareDown();
      } else if (state.currentPane === 'diff') {
        this.uiState.setDiffScrollOffset(state.diffScrollOffset + 3);
      }
      return;
    }

    if (state.bottomTab === 'explorer') {
      if (state.currentPane === 'explorer') {
        this.navigateExplorerDown();
      } else if (state.currentPane === 'diff') {
        this.uiState.setExplorerFileScrollOffset(state.explorerFileScrollOffset + 3);
      }
      return;
    }

    if (state.currentPane === 'files') {
      const newIndex = Math.min(files.length - 1, state.selectedIndex + 1);
      this.uiState.setSelectedIndex(newIndex);
      this.selectFileByIndex(newIndex);

      // Keep selection visible - scroll down if needed
      const row = getRowFromFileIndex(newIndex, files);
      const visibleEnd = state.fileListScrollOffset + this.layout.dimensions.topPaneHeight - 1;
      if (row >= visibleEnd) {
        this.uiState.setFileListScrollOffset(state.fileListScrollOffset + (row - visibleEnd + 1));
      }
    } else if (state.currentPane === 'diff') {
      this.uiState.setDiffScrollOffset(state.diffScrollOffset + 3);
    }
  }

  private navigateHistoryUp(): void {
    const state = this.uiState.state;
    const newIndex = Math.max(0, state.historySelectedIndex - 1);

    if (newIndex !== state.historySelectedIndex) {
      this.uiState.setHistorySelectedIndex(newIndex);
      // Keep selection visible
      if (newIndex < state.historyScrollOffset) {
        this.uiState.setHistoryScrollOffset(newIndex);
      }
      this.selectHistoryCommitByIndex(newIndex);
    }
  }

  private navigateHistoryDown(): void {
    const state = this.uiState.state;
    const commits = this.gitManager?.historyState.commits ?? [];
    const newIndex = Math.min(commits.length - 1, state.historySelectedIndex + 1);

    if (newIndex !== state.historySelectedIndex) {
      this.uiState.setHistorySelectedIndex(newIndex);
      // Keep selection visible
      const visibleEnd = state.historyScrollOffset + this.layout.dimensions.topPaneHeight - 1;
      if (newIndex >= visibleEnd) {
        this.uiState.setHistoryScrollOffset(state.historyScrollOffset + 1);
      }
      this.selectHistoryCommitByIndex(newIndex);
    }
  }

  private selectHistoryCommitByIndex(index: number): void {
    const commits = this.gitManager?.historyState.commits ?? [];
    const commit = getCommitAtIndex(commits, index);
    if (commit) {
      this.uiState.setDiffScrollOffset(0);
      this.gitManager?.selectHistoryCommit(commit);
    }
  }

  // Compare navigation
  private compareSelection: CompareListSelection | null = null;

  private navigateCompareUp(): void {
    const compareState = this.gitManager?.compareState;
    const commits = compareState?.compareDiff?.commits ?? [];
    const files = compareState?.compareDiff?.files ?? [];

    if (commits.length === 0 && files.length === 0) return;

    const next = getNextCompareSelection(this.compareSelection, commits, files, 'up');
    if (
      next &&
      (next.type !== this.compareSelection?.type || next.index !== this.compareSelection?.index)
    ) {
      this.selectCompareItem(next);

      // Keep selection visible - scroll up if needed
      const state = this.uiState.state;
      const row = getRowFromCompareSelection(next, commits, files);
      if (row < state.compareScrollOffset) {
        this.uiState.setCompareScrollOffset(row);
      }
    }
  }

  private navigateCompareDown(): void {
    const compareState = this.gitManager?.compareState;
    const commits = compareState?.compareDiff?.commits ?? [];
    const files = compareState?.compareDiff?.files ?? [];

    if (commits.length === 0 && files.length === 0) return;

    // Auto-select first item if nothing selected
    if (!this.compareSelection) {
      // Select first commit if available, otherwise first file
      if (commits.length > 0) {
        this.selectCompareItem({ type: 'commit', index: 0 });
      } else if (files.length > 0) {
        this.selectCompareItem({ type: 'file', index: 0 });
      }
      return;
    }

    const next = getNextCompareSelection(this.compareSelection, commits, files, 'down');
    if (
      next &&
      (next.type !== this.compareSelection?.type || next.index !== this.compareSelection?.index)
    ) {
      this.selectCompareItem(next);

      // Keep selection visible - scroll down if needed
      const state = this.uiState.state;
      const row = getRowFromCompareSelection(next, commits, files);
      const visibleEnd = state.compareScrollOffset + this.layout.dimensions.topPaneHeight - 1;
      if (row >= visibleEnd) {
        this.uiState.setCompareScrollOffset(state.compareScrollOffset + (row - visibleEnd + 1));
      }
    }
  }

  private selectCompareItem(selection: CompareListSelection): void {
    this.compareSelection = selection;
    this.uiState.setDiffScrollOffset(0);

    if (selection.type === 'commit') {
      this.gitManager?.selectCompareCommit(selection.index);
    } else {
      this.gitManager?.selectCompareFile(selection.index);
    }
  }

  // Explorer navigation
  private navigateExplorerUp(): void {
    const state = this.uiState.state;
    const rows = this.explorerManager?.state.displayRows ?? [];

    if (rows.length === 0) return;

    const newScrollOffset = this.explorerManager?.navigateUp(state.explorerScrollOffset);
    if (newScrollOffset !== null && newScrollOffset !== undefined) {
      this.uiState.setExplorerScrollOffset(newScrollOffset);
    }
    this.uiState.setExplorerSelectedIndex(this.explorerManager?.state.selectedIndex ?? 0);
  }

  private navigateExplorerDown(): void {
    const state = this.uiState.state;
    const rows = this.explorerManager?.state.displayRows ?? [];

    if (rows.length === 0) return;

    const visibleHeight = this.layout.dimensions.topPaneHeight;
    const newScrollOffset = this.explorerManager?.navigateDown(
      state.explorerScrollOffset,
      visibleHeight
    );
    if (newScrollOffset !== null && newScrollOffset !== undefined) {
      this.uiState.setExplorerScrollOffset(newScrollOffset);
    }
    this.uiState.setExplorerSelectedIndex(this.explorerManager?.state.selectedIndex ?? 0);
  }

  private async enterExplorerDirectory(): Promise<void> {
    await this.explorerManager?.enterDirectory();
    // Reset file content scroll when expanding/collapsing
    this.uiState.setExplorerFileScrollOffset(0);
    // Sync selected index from explorer manager (it maintains selection by path)
    this.uiState.setExplorerSelectedIndex(this.explorerManager?.state.selectedIndex ?? 0);
  }

  private async goExplorerUp(): Promise<void> {
    await this.explorerManager?.goUp();
    // Reset file content scroll when collapsing
    this.uiState.setExplorerFileScrollOffset(0);
    // Sync selected index from explorer manager
    this.uiState.setExplorerSelectedIndex(this.explorerManager?.state.selectedIndex ?? 0);
  }

  private selectFileByIndex(index: number): void {
    const files = this.gitManager?.state.status?.files ?? [];
    const file = getFileAtIndex(files, index);
    if (file) {
      // Reset diff scroll when changing files
      this.uiState.setDiffScrollOffset(0);
      this.gitManager?.selectFile(file);
    }
  }

  /**
   * Navigate to a file given its absolute path.
   * Extracts the relative path and finds the file in the current file list.
   */
  private navigateToFile(absolutePath: string): void {
    if (!absolutePath || !this.repoPath) return;

    // Check if the path is within the current repo
    const repoPrefix = this.repoPath.endsWith('/') ? this.repoPath : this.repoPath + '/';
    if (!absolutePath.startsWith(repoPrefix)) return;

    // Extract relative path
    const relativePath = absolutePath.slice(repoPrefix.length);
    if (!relativePath) return;

    // Find the file in the list
    const files = this.gitManager?.state.status?.files ?? [];
    const fileIndex = files.findIndex((f) => f.path === relativePath);

    if (fileIndex >= 0) {
      this.uiState.setSelectedIndex(fileIndex);
      this.selectFileByIndex(fileIndex);
    }
  }

  // Git operations
  private async stageSelected(): Promise<void> {
    const files = this.gitManager?.state.status?.files ?? [];
    const index = this.uiState.state.selectedIndex;
    const selectedFile = getFileAtIndex(files, index);
    if (selectedFile && !selectedFile.staged) {
      this.pendingSelectionAnchor = getCategoryForIndex(files, index);
      await this.gitManager?.stage(selectedFile);
    }
  }

  private async unstageSelected(): Promise<void> {
    const files = this.gitManager?.state.status?.files ?? [];
    const index = this.uiState.state.selectedIndex;
    const selectedFile = getFileAtIndex(files, index);
    if (selectedFile?.staged) {
      this.pendingSelectionAnchor = getCategoryForIndex(files, index);
      await this.gitManager?.unstage(selectedFile);
    }
  }

  private async toggleSelected(): Promise<void> {
    const files = this.gitManager?.state.status?.files ?? [];
    const index = this.uiState.state.selectedIndex;
    const selectedFile = getFileAtIndex(files, index);
    if (selectedFile) {
      this.pendingSelectionAnchor = getCategoryForIndex(files, index);
      if (selectedFile.staged) {
        await this.gitManager?.unstage(selectedFile);
      } else {
        await this.gitManager?.stage(selectedFile);
      }
    }
  }

  private async stageAll(): Promise<void> {
    await this.gitManager?.stageAll();
  }

  private async unstageAll(): Promise<void> {
    await this.gitManager?.unstageAll();
  }

  private showDiscardConfirm(file: FileEntry): void {
    this.activeModal = new DiscardConfirm(
      this.screen,
      file.path,
      async () => {
        this.activeModal = null;
        await this.gitManager?.discard(file);
      },
      () => {
        this.activeModal = null;
      }
    );
    this.activeModal.focus();
  }

  private async openFileFinder(): Promise<void> {
    const allPaths = (await this.explorerManager?.getAllFilePaths()) ?? [];
    if (allPaths.length === 0) return;

    this.activeModal = new FileFinder(
      this.screen,
      allPaths,
      async (selectedPath) => {
        this.activeModal = null;
        // Navigate to the selected file in explorer
        const success = await this.explorerManager?.navigateToPath(selectedPath);
        if (success) {
          // Reset scroll to show selected file
          this.uiState.setExplorerScrollOffset(0);
          this.uiState.setExplorerFileScrollOffset(0);
        }
        this.render();
      },
      () => {
        this.activeModal = null;
        this.render();
      }
    );
    this.activeModal.focus();
  }

  private async commit(message: string): Promise<void> {
    await this.gitManager?.commit(message);
  }

  private async refresh(): Promise<void> {
    await this.gitManager?.refresh();
  }

  private toggleMouseMode(): void {
    const willEnable = !this.uiState.state.mouseEnabled;
    this.uiState.toggleMouse();

    // Access program for terminal mouse control (not on screen's TS types)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const program = (this.screen as any).program;
    if (willEnable) {
      program.enableMouse();
    } else {
      program.disableMouse();
    }
  }

  private toggleFollow(): void {
    if (!this.followMode) {
      this.followMode = new FollowMode(this.config.targetFile, () => this.repoPath, {
        onRepoChange: (newPath, state) => this.handleFollowRepoChange(newPath, state),
        onFileNavigate: (rawContent) => this.handleFollowFileNavigate(rawContent),
      });
    }
    this.followMode.toggle();
    this.render();
  }

  private focusCommitInput(): void {
    if (this.commitTextarea) {
      this.commitTextarea.show();
      this.commitTextarea.focus();
      this.commitTextarea.setValue(this.commitFlowState.state.message);
      this.commitFlowState.setInputFocused(true);
      this.render();
    }
  }

  private unfocusCommitInput(): void {
    if (this.commitTextarea) {
      const value = this.commitTextarea.getValue() ?? '';
      this.commitFlowState.setMessage(value);
      this.commitTextarea.hide();
      this.commitFlowState.setInputFocused(false);
      this.screen.focusPush(this.layout.bottomPane);
      this.render();
    }
  }

  // Render methods
  private render(): void {
    this.updateHeader();
    this.updateTopPane();
    this.updateBottomPane();
    this.updateFooter();
    this.screen.render();
  }

  private updateHeader(): void {
    const gitState = this.gitManager?.state;
    const width = (this.screen.width as number) || 80;

    const content = formatHeader(
      this.repoPath,
      gitState?.status?.branch ?? null,
      gitState?.isLoading ?? false,
      gitState?.error ?? null,
      width
    );

    this.layout.headerBox.setContent(content);
  }

  private updateTopPane(): void {
    const state = this.uiState.state;
    const width = (this.screen.width as number) || 80;

    const content = renderTopPane(
      state,
      this.gitManager?.state.status?.files ?? [],
      this.gitManager?.historyState?.commits ?? [],
      this.gitManager?.compareState?.compareDiff ?? null,
      this.compareSelection,
      this.explorerManager?.state,
      width,
      this.layout.dimensions.topPaneHeight
    );

    this.layout.topPane.setContent(content);
  }

  private updateBottomPane(): void {
    const state = this.uiState.state;
    const width = (this.screen.width as number) || 80;
    const files = this.gitManager?.state.status?.files ?? [];
    const stagedCount = files.filter((f) => f.staged).length;

    // Update staged count for commit validation
    this.commitFlowState.setStagedCount(stagedCount);

    const { content, totalRows } = renderBottomPane(
      state,
      this.gitManager?.state.diff ?? null,
      this.gitManager?.historyState,
      this.gitManager?.compareSelectionState,
      this.explorerManager?.state?.selectedFile ?? null,
      this.commitFlowState.state,
      stagedCount,
      this.currentTheme,
      width,
      this.layout.dimensions.bottomPaneHeight
    );

    this.bottomPaneTotalRows = totalRows;
    this.layout.bottomPane.setContent(content);

    // Manage commit textarea visibility
    if (this.commitTextarea) {
      if (state.bottomTab === 'commit' && this.commitFlowState.state.inputFocused) {
        this.commitTextarea.show();
      } else {
        this.commitTextarea.hide();
      }
    }
  }

  private updateFooter(): void {
    const state = this.uiState.state;
    const width = (this.screen.width as number) || 80;

    const content = formatFooter(
      state.bottomTab,
      state.mouseEnabled,
      state.autoTabEnabled,
      state.wrapMode,
      this.followMode?.isEnabled ?? false,
      this.explorerManager?.showOnlyChanges ?? false,
      width
    );

    this.layout.footerBox.setContent(content);
  }

  /**
   * Exit the application cleanly.
   */
  exit(): void {
    // Clean up
    if (this.gitManager) {
      removeManagerForRepo(this.repoPath);
    }
    if (this.explorerManager) {
      this.explorerManager.dispose();
    }
    if (this.followMode) {
      this.followMode.stop();
    }
    if (this.commandServer) {
      this.commandServer.stop();
    }

    // Destroy screen (this will clean up terminal)
    this.screen.destroy();
  }

  /**
   * Start the application (returns when app exits).
   */
  start(): Promise<void> {
    return new Promise((resolve) => {
      this.screen.on('destroy', () => {
        resolve();
      });
    });
  }
}
