import * as fs from 'node:fs';
import * as path from 'node:path';
import blessed from 'neo-blessed';
import type { Widgets } from 'blessed';
import type { DiffstalkerClient } from '@diffstalker/client';
import { LayoutManager } from './ui/Layout.js';
import { setupKeyBindings } from './KeyBindings.js';
import { renderTopPane, renderBottomPane } from './ui/PaneRenderers.js';
import { setupMouseHandlers } from './MouseHandlers.js';
import { NavigationController } from './NavigationController.js';
import { StagingOperations } from './StagingOperations.js';
import { ModalController } from './ModalController.js';
import { FollowMode } from './FollowMode.js';
import { formatHeader } from './ui/widgets/Header.js';

import { formatFooter } from './ui/widgets/Footer.js';
import { COMMIT_INPUT_HEIGHT } from './ui/widgets/CommitPanel.js';
import { HUNK_FLASH_MS } from './ui/widgets/DiffView.js';
import { ExplorerViewModel, ExplorerOptions } from './state/ExplorerViewModel.js';
import { buildGitStatusMap } from '@diffstalker/core/git/explorerData';
import { CommitFlowState } from './state/CommitFlowState.js';
import { UIState } from './state/UIState.js';
import { RepoSession, openRepoSession } from './daemon/RepoSession.js';
import { Config, saveConfig, addRecentRepo } from './config.js';
import { getIndexForCategoryPosition } from './utils/fileCategories.js';
import {
  buildFlatFileList,
  getFlatFileAtIndex,
  getFlatFileIndexByPath,
  type FlatFileEntry,
} from './utils/flatFileList.js';
import { getFileAtIndex } from './ui/widgets/FileList.js';
import { applyBlessedRgbPatch } from './utils/blessedRgbPatch.js';
import {
  resolveFileAtIndex as resolveFile,
  getFileListMaxIndex as getMaxIndex,
} from './utils/fileResolution.js';
import type { ThemeName } from './themes.js';
import type { HunkBoundary, CombinedHunkInfo } from './utils/displayRows.js';

export interface AppOptions {
  config: Config;
  /** Client bound to a live diffstalkerd (index.ts runs ensureDaemon). */
  client: DiffstalkerClient;
  initialPath?: string;
}

/**
 * Main application controller.
 * Coordinates between the daemon-backed RepoSession, UIState, and blessed
 * widgets. All git state lives on diffstalkerd; the session mirrors it
 * client-side (SSE + on-demand pulls) so rendering stays synchronous.
 */
export class App {
  private screen: Widgets.Screen;
  private layout: LayoutManager;
  private uiState: UIState;
  private client: DiffstalkerClient;
  private session: RepoSession | null = null;
  private followMode: FollowMode;
  /**
   * Whether the daemon itself runs follow mode (false under --no-follow).
   * Fetched once at startup; gates the client-side follow toggle so a
   * silently-ignored keypress becomes a visible error instead.
   */
  private daemonFollowEnabled = false;
  private explorerManager: ExplorerViewModel | null = null;
  private config: Config;
  private navigation: NavigationController;
  private staging: StagingOperations;
  private modals: ModalController;

  // Current state
  private repoPath: string;
  private currentTheme: ThemeName;
  private recentRepos: string[];

  // Monotonic guard for concurrent repo switches: only the latest open wins
  private switchSeq: number = 0;

  // Session dispose kicked off by exit(); awaited before the process ends
  // so the daemon-side repo refcount is actually released.
  private exitDispose: Promise<void> | null = null;

  // Commit flow state
  private commitFlowState: CommitFlowState;
  private commitTextarea: Widgets.TextareaElement | null = null;

  // Auto-clear timer for remote operation status
  private remoteClearTimer: ReturnType<typeof setTimeout> | null = null;

  // Self-scheduling re-render keeping relative hunk edit times fresh: 1s
  // cadence while a visible hunk is under a minute old (seconds shown, and
  // it also clears the yellow flash), 60s once everything ages into minutes
  private hunkTimeTick: ReturnType<typeof setTimeout> | null = null;

  // Stamp of the fresh hunk the diff pane last auto-scrolled to (auto mode)
  private lastFreshHunkScroll: number = 0;

  // Cached total rows and hunk info for scroll bounds (single source of truth from render)
  private bottomPaneTotalRows: number = 0;
  private bottomPaneHunkCount: number = 0;
  private bottomPaneHunkBoundaries: HunkBoundary[] = [];

  // Auto-tab transition tracking
  private prevFileCount: number = 0;

  // Auto-scroll-to-latest-change tracking (auto mode): last-seen mtime per
  // changed file, plus the transient "flash" highlight for the newest change.
  private lastChangeMtimes = new Map<string, number>();
  private flashFilePath: string | null = null;
  private flashTimer: ReturnType<typeof setTimeout> | null = null;

  // Flat view mode state
  private cachedFlatFiles: FlatFileEntry[] = [];
  private combinedHunkMapping: CombinedHunkInfo[] = [];

  constructor(options: AppOptions) {
    this.config = options.config;
    this.client = options.client;
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

    // Enable 24-bit RGB rendering; must happen before the screen is created
    applyBlessedRgbPatch();

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
      getHeadMessage: () => this.session?.getHeadCommitMessage() ?? Promise.resolve(''),
      onCommit: async (message, amend) => {
        await this.session?.commit(message, amend);
      },
      onSuccess: () => {
        this.uiState.setTab('diff');
        this.render();
      },
    });

    // Create commit textarea (hidden initially). Multi-line: Enter inserts
    // a newline (native textarea behavior); Ctrl+S submits. The blessed
    // textarea never emits 'submit' on Enter - it has no submit key at all -
    // so the commit must be wired to an explicit key.
    this.commitTextarea = blessed.textarea({
      parent: this.layout.bottomPane,
      top: 3,
      left: 1,
      width: '100%-4',
      height: COMMIT_INPUT_HEIGHT,
      inputOnFocus: true,
      hidden: true,
      style: {
        fg: 'white',
        bg: 'default',
      },
    });

    this.commitTextarea.key(['C-s'], () => {
      this.commitFlowState.setMessage(this.commitTextarea?.getValue() ?? '');
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
      getSession: () => this.session,
      getExplorerManager: () => this.explorerManager,
      getTopPaneHeight: () => this.layout.dimensions.topPaneHeight,
      getBottomPaneHeight: () => this.layout.dimensions.bottomPaneHeight,
      getCachedFlatFiles: () => this.cachedFlatFiles,
      getHunkCount: () => this.bottomPaneHunkCount,
      getHunkBoundaries: () => this.bottomPaneHunkBoundaries,
      getRepoPath: () => this.repoPath,
      getBottomPaneTotalRows: () => this.bottomPaneTotalRows,
      onError: (message) => this.showError(message),
      resolveFileAtIndex: (index) =>
        resolveFile(
          index,
          this.uiState.state.flatViewMode,
          this.cachedFlatFiles,
          this.session?.shared.status?.files ?? []
        ),
      getFileListMaxIndex: () =>
        getMaxIndex(
          this.uiState.state.flatViewMode,
          this.cachedFlatFiles,
          this.session?.shared.status?.files ?? []
        ),
    });

    // Setup modal controller
    this.modals = new ModalController({
      screen: this.screen,
      uiState: this.uiState,
      getSession: () => this.session,
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
      getSession: () => this.session,
      getCachedFlatFiles: () => this.cachedFlatFiles,
      getCombinedHunkMapping: () => this.combinedHunkMapping,
      resolveFileAtIndex: (index) =>
        resolveFile(
          index,
          this.uiState.state.flatViewMode,
          this.cachedFlatFiles,
          this.session?.shared.status?.files ?? []
        ),
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

    // Follow mode reacts to the daemon's follow-change SSE (the daemon owns
    // the hook-file watcher). Subscribe once, up front; the toggle — seeded
    // from --follow — only gates whether events act. GET /follow in start()
    // then decides the daemon's follow capability and the initial repo.
    this.followMode = new FollowMode(this.client, () => this.repoPath, {
      onRepoChange: (newPath) => this.handleFollowRepoChange(newPath),
      onFileNavigate: (rawContent) => this.handleFollowFileNavigate(rawContent),
    }, this.config.watcherEnabled);
    this.followMode.start();

    // The repo session is opened in start(): POST /repos normalizes the
    // initial path to a worktree root (a bare-repo container resolves to
    // its most recently active worktree). Follow mode may open a session
    // earlier when the watched file already names a repo.

    // Initial render
    this.render();
  }

  /**
   * Display an error in the UI via the session's shared state (rendered in
   * the header, cleared on the next refresh).
   */
  private showError(message: string): void {
    this.session?.setError(message);
  }

  private setupKeyboardHandlers(): void {
    setupKeyBindings(
      this.screen,
      {
        exit: () => this.exit(),
        navigateDown: () => this.navigation.navigateDown(),
        navigateUp: () => this.navigation.navigateUp(),
        navigatePageDown: () => this.navigation.navigatePage(1),
        navigatePageUp: () => this.navigation.navigatePage(-1),
        jumpToTop: () => this.navigation.jumpToEdge(-1),
        jumpToBottom: () => this.navigation.jumpToEdge(1),
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
        openWorktreeSwitcher: () => this.openWorktreeSwitcher(),
        openThemePicker: () => this.modals.openThemePicker(),
        openHotkeysModal: () => this.modals.openHotkeysModal(),
        openBaseBranchPicker: () => this.modals.openBaseBranchPicker(),
        closeActiveModal: () => this.modals.closeActiveModal(),
        toggleMouseMode: () => this.toggleMouseMode(),
        toggleFollow: () => this.toggleFollow(),
        openDiscardConfirm: (file) => this.modals.openDiscardConfirm(file),
        render: () => this.render(),
        toggleCurrentHunk: () => this.staging.toggleCurrentHunk(),
        navigateNextHunk: () => this.navigation.navigateNextHunk(),
        navigatePrevHunk: () => this.navigation.navigatePrevHunk(),
        openCherryPickConfirm: () => this.modals.openCherryPickConfirm(),
        openRevertConfirm: () => this.modals.openRevertConfirm(),
      },
      {
        hasActiveModal: () => this.modals.hasActiveModal(),
        getActiveModalType: () => this.modals.getActiveModalType(),
        getBottomTab: () => this.uiState.state.bottomTab,
        getCurrentPane: () => this.uiState.state.currentPane,
        getFocusedZone: () => this.uiState.state.focusedZone,
        isCommitInputFocused: () => this.commitFlowState.state.inputFocused,
        getStatusFiles: () => this.session?.shared.status?.files ?? [],
        getSelectedIndex: () => this.uiState.state.selectedIndex,
        uiState: this.uiState,
        getExplorerManager: () => this.explorerManager,
        commitFlowState: this.commitFlowState,
        refreshCompare: (includeUncommitted) => {
          this.session?.refreshCompare(includeUncommitted);
        },
        layout: this.layout,
        resolveFileAtIndex: (index) =>
          resolveFile(
            index,
            this.uiState.state.flatViewMode,
            this.cachedFlatFiles,
            this.session?.shared.status?.files ?? []
          ),
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
        openHotkeysModal: () => this.modals.openHotkeysModal(),
        render: () => this.render(),
      },
      {
        uiState: this.uiState,
        getExplorerManager: () => this.explorerManager,
        getStatusFiles: () => this.session?.shared.status?.files ?? [],
        getHistoryCommitCount: () => this.session?.history.commits.length ?? 0,
        getCompareCommits: () => this.session?.compare.compareDiff?.commits ?? [],
        getCompareFiles: () => this.session?.compare.compareDiff?.files ?? [],
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
        this.session?.refreshCompare(this.uiState.state.includeUncommitted);
      } else if (tab === 'explorer') {
        // Explorer is already loaded on init, but refresh if needed
        if (!this.explorerManager?.state.displayRows.length) {
          this.explorerManager?.loadDirectory('');
        }
      }
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

  private handleFollowRepoChange(newPath: string): void {
    // POST /repos resolves the followed path to its worktree root;
    // applyRepoSwitch is a no-op when that root already matches the
    // current repo, so following a file within the active worktree stays
    // put while a path in a different worktree switches.
    this.applyRepoSwitch(newPath, { stopFollow: false });
  }

  private handleFollowFileNavigate(rawContent: string): void {
    this.navigation.navigateToFile(rawContent);
    this.render();
  }

  private recordCurrentRepo(): void {
    const max = this.config.maxRecentRepos ?? 10;
    const normalized = this.repoPath.replace(/\/$/, '');
    this.recentRepos = [
      normalized,
      ...this.recentRepos.map((r) => r.replace(/\/$/, '')).filter((r) => r !== normalized),
    ].slice(0, max);
    addRecentRepo(this.repoPath, max);
  }

  private switchToRepo(newPath: string): void {
    this.applyRepoSwitch(newPath, { stopFollow: true });
  }

  /**
   * Open `rawPath` on the daemon and make it the current repo. The daemon
   * normalizes the path (worktree root, bare-container resolution); when
   * the resolved root already matches the current session this releases
   * the duplicate open and stays put. Concurrent switches are guarded by
   * a sequence number: only the latest requested switch wins.
   */
  private async applyRepoSwitch(rawPath: string, opts: { stopFollow: boolean }): Promise<void> {
    const seq = ++this.switchSeq;
    const next = await openRepoSession(this.client, rawPath);

    const stale = seq !== this.switchSeq;
    const samePath = this.session !== null && next.repoPath === this.session.repoPath;
    if (stale || samePath) {
      next.dispose(); // release the daemon-side refcount (never rejects)
      return;
    }

    if (opts.stopFollow) this.followMode.disable();

    const old = this.session;
    this.session = next;
    this.repoPath = next.repoPath;
    old?.dispose(); // detaches listeners and DELETEs the ref (never rejects)
    this.attachSessionListeners(next);

    // Initialize explorer manager for the new repo
    this.initExplorerManager();

    // Record this repo in recent repos list
    this.recordCurrentRepo();

    if (old) {
      this.resetRepoSpecificState();
    }
    this.loadCurrentTabData();
    this.render();
  }

  /** Open the worktree switcher for the current repository (Shift+W). */
  private async openWorktreeSwitcher(): Promise<void> {
    const worktrees = ((await this.session?.listWorktrees()) ?? []).filter((w) => !w.isBare);
    if (worktrees.length === 0) return;
    this.modals.openWorktreePicker(worktrees, this.repoPath);
  }

  private attachSessionListeners(session: RepoSession): void {
    // Shared state (status/hunk counts/diffs/selection) changes
    session.on('state-change', () => {
      // Skip reconciliation while loading — the pending anchor must wait
      // for the new status to arrive before being consumed
      if (!session.shared.isLoading) {
        this.reconcileSelectionAfterStateChange();
        this.applyAutoTab();
        this.applyAutoScrollToLatestChange();
      }
      this.updateExplorerGitStatus();
      this.render();
    });

    // History changes
    session.on('history-change', () => {
      const history = session.history;
      // Auto-select first commit when history loads
      if (history.commits.length > 0 && !history.selectedCommit) {
        const state = this.uiState.state;
        if (state.bottomTab === 'history') {
          this.navigation.selectHistoryCommitByIndex(state.historySelectedIndex);
        }
      }
      this.render();
    });

    // Compare changes (diff + selection share one event on the session)
    session.on('compare-change', () => {
      this.render();
    });

    // Remote operation state changes
    session.on('remote-change', () => {
      const remoteState = session.remote;
      // Auto-clear success after 3s, error after 5s
      if (this.remoteClearTimer) clearTimeout(this.remoteClearTimer);
      if (remoteState.lastResult && !remoteState.inProgress) {
        this.remoteClearTimer = setTimeout(() => {
          this.session?.clearRemoteState();
        }, 3000);
      } else if (remoteState.error) {
        this.remoteClearTimer = setTimeout(() => {
          this.session?.clearRemoteState();
        }, 5000);
      }
      this.render();
    });
  }

  /**
   * Load history with error handling.
   */
  private loadHistory(count: number = 100): void {
    this.session?.loadHistory(count).catch((err) => {
      this.showError(`Failed to load history: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  /**
   * After git state changes, reconcile the selected file index.
   * Handles both flat mode (path-based anchoring) and categorized mode (category-based anchoring).
   */
  private reconcileSelectionAfterStateChange(): void {
    const files = this.session?.shared.status?.files ?? [];

    const pendingFlatPath = this.staging.consumePendingFlatSelectionPath();
    if (this.uiState.state.flatViewMode && pendingFlatPath) {
      const flatFiles = buildFlatFileList(files, this.session?.shared.hunkCounts ?? null);
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

    // No pending anchor — clamp to valid range and sync diff if file changed
    const currentSelected = this.session?.selection.file ?? null;
    if (this.uiState.state.flatViewMode) {
      const flatFiles = buildFlatFileList(files, this.session?.shared.hunkCounts ?? null);
      const maxIndex = flatFiles.length - 1;
      let idx = this.uiState.state.selectedIndex;
      if (maxIndex >= 0 && idx > maxIndex) {
        idx = maxIndex;
        this.uiState.setSelectedIndex(idx);
      }
      const flatEntry = getFlatFileAtIndex(flatFiles, idx);
      const fileAtIdx = flatEntry?.unstagedEntry ?? flatEntry?.stagedEntry ?? null;
      if (
        fileAtIdx &&
        (fileAtIdx.path !== currentSelected?.path || fileAtIdx.staged !== currentSelected?.staged)
      ) {
        this.navigation.selectFileByIndex(idx);
      }
    } else if (files.length > 0) {
      const maxIndex = files.length - 1;
      let idx = this.uiState.state.selectedIndex;
      if (idx > maxIndex) {
        idx = maxIndex;
        this.uiState.setSelectedIndex(idx);
      }
      const fileAtIdx = getFileAtIndex(files, idx);
      if (
        fileAtIdx &&
        (fileAtIdx.path !== currentSelected?.path || fileAtIdx.staged !== currentSelected?.staged)
      ) {
        this.navigation.selectFileByIndex(idx);
      }
    }
  }

  private initExplorerManager(): void {
    // Clean up existing manager
    if (this.explorerManager) {
      this.explorerManager.dispose();
    }

    // Create new manager with options. Explorer I/O now goes to the daemon
    // via the client, keyed by the current session's repo id (null in
    // not-a-repo mode, where tree/file calls no-op into an empty view).
    const options: Partial<ExplorerOptions> = {
      hideHidden: true,
      hideGitignored: true,
      showOnlyChanges: false,
    };
    this.explorerManager = new ExplorerViewModel(
      this.client,
      this.session?.repoId ?? null,
      this.repoPath,
      options
    );

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
    if (!this.explorerManager || !this.session) return;

    const files = this.session.shared.status?.files ?? [];
    this.explorerManager.setGitStatus(buildGitStatusMap(files));
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
      this.session?.refreshCompare(this.uiState.state.includeUncommitted);
    }
    // Diff tab data arrives with the session's SSE snapshot
    // Explorer data is loaded by initExplorerManager()
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
    const files = this.session?.shared.status?.files ?? [];
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

  /**
   * In auto mode, keep the most recently changed file on screen: whenever a
   * file's on-disk content changes (a new edit lands, or a file appears),
   * select it and reset the diff to its first hunk, then briefly flash it.
   *
   * Detection is by file mtime, so staging/selection (which don't touch the
   * working file) never trigger a jump — only real content changes do. The
   * mtime map is updated even when auto mode is off, so toggling it on later
   * doesn't jump to a stale "newest" change.
   */
  private applyAutoScrollToLatestChange(): void {
    const files = this.session?.shared.status?.files ?? [];

    const current = new Map<string, number>();
    let newest: { path: string; mtime: number } | null = null;
    for (const file of files) {
      let mtime: number;
      try {
        mtime = fs.statSync(path.join(this.repoPath, file.path)).mtimeMs;
      } catch {
        continue; // deleted/renamed file — nothing on disk to scroll to
      }
      // Collapse the staged/unstaged pair for a path to a single mtime entry.
      if (current.has(file.path)) continue;
      current.set(file.path, mtime);

      const prev = this.lastChangeMtimes.get(file.path);
      const changed = prev === undefined || mtime > prev;
      if (changed && (!newest || mtime > newest.mtime)) {
        newest = { path: file.path, mtime };
      }
    }
    this.lastChangeMtimes = current;

    if (!this.uiState.state.autoTabEnabled || !newest) return;

    // Only meaningful where the file list + diff are shown.
    const tab = this.uiState.state.bottomTab;
    if (tab !== 'diff' && tab !== 'commit') return;

    this.navigation.navigateToFile(path.join(this.repoPath, newest.path));
    this.triggerFlash(newest.path);
  }

  /** Briefly highlight the newly-changed file, then clear the highlight. */
  private triggerFlash(relativePath: string): void {
    this.flashFilePath = relativePath;
    if (this.flashTimer) clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => {
      this.flashFilePath = null;
      this.flashTimer = null;
      this.render();
    }, 900);
  }

  private toggleFollow(): void {
    // The daemon owns the hook-file watcher; a client toggle is meaningless
    // when the daemon runs --no-follow. Surface that instead of flipping a
    // switch that would silently do nothing.
    if (!this.daemonFollowEnabled) {
      this.showError('daemon follow is disabled');
      this.render();
      return;
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

    // In auto mode, keep the freshest change on screen
    this.applyScrollToFreshHunk();

    this.updateSeparators();
    this.updateFooter();
    this.screen.render();
    this.scheduleHunkTimeTick();
  }

  /**
   * Auto mode: when a hunk's content just changed, scroll the diff pane so
   * the change is on screen. Each distinct change stamp scrolls once, so the
   * user can still scroll away afterwards.
   */
  private applyScrollToFreshHunk(): void {
    if (!this.uiState.state.autoTabEnabled) return;
    if (this.uiState.state.bottomTab !== 'diff') return;

    let freshest: HunkBoundary | null = null;
    for (const boundary of this.bottomPaneHunkBoundaries) {
      if (boundary.editedAt && (!freshest || boundary.editedAt > (freshest.editedAt ?? 0))) {
        freshest = boundary;
      }
    }
    if (!freshest?.editedAt) return;
    if (Date.now() - freshest.editedAt >= HUNK_FLASH_MS) return;
    if (freshest.editedAt === this.lastFreshHunkScroll) return;
    this.lastFreshHunkScroll = freshest.editedAt;

    const visibleHeight = this.layout.dimensions.bottomPaneHeight;
    const offset = this.uiState.state.diffScrollOffset;
    if (freshest.startRow < offset || freshest.startRow >= offset + visibleHeight) {
      const maxOffset = Math.max(0, this.bottomPaneTotalRows - visibleHeight);
      this.uiState.setDiffScrollOffset(Math.min(freshest.startRow, maxOffset));
      this.updateBottomPane();
    }
  }

  /**
   * Schedule the next time-driven re-render for the hunk edit-time display.
   * Cadence adapts to the youngest visible hunk: 1s while any hunk is under
   * a minute old (its "N seconds ago" text changes every second, and the
   * yellow flash needs clearing), 60s while only minute-or-older
   * granularities are on screen. Every render reschedules, so the tick
   * follows tab switches and diff changes without extra bookkeeping.
   */
  private scheduleHunkTimeTick(): void {
    if (this.hunkTimeTick) {
      clearTimeout(this.hunkTimeTick);
      this.hunkTimeTick = null;
    }

    const tab = this.uiState.state.bottomTab;
    if (tab !== 'diff' && tab !== 'commit') return;
    const selection = this.session?.selection;
    if (!selection) return;

    let newest = 0;
    const scan = (lines?: { type: string; editedAt?: number }[]): void => {
      for (const line of lines ?? []) {
        if (line.type === 'hunk' && line.editedAt && line.editedAt > newest) {
          newest = line.editedAt;
        }
      }
    };
    scan(selection.diff?.lines);
    scan(selection.combined?.unstaged.lines);
    scan(selection.combined?.staged.lines);
    if (newest === 0) return;

    const age = Date.now() - newest;
    const delay = age < 60_000 ? 1_000 : 60_000;
    this.hunkTimeTick = setTimeout(() => {
      this.hunkTimeTick = null;
      this.render();
    }, delay);
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
    const shared = this.session?.shared;
    const width = (this.screen.width as number) || 80;

    const content = formatHeader(
      this.repoPath,
      shared?.status?.branch ?? null,
      shared?.isLoading ?? true,
      shared?.error ?? null,
      width,
      this.session?.remote ?? null
    );

    this.layout.headerBox.setContent(content);
  }

  private updateTopPane(): void {
    const state = this.uiState.state;
    const width = (this.screen.width as number) || 80;
    const files = this.session?.shared.status?.files ?? [];

    // Build and cache flat file list when in flat mode
    if (state.flatViewMode) {
      this.cachedFlatFiles = buildFlatFileList(files, this.session?.shared.hunkCounts ?? null);
    }

    const content = renderTopPane(
      state,
      files,
      this.session?.history.commits ?? [],
      this.session?.compare.compareDiff ?? null,
      this.navigation.compareSelection,
      this.explorerManager?.state,
      width,
      this.layout.dimensions.topPaneHeight,
      this.session?.shared.hunkCounts,
      state.flatViewMode ? this.cachedFlatFiles : undefined,
      this.flashFilePath
    );

    this.layout.topPane.setContent(content);
  }

  private updateBottomPane(): void {
    const state = this.uiState.state;
    const width = (this.screen.width as number) || 80;
    const files = this.session?.shared.status?.files ?? [];
    const stagedCount = files.filter((f) => f.staged).length;

    // Update staged count for commit validation
    this.commitFlowState.setStagedCount(stagedCount);

    // Pass selectedHunkIndex and staged status only when diff pane is focused on diff tab
    const diffPaneFocused = state.bottomTab === 'diff' && state.currentPane === 'diff';
    const hunkIndex = diffPaneFocused ? state.selectedHunkIndex : undefined;
    const isFileStaged = diffPaneFocused ? this.session?.selection.file?.staged : undefined;

    const { content, totalRows, hunkCount, hunkBoundaries, hunkMapping } = renderBottomPane(
      state,
      this.session?.selection.diff ?? null,
      this.session?.history,
      this.session?.compare.selection,
      this.explorerManager?.state?.selectedFile ?? null,
      this.commitFlowState.state,
      stagedCount,
      this.currentTheme,
      width,
      this.layout.dimensions.bottomPaneHeight,
      hunkIndex,
      isFileStaged,
      state.flatViewMode ? this.session?.selection.combined : undefined,
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
      this.followMode.isEnabled,
      this.explorerManager?.showOnlyChanges ?? false,
      width,
      state.currentPane
    );

    this.layout.footerBox.setContent(content);
  }

  /**
   * Exit the application cleanly. The session's dispose (DELETE /repos —
   * the daemon-side refcount release) is started here and awaited in
   * start() before the process ends. The daemon itself is never stopped.
   */
  exit(): void {
    // Clean up
    this.exitDispose = this.session?.dispose() ?? Promise.resolve();
    this.session = null;
    if (this.explorerManager) {
      this.explorerManager.dispose();
    }
    this.followMode.dispose();
    if (this.remoteClearTimer) {
      clearTimeout(this.remoteClearTimer);
    }
    if (this.flashTimer) {
      clearTimeout(this.flashTimer);
    }
    if (this.hunkTimeTick) {
      clearTimeout(this.hunkTimeTick);
    }

    // Destroy screen (this will clean up terminal)
    this.screen.destroy();
  }

  /**
   * Start the application (returns when app exits).
   */
  async start(): Promise<void> {
    // The daemon owns follow mode; ask it whether follow is enabled (false
    // under --no-follow) so the toggle can refuse cleanly, and where it is
    // currently pointed so we open that repo instead of cwd at startup.
    try {
      const follow = await this.client.getFollow();
      this.daemonFollowEnabled = follow.enabled;
      if (this.followMode.isEnabled && follow.enabled && follow.followedPath) {
        await this.applyRepoSwitch(follow.followedPath, { stopFollow: false });
      }
    } catch {
      // Follow is best-effort; a failed probe leaves it disabled and falls
      // through to opening the initial path below.
    }

    // Open the initial path when the follow probe didn't already open one.
    if (this.session === null && this.switchSeq === 0) {
      await this.applyRepoSwitch(this.repoPath, { stopFollow: false });
    }
    await new Promise<void>((resolve) => {
      this.screen.on('destroy', () => {
        resolve();
      });
    });
    // Release the daemon-side repo ref before the process exits.
    await (this.exitDispose ?? Promise.resolve());
  }
}
