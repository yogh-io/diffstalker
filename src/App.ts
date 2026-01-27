import blessed from 'neo-blessed';
import type { Widgets } from 'blessed';
import { LayoutManager, SPLIT_RATIO_STEP } from './ui/Layout.js';
import { formatHeader, getHeaderHeight, type WatcherState } from './ui/widgets/Header.js';
import { formatFooter } from './ui/widgets/Footer.js';
import {
  formatFileList,
  getFileAtIndex,
  getFileListTotalRows,
  getFileIndexFromRow,
} from './ui/widgets/FileList.js';
import { formatDiff, formatHistoryDiff } from './ui/widgets/DiffView.js';
import { formatCommitPanel, formatCommitPanelInactive } from './ui/widgets/CommitPanel.js';
import {
  formatHistoryView,
  getHistoryTotalRows,
  getCommitAtIndex,
} from './ui/widgets/HistoryView.js';
import {
  formatCompareListView,
  getCompareListTotalRows,
  getNextCompareSelection,
  getRowFromCompareSelection,
  getCompareSelectionFromRow,
  type CompareListSelection,
} from './ui/widgets/CompareListView.js';
import {
  formatExplorerView,
  formatBreadcrumbs,
  getExplorerTotalRows,
} from './ui/widgets/ExplorerView.js';
import {
  formatExplorerContent,
  getExplorerContentTotalRows,
} from './ui/widgets/ExplorerContent.js';
import {
  ExplorerStateManager,
  ExplorerState,
  ExplorerOptions,
} from './core/ExplorerStateManager.js';
import { ThemePicker } from './ui/modals/ThemePicker.js';
import { HotkeysModal } from './ui/modals/HotkeysModal.js';
import { BaseBranchPicker } from './ui/modals/BaseBranchPicker.js';
import { DiscardConfirm } from './ui/modals/DiscardConfirm.js';
import { CommitFlowState } from './state/CommitFlowState.js';
import { UIState, Pane } from './state/UIState.js';
import {
  GitStateManager,
  getManagerForRepo,
  removeManagerForRepo,
  HistoryState,
  CompareState,
  CompareSelectionState,
} from './core/GitStateManager.js';
import { FilePathWatcher, WatcherState as FileWatcherState } from './core/FilePathWatcher.js';
import { Config, saveConfig } from './config.js';
import type { FileEntry } from './git/status.js';
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
  private fileWatcher: FilePathWatcher | null = null;
  private explorerManager: ExplorerStateManager | null = null;
  private config: Config;
  private commandServer: CommandServer | null;

  // Current state
  private repoPath: string;
  private watcherState: WatcherState = { enabled: false };
  private currentTheme: ThemeName;

  // Commit flow state
  private commitFlowState: CommitFlowState;
  private commitTextarea: Widgets.TextareaElement | null = null;

  // Active modals
  private activeModal: ThemePicker | HotkeysModal | BaseBranchPicker | DiscardConfirm | null = null;

  // Cached total rows for scroll bounds (single source of truth from render)
  private bottomPaneTotalRows: number = 0;

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
        focus: {
          border: {
            fg: 'cyan',
          },
        },
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
    this.setupMouseHandlers();

    // Setup state change listeners
    this.setupStateListeners();

    // Setup file watcher if enabled
    if (this.config.watcherEnabled) {
      this.setupFileWatcher();
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
    // Quit
    this.screen.key(['q', 'C-c'], () => {
      this.exit();
    });

    // Navigation (skip if modal is open - modal handles its own keys)
    this.screen.key(['j', 'down'], () => {
      if (this.activeModal) return;
      this.navigateDown();
    });

    this.screen.key(['k', 'up'], () => {
      if (this.activeModal) return;
      this.navigateUp();
    });

    // Tab switching (skip if modal is open)
    this.screen.key(['1'], () => {
      if (this.activeModal) return;
      this.uiState.setTab('diff');
    });
    this.screen.key(['2'], () => {
      if (this.activeModal) return;
      this.uiState.setTab('commit');
    });
    this.screen.key(['3'], () => {
      if (this.activeModal) return;
      this.uiState.setTab('history');
    });
    this.screen.key(['4'], () => {
      if (this.activeModal) return;
      this.uiState.setTab('compare');
    });
    this.screen.key(['5'], () => {
      if (this.activeModal) return;
      this.uiState.setTab('explorer');
    });

    // Pane toggle (skip if modal is open)
    this.screen.key(['tab'], () => {
      if (this.activeModal) return;
      this.uiState.togglePane();
    });

    // Staging operations (skip if modal is open)
    this.screen.key(['s'], () => {
      if (this.activeModal) return;
      this.stageSelected();
    });
    this.screen.key(['S-u'], () => {
      if (this.activeModal) return;
      this.unstageSelected();
    });
    this.screen.key(['S-a'], () => {
      if (this.activeModal) return;
      this.stageAll();
    });
    this.screen.key(['S-z'], () => {
      if (this.activeModal) return;
      this.unstageAll();
    });

    // Select/toggle (skip if modal is open)
    this.screen.key(['enter', 'space'], () => {
      if (this.activeModal) return;
      const state = this.uiState.state;
      if (state.bottomTab === 'explorer' && state.currentPane === 'explorer') {
        this.enterExplorerDirectory();
      } else {
        this.toggleSelected();
      }
    });

    // Explorer: go up directory (skip if modal is open)
    this.screen.key(['backspace'], () => {
      if (this.activeModal) return;
      const state = this.uiState.state;
      if (state.bottomTab === 'explorer' && state.currentPane === 'explorer') {
        this.goExplorerUp();
      }
    });

    // Commit (skip if modal is open)
    this.screen.key(['c'], () => {
      if (this.activeModal) return;
      this.uiState.setTab('commit');
    });

    // Commit panel specific keys (only when on commit tab)
    this.screen.key(['i'], () => {
      if (this.uiState.state.bottomTab === 'commit' && !this.commitFlowState.state.inputFocused) {
        this.focusCommitInput();
      }
    });

    this.screen.key(['a'], () => {
      if (this.uiState.state.bottomTab === 'commit' && !this.commitFlowState.state.inputFocused) {
        this.commitFlowState.toggleAmend();
        this.render();
      }
    });

    this.screen.key(['escape'], () => {
      if (this.uiState.state.bottomTab === 'commit') {
        if (this.commitFlowState.state.inputFocused) {
          this.unfocusCommitInput();
        } else {
          this.uiState.setTab('diff');
        }
      }
    });

    // Refresh
    this.screen.key(['r'], () => this.refresh());

    // Display toggles
    this.screen.key(['w'], () => this.uiState.toggleWrapMode());
    this.screen.key(['m'], () => this.toggleMouseMode());
    this.screen.key(['S-t'], () => this.uiState.toggleAutoTab());

    // Split ratio adjustments
    this.screen.key(['-', '_'], () => {
      this.uiState.adjustSplitRatio(-SPLIT_RATIO_STEP);
      this.layout.setSplitRatio(this.uiState.state.splitRatio);
      this.render();
    });

    this.screen.key(['=', '+'], () => {
      this.uiState.adjustSplitRatio(SPLIT_RATIO_STEP);
      this.layout.setSplitRatio(this.uiState.state.splitRatio);
      this.render();
    });

    // Theme picker
    this.screen.key(['t'], () => this.uiState.openModal('theme'));

    // Hotkeys modal
    this.screen.key(['?'], () => this.uiState.toggleModal('hotkeys'));

    // Follow toggle
    this.screen.key(['f'], () => this.toggleFollow());

    // Compare view: base branch picker
    this.screen.key(['b'], () => {
      if (this.uiState.state.bottomTab === 'compare') {
        this.uiState.openModal('baseBranch');
      }
    });

    // Compare view: toggle uncommitted
    this.screen.key(['u'], () => {
      if (this.uiState.state.bottomTab === 'compare') {
        this.uiState.toggleIncludeUncommitted();
        const includeUncommitted = this.uiState.state.includeUncommitted;
        this.gitManager?.refreshCompareDiff(includeUncommitted);
      }
    });

    // Discard changes (with confirmation)
    this.screen.key(['d'], () => {
      if (this.uiState.state.bottomTab === 'diff') {
        const files = this.gitManager?.state.status?.files ?? [];
        const selectedIndex = this.uiState.state.selectedIndex;
        const selectedFile = files[selectedIndex];
        // Only allow discard for unstaged modified files
        if (selectedFile && !selectedFile.staged && selectedFile.status !== 'untracked') {
          this.showDiscardConfirm(selectedFile);
        }
      }
    });
  }

  private setupMouseHandlers(): void {
    const SCROLL_AMOUNT = 3;

    // Mouse wheel on top pane
    this.layout.topPane.on('wheeldown', () => {
      this.handleTopPaneScroll(SCROLL_AMOUNT);
    });

    this.layout.topPane.on('wheelup', () => {
      this.handleTopPaneScroll(-SCROLL_AMOUNT);
    });

    // Mouse wheel on bottom pane
    this.layout.bottomPane.on('wheeldown', () => {
      this.handleBottomPaneScroll(SCROLL_AMOUNT);
    });

    this.layout.bottomPane.on('wheelup', () => {
      this.handleBottomPaneScroll(-SCROLL_AMOUNT);
    });

    // Click on top pane to select item
    this.layout.topPane.on('click', (mouse: { x: number; y: number }) => {
      // Convert screen Y to pane-relative row (blessed click coords are screen-relative)
      const clickedRow = this.layout.screenYToTopPaneRow(mouse.y);
      if (clickedRow >= 0) {
        this.handleTopPaneClick(clickedRow);
      }
    });

    // Click on footer for tabs and toggles
    this.layout.footerBox.on('click', (mouse: { x: number; y: number }) => {
      this.handleFooterClick(mouse.x);
    });
  }

  private handleTopPaneClick(row: number): void {
    const state = this.uiState.state;

    if (state.bottomTab === 'history') {
      const index = state.historyScrollOffset + row;
      this.uiState.setHistorySelectedIndex(index);
      this.selectHistoryCommitByIndex(index);
    } else if (state.bottomTab === 'compare') {
      // For compare view, need to map row to selection
      const compareState = this.gitManager?.compareState;
      const commits = compareState?.compareDiff?.commits ?? [];
      const files = compareState?.compareDiff?.files ?? [];
      const selection = getCompareSelectionFromRow(state.compareScrollOffset + row, commits, files);
      if (selection) {
        this.selectCompareItem(selection);
      }
    } else if (state.bottomTab === 'explorer') {
      const index = state.explorerScrollOffset + row;
      this.explorerManager?.selectIndex(index);
      this.uiState.setExplorerSelectedIndex(index);
    } else {
      // Diff tab - select file
      const files = this.gitManager?.state.status?.files ?? [];
      // Account for section headers in file list
      const fileIndex = getFileIndexFromRow(row + state.fileListScrollOffset, files);
      if (fileIndex !== null && fileIndex >= 0) {
        this.uiState.setSelectedIndex(fileIndex);
        this.selectFileByIndex(fileIndex);
      }
    }
  }

  private handleFooterClick(x: number): void {
    const width = (this.screen.width as number) || 80;

    // Footer layout: left side has toggles, right side has tabs
    // Tabs are right-aligned, so we calculate from the right
    // Tab format: [1]Diff [2]Commit [3]History [4]Compare [5]Explorer
    // Approximate positions from right edge
    const tabPositions = [
      { tab: 'explorer' as const, label: '[5]Explorer', width: 11 },
      { tab: 'compare' as const, label: '[4]Compare', width: 10 },
      { tab: 'history' as const, label: '[3]History', width: 10 },
      { tab: 'commit' as const, label: '[2]Commit', width: 9 },
      { tab: 'diff' as const, label: '[1]Diff', width: 7 },
    ];

    let rightEdge = width;
    for (const { tab, width: tabWidth } of tabPositions) {
      const leftEdge = rightEdge - tabWidth - 1; // -1 for space
      if (x >= leftEdge && x < rightEdge) {
        this.uiState.setTab(tab);
        return;
      }
      rightEdge = leftEdge;
    }

    // Left side toggles (approximate positions)
    // Format: ? [scroll] [auto] [wrap] [dots]
    if (x >= 2 && x <= 9) {
      // [scroll] or m:[select]
      this.toggleMouseMode();
    } else if (x >= 11 && x <= 16) {
      // [auto]
      this.uiState.toggleAutoTab();
    } else if (x >= 18 && x <= 23) {
      // [wrap]
      this.uiState.toggleWrapMode();
    } else if (x >= 25 && x <= 30 && this.uiState.state.bottomTab === 'explorer') {
      // [dots] - only visible in explorer
      this.uiState.toggleMiddleDots();
    } else if (x === 0) {
      // ? - open hotkeys
      this.uiState.openModal('hotkeys');
    }
  }

  private handleTopPaneScroll(delta: number): void {
    const state = this.uiState.state;
    const visibleHeight = this.layout.dimensions.topPaneHeight;

    if (state.bottomTab === 'history') {
      const totalRows = this.gitManager?.historyState.commits.length ?? 0;
      const maxOffset = Math.max(0, totalRows - visibleHeight);
      const newOffset = Math.min(maxOffset, Math.max(0, state.historyScrollOffset + delta));
      this.uiState.setHistoryScrollOffset(newOffset);
    } else if (state.bottomTab === 'compare') {
      const compareState = this.gitManager?.compareState;
      const totalRows = getCompareListTotalRows(
        compareState?.compareDiff?.commits ?? [],
        compareState?.compareDiff?.files ?? []
      );
      const maxOffset = Math.max(0, totalRows - visibleHeight);
      const newOffset = Math.min(maxOffset, Math.max(0, state.compareScrollOffset + delta));
      this.uiState.setCompareScrollOffset(newOffset);
    } else if (state.bottomTab === 'explorer') {
      const totalRows = getExplorerTotalRows(this.explorerManager?.state.items ?? []);
      const maxOffset = Math.max(0, totalRows - visibleHeight);
      const newOffset = Math.min(maxOffset, Math.max(0, state.explorerScrollOffset + delta));
      this.uiState.setExplorerScrollOffset(newOffset);
    } else {
      const files = this.gitManager?.state.status?.files ?? [];
      const totalRows = getFileListTotalRows(files);
      const maxOffset = Math.max(0, totalRows - visibleHeight);
      const newOffset = Math.min(maxOffset, Math.max(0, state.fileListScrollOffset + delta));
      this.uiState.setFileListScrollOffset(newOffset);
    }
  }

  private handleBottomPaneScroll(delta: number): void {
    const state = this.uiState.state;
    const visibleHeight = this.layout.dimensions.bottomPaneHeight;
    const width = (this.screen.width as number) || 80;

    if (state.bottomTab === 'explorer') {
      const selectedFile = this.explorerManager?.state.selectedFile;
      const totalRows = getExplorerContentTotalRows(
        selectedFile?.content ?? null,
        selectedFile?.path ?? null,
        selectedFile?.truncated ?? false,
        width,
        state.wrapMode
      );
      const maxOffset = Math.max(0, totalRows - visibleHeight);
      const newOffset = Math.min(maxOffset, Math.max(0, state.explorerFileScrollOffset + delta));
      this.uiState.setExplorerFileScrollOffset(newOffset);
    } else {
      // Use cached totalRows from last render (single source of truth)
      const maxOffset = Math.max(0, this.bottomPaneTotalRows - visibleHeight);
      const newOffset = Math.min(maxOffset, Math.max(0, state.diffScrollOffset + delta));
      this.uiState.setDiffScrollOffset(newOffset);
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
        if (!this.explorerManager?.state.items.length) {
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

  private setupFileWatcher(): void {
    this.fileWatcher = new FilePathWatcher(this.config.targetFile);

    this.fileWatcher.on('path-change', (state: FileWatcherState) => {
      if (state.path && state.path !== this.repoPath) {
        this.repoPath = state.path;
        this.watcherState = {
          enabled: true,
          sourceFile: state.sourceFile ?? this.config.targetFile,
          rawContent: state.rawContent ?? undefined,
          lastUpdate: state.lastUpdate ?? undefined,
        };
        this.initGitManager();
        this.render();
      }
      // Navigate to the followed file if it's within the repo
      if (state.rawContent) {
        this.navigateToFile(state.rawContent);
        this.render();
      }
    });

    this.watcherState = {
      enabled: true,
      sourceFile: this.config.targetFile,
    };

    this.fileWatcher.start();

    // Navigate to the initially followed file
    const initialState = this.fileWatcher.state;
    if (initialState.rawContent) {
      this.watcherState.rawContent = initialState.rawContent;
      this.navigateToFile(initialState.rawContent);
    }
  }

  private initGitManager(): void {
    // Clean up existing manager
    if (this.gitManager) {
      this.gitManager.removeAllListeners();
      removeManagerForRepo(this.repoPath);
    }

    // Get or create manager for this repo
    this.gitManager = getManagerForRepo(this.repoPath);

    // Listen to state changes
    this.gitManager.on('state-change', () => {
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
    const options: ExplorerOptions = {
      hideHidden: true,
      hideGitignored: true,
    };
    this.explorerManager = new ExplorerStateManager(this.repoPath, options);

    // Listen to state changes
    this.explorerManager.on('state-change', () => {
      this.render();
    });

    // Load root directory
    this.explorerManager.loadDirectory('');
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
      const newIndex = Math.max(0, state.selectedIndex - 1);
      this.uiState.setSelectedIndex(newIndex);
      this.selectFileByIndex(newIndex);
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
    const items = this.explorerManager?.state.items ?? [];

    if (items.length === 0) return;

    const newScrollOffset = this.explorerManager?.navigateUp(state.explorerScrollOffset);
    if (newScrollOffset !== null && newScrollOffset !== undefined) {
      this.uiState.setExplorerScrollOffset(newScrollOffset);
    }
    this.uiState.setExplorerSelectedIndex(this.explorerManager?.state.selectedIndex ?? 0);
  }

  private navigateExplorerDown(): void {
    const state = this.uiState.state;
    const items = this.explorerManager?.state.items ?? [];

    if (items.length === 0) return;

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
    this.uiState.setExplorerScrollOffset(0);
    this.uiState.setExplorerFileScrollOffset(0);
    this.uiState.setExplorerSelectedIndex(0);
  }

  private async goExplorerUp(): Promise<void> {
    await this.explorerManager?.goUp();
    this.uiState.setExplorerScrollOffset(0);
    this.uiState.setExplorerFileScrollOffset(0);
    this.uiState.setExplorerSelectedIndex(0);
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
    const selectedFile = files[this.uiState.state.selectedIndex];
    if (selectedFile && !selectedFile.staged) {
      await this.gitManager?.stage(selectedFile);
    }
  }

  private async unstageSelected(): Promise<void> {
    const files = this.gitManager?.state.status?.files ?? [];
    const selectedFile = files[this.uiState.state.selectedIndex];
    if (selectedFile?.staged) {
      await this.gitManager?.unstage(selectedFile);
    }
  }

  private async toggleSelected(): Promise<void> {
    const files = this.gitManager?.state.status?.files ?? [];
    const selectedFile = files[this.uiState.state.selectedIndex];
    if (selectedFile) {
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
    const program = (this.screen as any).program;
    if (willEnable) {
      program.enableMouse();
    } else {
      program.disableMouse();
    }
  }

  private toggleFollow(): void {
    if (this.fileWatcher) {
      this.fileWatcher.stop();
      this.fileWatcher = null;
      this.watcherState = { enabled: false };
    } else {
      this.setupFileWatcher();
    }
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
      this.watcherState,
      width
    );

    this.layout.headerBox.setContent(content);
  }

  private updateTopPane(): void {
    const gitState = this.gitManager?.state;
    const historyState = this.gitManager?.historyState;
    const compareState = this.gitManager?.compareState;
    const files = gitState?.status?.files ?? [];
    const state = this.uiState.state;
    const width = (this.screen.width as number) || 80;

    let content: string;

    if (state.bottomTab === 'history') {
      const commits = historyState?.commits ?? [];
      content = formatHistoryView(
        commits,
        state.historySelectedIndex,
        state.currentPane === 'history',
        width,
        state.historyScrollOffset,
        this.layout.dimensions.topPaneHeight
      );
    } else if (state.bottomTab === 'compare') {
      const compareDiff = compareState?.compareDiff;
      const commits = compareDiff?.commits ?? [];
      const compareFiles = compareDiff?.files ?? [];

      content = formatCompareListView(
        commits,
        compareFiles,
        this.compareSelection,
        state.currentPane === 'compare',
        width,
        state.compareScrollOffset,
        this.layout.dimensions.topPaneHeight
      );
    } else if (state.bottomTab === 'explorer') {
      const explorerState = this.explorerManager?.state;
      const items = explorerState?.items ?? [];

      content = formatExplorerView(
        items,
        state.explorerSelectedIndex,
        state.currentPane === 'explorer',
        width,
        state.explorerScrollOffset,
        this.layout.dimensions.topPaneHeight,
        explorerState?.isLoading ?? false,
        explorerState?.error ?? null
      );
    } else {
      content = formatFileList(
        files,
        state.selectedIndex,
        state.currentPane === 'files',
        width,
        state.fileListScrollOffset,
        this.layout.dimensions.topPaneHeight
      );
    }

    this.layout.topPane.setContent(content);
  }

  private updateBottomPane(): void {
    const gitState = this.gitManager?.state;
    const historyState = this.gitManager?.historyState;
    const diff = gitState?.diff ?? null;
    const state = this.uiState.state;
    const width = (this.screen.width as number) || 80;
    const files = gitState?.status?.files ?? [];
    const stagedCount = files.filter((f) => f.staged).length;

    // Update staged count for commit validation
    this.commitFlowState.setStagedCount(stagedCount);

    // Show appropriate content based on tab
    if (state.bottomTab === 'commit') {
      const commitContent = formatCommitPanel(this.commitFlowState.state, stagedCount, width);
      this.layout.bottomPane.setContent(commitContent);

      // Show/hide textarea based on focus
      if (this.commitTextarea) {
        if (this.commitFlowState.state.inputFocused) {
          this.commitTextarea.show();
        } else {
          this.commitTextarea.hide();
        }
      }
    } else if (state.bottomTab === 'history') {
      // Hide commit textarea when not on commit tab
      if (this.commitTextarea) {
        this.commitTextarea.hide();
      }

      const selectedCommit = historyState?.selectedCommit ?? null;
      const commitDiff = historyState?.commitDiff ?? null;

      const { content, totalRows } = formatHistoryDiff(
        selectedCommit,
        commitDiff,
        width,
        state.diffScrollOffset,
        this.layout.dimensions.bottomPaneHeight,
        this.currentTheme,
        state.wrapMode
      );

      this.bottomPaneTotalRows = totalRows;
      this.layout.bottomPane.setContent(content);
    } else if (state.bottomTab === 'compare') {
      // Hide commit textarea when not on commit tab
      if (this.commitTextarea) {
        this.commitTextarea.hide();
      }

      const compareSelectionState = this.gitManager?.compareSelectionState;
      const compareDiff = compareSelectionState?.diff ?? null;

      if (compareDiff) {
        const { content, totalRows } = formatDiff(
          compareDiff,
          width,
          state.diffScrollOffset,
          this.layout.dimensions.bottomPaneHeight,
          this.currentTheme,
          state.wrapMode
        );
        this.bottomPaneTotalRows = totalRows;
        this.layout.bottomPane.setContent(content);
      } else {
        this.bottomPaneTotalRows = 0;
        this.layout.bottomPane.setContent(
          '{gray-fg}Select a commit or file to view diff{/gray-fg}'
        );
      }
    } else if (state.bottomTab === 'explorer') {
      // Hide commit textarea when not on commit tab
      if (this.commitTextarea) {
        this.commitTextarea.hide();
      }

      const explorerState = this.explorerManager?.state;
      const selectedFile = explorerState?.selectedFile ?? null;

      const content = formatExplorerContent(
        selectedFile?.path ?? null,
        selectedFile?.content ?? null,
        width,
        state.explorerFileScrollOffset,
        this.layout.dimensions.bottomPaneHeight,
        selectedFile?.truncated ?? false,
        state.wrapMode,
        state.showMiddleDots
      );

      // TODO: formatExplorerContent should also return totalRows
      this.layout.bottomPane.setContent(content);
    } else {
      // Hide commit textarea when not on commit tab
      if (this.commitTextarea) {
        this.commitTextarea.hide();
      }

      const { content, totalRows } = formatDiff(
        diff,
        width,
        state.diffScrollOffset,
        this.layout.dimensions.bottomPaneHeight,
        this.currentTheme,
        state.wrapMode
      );

      this.bottomPaneTotalRows = totalRows;
      this.layout.bottomPane.setContent(content);
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
      state.showMiddleDots,
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
    if (this.fileWatcher) {
      this.fileWatcher.stop();
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
