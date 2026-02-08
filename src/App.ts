import blessed from 'neo-blessed';
import type { Widgets } from 'blessed';
import { LayoutManager } from './ui/Layout.js';
import { setupKeyBindings } from './KeyBindings.js';
import { renderTopPane, renderBottomPane } from './ui/PaneRenderers.js';
import { setupMouseHandlers } from './MouseHandlers.js';
import { NavigationController } from './NavigationController.js';
import { StagingOperations } from './StagingOperations.js';
import { ModalController } from './ModalController.js';
import { FollowMode, FollowModeWatcherState } from './FollowMode.js';
import { formatHeader } from './ui/widgets/Header.js';

import { formatFooter } from './ui/widgets/Footer.js';
import {
  ExplorerStateManager,
  ExplorerOptions,
  GitStatusMap,
} from './core/ExplorerStateManager.js';
import { CommitFlowState } from './state/CommitFlowState.js';
import { UIState } from './state/UIState.js';
import {
  GitStateManager,
  getManagerForRepo,
  removeManagerForRepo,
} from './core/GitStateManager.js';
import { Config, saveConfig, addRecentRepo } from './config.js';
import { getIndexForCategoryPosition } from './utils/fileCategories.js';
import {
  buildFlatFileList,
  getFlatFileIndexByPath,
  type FlatFileEntry,
} from './utils/flatFileList.js';
import type { CommandServer, CommandHandler, AppState } from './ipc/CommandServer.js';
import type { BottomTab } from './types/tabs.js';
import type { ThemeName } from './themes.js';
import type { HunkBoundary, CombinedHunkInfo } from './utils/displayRows.js';

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
  private navigation: NavigationController;
  private staging: StagingOperations;
  private modals: ModalController;

  // Current state
  private repoPath: string;
  private currentTheme: ThemeName;
  private recentRepos: string[];

  // Commit flow state
  private commitFlowState: CommitFlowState;
  private commitTextarea: Widgets.TextareaElement | null = null;

  // Auto-clear timer for remote operation status
  private remoteClearTimer: ReturnType<typeof setTimeout> | null = null;

  // Cached total rows and hunk info for scroll bounds (single source of truth from render)
  private bottomPaneTotalRows: number = 0;
  private bottomPaneHunkCount: number = 0;
  private bottomPaneHunkBoundaries: HunkBoundary[] = [];

  // Auto-tab transition tracking
  private prevFileCount: number = 0;

  // Flat view mode state
  private cachedFlatFiles: FlatFileEntry[] = [];
  private combinedHunkMapping: CombinedHunkInfo[] = [];

  constructor(options: AppOptions) {
    this.config = options.config;
    this.commandServer = options.commandServer ?? null;
    this.repoPath = options.initialPath ?? process.cwd();
    this.currentTheme = options.config.theme;
    this.recentRepos = options.config.recentRepos ?? [];

    // Initialize UI state with config values
    this.uiState = new UIState({
      splitRatio: options.config.splitRatio ?? 0.4,
      autoTabEnabled: options.config.autoTabEnabled ?? false,
      wrapMode: options.config.wrapMode ?? false,
      mouseEnabled: options.config.mouseEnabled ?? true,
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
      getHeadMessage: () => this.gitManager?.history.getHeadCommitMessage() ?? Promise.resolve(''),
      onCommit: async (message, amend) => {
        await this.gitManager?.workingTree.commit(message, amend);
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

    // Setup navigation controller
    this.navigation = new NavigationController({
      uiState: this.uiState,
      getGitManager: () => this.gitManager,
      getExplorerManager: () => this.explorerManager,
      getTopPaneHeight: () => this.layout.dimensions.topPaneHeight,
      getBottomPaneHeight: () => this.layout.dimensions.bottomPaneHeight,
      getCachedFlatFiles: () => this.cachedFlatFiles,
      getHunkCount: () => this.bottomPaneHunkCount,
      getHunkBoundaries: () => this.bottomPaneHunkBoundaries,
      getRepoPath: () => this.repoPath,
      onError: (message) => this.showError(message),
    });

    // Setup modal controller
    this.modals = new ModalController({
      screen: this.screen,
      uiState: this.uiState,
      getGitManager: () => this.gitManager,
      getExplorerManager: () => this.explorerManager,
      getTopPaneHeight: () => this.layout.dimensions.topPaneHeight,
      getCurrentTheme: () => this.currentTheme,
      setCurrentTheme: (theme) => {
        this.currentTheme = theme;
      },
      getRepoPath: () => this.repoPath,
      getRecentRepos: () => this.recentRepos,
      onRepoSwitch: (repoPath) => this.switchToRepo(repoPath),
      render: () => this.render(),
    });

    // Setup staging operations
    this.staging = new StagingOperations({
      uiState: this.uiState,
      getGitManager: () => this.gitManager,
      getCachedFlatFiles: () => this.cachedFlatFiles,
      getCombinedHunkMapping: () => this.combinedHunkMapping,
    });

    // If mouse was persisted as disabled, disable it now
    if (!this.uiState.state.mouseEnabled) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this.screen as any).program.disableMouse();
    }

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

  /**
   * Display an error in the UI by emitting a state change with the error set.
   */
  private showError(message: string): void {
    if (!this.gitManager) return;
    const wt = this.gitManager.workingTree;
    wt.emit('state-change', { ...wt.state, error: message });
  }

  private setupKeyboardHandlers(): void {
    setupKeyBindings(
      this.screen,
      {
        exit: () => this.exit(),
        navigateDown: () => this.navigation.navigateDown(),
        navigateUp: () => this.navigation.navigateUp(),
        stageSelected: () => this.staging.stageSelected(),
        unstageSelected: () => this.staging.unstageSelected(),
        stageAll: () => this.staging.stageAll(),
        unstageAll: () => this.staging.unstageAll(),
        toggleSelected: () => this.staging.toggleSelected(),
        enterExplorerDirectory: () => this.navigation.enterExplorerDirectory(),
        goExplorerUp: () => this.navigation.goExplorerUp(),
        openFileFinder: () => this.modals.openFileFinder(),
        focusCommitInput: () => this.focusCommitInput(),
        unfocusCommitInput: () => this.unfocusCommitInput(),
        openRepoPicker: () => this.modals.openRepoPicker(),
        toggleMouseMode: () => this.toggleMouseMode(),
        toggleFollow: () => this.toggleFollow(),
        showDiscardConfirm: (file) => this.modals.showDiscardConfirm(file),
        render: () => this.render(),
        toggleCurrentHunk: () => this.staging.toggleCurrentHunk(),
        navigateNextHunk: () => this.navigation.navigateNextHunk(),
        navigatePrevHunk: () => this.navigation.navigatePrevHunk(),
        cherryPickSelected: () => this.modals.cherryPickSelected(),
        revertSelected: () => this.modals.revertSelected(),
      },
      {
        hasActiveModal: () => this.modals.hasActiveModal(),
        getBottomTab: () => this.uiState.state.bottomTab,
        getCurrentPane: () => this.uiState.state.currentPane,
        getFocusedZone: () => this.uiState.state.focusedZone,
        isCommitInputFocused: () => this.commitFlowState.state.inputFocused,
        getStatusFiles: () => this.gitManager?.workingTree.state.status?.files ?? [],
        getSelectedIndex: () => this.uiState.state.selectedIndex,
        uiState: this.uiState,
        getExplorerManager: () => this.explorerManager,
        commitFlowState: this.commitFlowState,
        getGitManager: () => this.gitManager,
        layout: this.layout,
        getCachedFlatFiles: () => this.cachedFlatFiles,
      }
    );
  }

  private setupMouseEventHandlers(): void {
    setupMouseHandlers(
      this.layout,
      {
        selectHistoryCommitByIndex: (index) => this.navigation.selectHistoryCommitByIndex(index),
        selectCompareItem: (selection) => this.navigation.selectCompareItem(selection),
        selectFileByIndex: (index) => this.navigation.selectFileByIndex(index),
        toggleFileByIndex: (index) => this.staging.toggleFileByIndex(index),
        enterExplorerDirectory: () => this.navigation.enterExplorerDirectory(),
        toggleMouseMode: () => this.toggleMouseMode(),
        toggleFollow: () => this.toggleFollow(),
        selectHunkAtRow: (row) => this.navigation.selectHunkAtRow(row),
        focusCommitInput: () => this.focusCommitInput(),
        render: () => this.render(),
      },
      {
        uiState: this.uiState,
        getExplorerManager: () => this.explorerManager,
        getStatusFiles: () => this.gitManager?.workingTree.state.status?.files ?? [],
        getHistoryCommitCount: () => this.gitManager?.history.historyState.commits.length ?? 0,
        getCompareCommits: () => this.gitManager?.compare.compareState?.compareDiff?.commits ?? [],
        getCompareFiles: () => this.gitManager?.compare.compareState?.compareDiff?.files ?? [],
        getBottomPaneTotalRows: () => this.bottomPaneTotalRows,
        getScreenWidth: () => (this.screen.width as number) || 80,
        getCachedFlatFiles: () => this.cachedFlatFiles,
      }
    );
  }

  private setupStateListeners(): void {
    // Apply auto-tab logic when toggled on
    let prevAutoTab = this.uiState.state.autoTabEnabled;
    this.uiState.on('change', (state) => {
      if (state.autoTabEnabled && !prevAutoTab) {
        this.applyAutoTab();
      }
      prevAutoTab = state.autoTabEnabled;
    });

    // Update footer when UI state changes
    this.uiState.on('change', () => {
      this.render();
    });

    // Load data when switching tabs
    this.uiState.on('tab-change', (tab) => {
      // Reset hunk selection when leaving diff tab
      if (tab !== 'diff') {
        this.uiState.setSelectedHunkIndex(0);
      }
      if (tab === 'history') {
        this.loadHistory();
      } else if (tab === 'compare') {
        this.gitManager?.compare.refreshCompareDiff(this.uiState.state.includeUncommitted);
      } else if (tab === 'explorer') {
        // Explorer is already loaded on init, but refresh if needed
        if (!this.explorerManager?.state.displayRows.length) {
          this.explorerManager?.loadDirectory('');
        }
      }
    });

    // Handle modal opening/closing
    this.uiState.on('modal-change', (modal) => {
      this.modals.handleModalChange(modal);
    });

    // Persist UI state to config when toggles or split ratio change
    let saveTimer: ReturnType<typeof setTimeout> | null = null;
    this.uiState.on('change', (state) => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        const updates: Record<string, unknown> = {};
        if (state.splitRatio !== this.config.splitRatio) updates.splitRatio = state.splitRatio;
        if (state.autoTabEnabled !== this.config.autoTabEnabled)
          updates.autoTabEnabled = state.autoTabEnabled;
        if (state.wrapMode !== this.config.wrapMode) updates.wrapMode = state.wrapMode;
        if (state.mouseEnabled !== this.config.mouseEnabled)
          updates.mouseEnabled = state.mouseEnabled;
        if (Object.keys(updates).length > 0) saveConfig(updates);
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
    this.navigation.navigateToFile(rawContent);
    this.render();
  }

  private recordCurrentRepo(): void {
    const max = this.config.maxRecentRepos ?? 10;
    this.recentRepos = [
      this.repoPath,
      ...this.recentRepos.filter((r) => r !== this.repoPath),
    ].slice(0, max);
    addRecentRepo(this.repoPath, max);
  }

  private switchToRepo(newPath: string): void {
    if (newPath === this.repoPath) return;
    if (this.followMode?.isEnabled) this.followMode.stop();
    const oldRepoPath = this.repoPath;
    this.repoPath = newPath;
    this.initGitManager(oldRepoPath);
    this.resetRepoSpecificState();
    this.loadCurrentTabData();
    this.render();
  }

  private initGitManager(oldRepoPath?: string): void {
    // Clean up existing manager's event listeners
    if (this.gitManager) {
      this.gitManager.workingTree.removeAllListeners();
      this.gitManager.history.removeAllListeners();
      this.gitManager.compare.removeAllListeners();
      this.gitManager.remote.removeAllListeners();
      // Use oldRepoPath if provided (when switching repos), otherwise use current path
      removeManagerForRepo(oldRepoPath ?? this.repoPath);
    }

    // Get or create manager for this repo
    this.gitManager = getManagerForRepo(this.repoPath);

    // Listen to working tree state changes
    this.gitManager.workingTree.on('state-change', () => {
      // Skip reconciliation while loading — the pending anchor must wait
      // for the new status to arrive before being consumed
      if (!this.gitManager?.workingTree.state.isLoading) {
        this.reconcileSelectionAfterStateChange();
        this.applyAutoTab();
      }
      this.updateExplorerGitStatus();
      this.render();
    });

    // Listen to history state changes
    this.gitManager.history.on('history-state-change', (historyState) => {
      // Auto-select first commit when history loads
      if (historyState.commits.length > 0 && !historyState.selectedCommit) {
        const state = this.uiState.state;
        if (state.bottomTab === 'history') {
          this.navigation.selectHistoryCommitByIndex(state.historySelectedIndex);
        }
      }
      this.render();
    });

    // Listen to compare state changes
    this.gitManager.compare.on('compare-state-change', () => {
      this.render();
    });

    this.gitManager.compare.on('compare-selection-change', () => {
      this.render();
    });

    // Listen to remote operation state changes
    this.gitManager.remote.on('remote-state-change', (remoteState) => {
      // Auto-clear success after 3s, error after 5s
      if (this.remoteClearTimer) clearTimeout(this.remoteClearTimer);
      if (remoteState.lastResult && !remoteState.inProgress) {
        this.remoteClearTimer = setTimeout(() => {
          this.gitManager?.remote.clearRemoteState();
        }, 3000);
      } else if (remoteState.error) {
        this.remoteClearTimer = setTimeout(() => {
          this.gitManager?.remote.clearRemoteState();
        }, 5000);
      }
      this.render();
    });

    // Start watching and do initial refresh
    this.gitManager.workingTree.startWatching();
    this.gitManager.workingTree.refresh();

    // Initialize explorer manager
    this.initExplorerManager();

    // Record this repo in recent repos list
    this.recordCurrentRepo();
  }

  /**
   * Load history with error handling (moved from facade).
   */
  private loadHistory(count: number = 100): void {
    this.gitManager?.history.loadHistory(count).catch((err) => {
      this.showError(`Failed to load history: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  /**
   * After git state changes, reconcile the selected file index.
   * Handles both flat mode (path-based anchoring) and categorized mode (category-based anchoring).
   */
  private reconcileSelectionAfterStateChange(): void {
    const files = this.gitManager?.workingTree.state.status?.files ?? [];

    const pendingFlatPath = this.staging.consumePendingFlatSelectionPath();
    if (this.uiState.state.flatViewMode && pendingFlatPath) {
      const flatFiles = buildFlatFileList(
        files,
        this.gitManager?.workingTree.state.hunkCounts ?? null
      );
      const newIndex = getFlatFileIndexByPath(flatFiles, pendingFlatPath);
      if (newIndex >= 0) {
        this.uiState.setSelectedIndex(newIndex);
        this.navigation.selectFileByIndex(newIndex);
      } else if (flatFiles.length > 0) {
        const clamped = Math.min(this.uiState.state.selectedIndex, flatFiles.length - 1);
        this.uiState.setSelectedIndex(clamped);
        this.navigation.selectFileByIndex(clamped);
      }
      return;
    }

    const anchor = this.staging.consumePendingSelectionAnchor();
    if (anchor) {
      const newIndex = getIndexForCategoryPosition(files, anchor.category, anchor.categoryIndex);
      this.uiState.setSelectedIndex(newIndex);
      this.navigation.selectFileByIndex(newIndex);
      return;
    }

    // No pending anchor — just clamp to valid range
    if (this.uiState.state.flatViewMode) {
      const flatFiles = buildFlatFileList(
        files,
        this.gitManager?.workingTree.state.hunkCounts ?? null
      );
      const maxIndex = flatFiles.length - 1;
      if (maxIndex >= 0 && this.uiState.state.selectedIndex > maxIndex) {
        this.uiState.setSelectedIndex(maxIndex);
      }
    } else if (files.length > 0) {
      const maxIndex = files.length - 1;
      if (this.uiState.state.selectedIndex > maxIndex) {
        this.uiState.setSelectedIndex(maxIndex);
      }
    }
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

    // Pre-load file paths for file finder (runs in background)
    this.explorerManager.loadFilePaths();

    // Update git status after tree is loaded
    this.updateExplorerGitStatus();
  }

  /**
   * Build git status map and update explorer.
   */
  private updateExplorerGitStatus(): void {
    if (!this.explorerManager || !this.gitManager) return;

    const files = this.gitManager.workingTree.state.status?.files ?? [];
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
    // Reset compare selection (owned by NavigationController)
    this.navigation.compareSelection = null;

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
      this.loadHistory();
    } else if (tab === 'compare') {
      this.gitManager?.compare.refreshCompareDiff(this.uiState.state.includeUncommitted);
    }
    // Diff tab data is loaded by gitManager.workingTree.refresh() in initGitManager
    // Explorer data is loaded by initExplorerManager()
  }

  private setupCommandHandler(): void {
    if (!this.commandServer) return;

    const handler: CommandHandler = {
      navigateUp: () => this.navigation.navigateUp(),
      navigateDown: () => this.navigation.navigateDown(),
      switchTab: (tab: BottomTab) => this.uiState.setTab(tab),
      togglePane: () => this.uiState.togglePane(),
      stage: async () => this.staging.stageSelected(),
      unstage: async () => this.staging.unstageSelected(),
      stageAll: async () => this.staging.stageAll(),
      unstageAll: async () => this.staging.unstageAll(),
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
    const gitState = this.gitManager?.workingTree.state;
    const historyState = this.gitManager?.history.historyState;
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

  private async commit(message: string): Promise<void> {
    await this.gitManager?.workingTree.commit(message);
  }

  private async refresh(): Promise<void> {
    await this.gitManager?.workingTree.refresh();
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

  /**
   * When auto-tab is enabled, switch tabs based on file count transitions:
   * - Files disappear (prev > 0, current === 0): switch to history
   * - Files appear (prev === 0, current > 0): switch to diff
   * Always updates prevFileCount so enabling doesn't trigger on stale state.
   */
  private applyAutoTab(): void {
    const files = this.gitManager?.workingTree.state.status?.files ?? [];
    const currentCount = files.length;
    const prev = this.prevFileCount;
    this.prevFileCount = currentCount;

    if (!this.uiState.state.autoTabEnabled) return;

    const tab = this.uiState.state.bottomTab;
    if (prev > 0 && currentCount === 0 && (tab === 'diff' || tab === 'commit')) {
      this.uiState.setHistorySelectedIndex(0);
      this.uiState.setHistoryScrollOffset(0);
      this.uiState.setTab('history');
    } else if (prev === 0 && currentCount > 0 && tab === 'history') {
      this.uiState.setTab('diff');
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

    // Restore hunk index after diff refresh (e.g. after hunk toggle in flat mode)
    const pendingHunk = this.staging.consumePendingHunkIndex();
    if (pendingHunk !== null && this.bottomPaneHunkCount > 0) {
      const restored = Math.min(pendingHunk, this.bottomPaneHunkCount - 1);
      this.uiState.setSelectedHunkIndex(restored);
      this.updateBottomPane(); // Re-render with correct hunk selection
    }

    this.updateSeparators();
    this.updateFooter();
    this.screen.render();
  }

  private updateSeparators(): void {
    const zone = this.uiState.state.focusedZone;
    // Top-pane zones: fileList, historyList, compareList, explorerTree
    const isTopPaneZone =
      zone === 'fileList' ||
      zone === 'historyList' ||
      zone === 'compareList' ||
      zone === 'explorerTree';
    this.layout.middleSeparator.style.fg = isTopPaneZone ? 'cyan' : 'gray';
  }

  private updateHeader(): void {
    const gitState = this.gitManager?.workingTree.state;
    const width = (this.screen.width as number) || 80;

    const content = formatHeader(
      this.repoPath,
      gitState?.status?.branch ?? null,
      gitState?.isLoading ?? false,
      gitState?.error ?? null,
      width,
      this.gitManager?.remote.remoteState ?? null
    );

    this.layout.headerBox.setContent(content);
  }

  private updateTopPane(): void {
    const state = this.uiState.state;
    const width = (this.screen.width as number) || 80;
    const files = this.gitManager?.workingTree.state.status?.files ?? [];

    // Build and cache flat file list when in flat mode
    if (state.flatViewMode) {
      this.cachedFlatFiles = buildFlatFileList(
        files,
        this.gitManager?.workingTree.state.hunkCounts ?? null
      );
    }

    const content = renderTopPane(
      state,
      files,
      this.gitManager?.history.historyState?.commits ?? [],
      this.gitManager?.compare.compareState?.compareDiff ?? null,
      this.navigation.compareSelection,
      this.explorerManager?.state,
      width,
      this.layout.dimensions.topPaneHeight,
      this.gitManager?.workingTree.state.hunkCounts,
      state.flatViewMode ? this.cachedFlatFiles : undefined
    );

    this.layout.topPane.setContent(content);
  }

  private updateBottomPane(): void {
    const state = this.uiState.state;
    const width = (this.screen.width as number) || 80;
    const files = this.gitManager?.workingTree.state.status?.files ?? [];
    const stagedCount = files.filter((f) => f.staged).length;

    // Update staged count for commit validation
    this.commitFlowState.setStagedCount(stagedCount);

    // Pass selectedHunkIndex and staged status only when diff pane is focused on diff tab
    const diffPaneFocused = state.bottomTab === 'diff' && state.currentPane === 'diff';
    const hunkIndex = diffPaneFocused ? state.selectedHunkIndex : undefined;
    const isFileStaged = diffPaneFocused
      ? this.gitManager?.workingTree.state.selectedFile?.staged
      : undefined;

    const { content, totalRows, hunkCount, hunkBoundaries, hunkMapping } = renderBottomPane(
      state,
      this.gitManager?.workingTree.state.diff ?? null,
      this.gitManager?.history.historyState,
      this.gitManager?.compare.compareSelectionState,
      this.explorerManager?.state?.selectedFile ?? null,
      this.commitFlowState.state,
      stagedCount,
      this.currentTheme,
      width,
      this.layout.dimensions.bottomPaneHeight,
      hunkIndex,
      isFileStaged,
      state.flatViewMode ? this.gitManager?.workingTree.state.combinedFileDiffs : undefined,
      state.focusedZone
    );

    this.bottomPaneTotalRows = totalRows;
    this.bottomPaneHunkCount = hunkCount;
    this.bottomPaneHunkBoundaries = hunkBoundaries;
    this.combinedHunkMapping = hunkMapping ?? [];

    // Silently clamp hunk index to actual count (handles async refresh after hunk staging)
    this.uiState.clampSelectedHunkIndex(hunkCount);

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
      width,
      state.currentPane
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
    if (this.remoteClearTimer) {
      clearTimeout(this.remoteClearTimer);
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
