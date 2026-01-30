import { EventEmitter } from 'node:events';
import type { BottomTab } from '../types/tabs.js';
import type { FileEntry } from '../git/status.js';

export type Pane = 'files' | 'diff' | 'commit' | 'history' | 'compare' | 'explorer';

export interface UIStateData {
  // Navigation
  currentPane: Pane;
  bottomTab: BottomTab;
  selectedIndex: number;

  // Scroll offsets
  fileListScrollOffset: number;
  diffScrollOffset: number;
  historyScrollOffset: number;
  compareScrollOffset: number;
  explorerScrollOffset: number;
  explorerFileScrollOffset: number;

  // History state
  historySelectedIndex: number;

  // Compare state
  compareSelectedIndex: number;
  includeUncommitted: boolean;

  // Explorer state
  explorerSelectedIndex: number;

  // Display options
  wrapMode: boolean;
  autoTabEnabled: boolean;
  mouseEnabled: boolean;
  hideHiddenFiles: boolean;
  hideGitignored: boolean;

  // Split ratio
  splitRatio: number;

  // Modal state
  activeModal: 'theme' | 'hotkeys' | 'baseBranch' | null;
  pendingDiscard: FileEntry | null;

  // Text input focus
  commitInputFocused: boolean;
}

type UIStateEventMap = {
  change: [UIStateData];
  'pane-change': [Pane];
  'tab-change': [BottomTab];
  'selection-change': [number];
  'scroll-change': [{ type: string; offset: number }];
  'modal-change': ['theme' | 'hotkeys' | 'baseBranch' | null];
};

const DEFAULT_STATE: UIStateData = {
  currentPane: 'files',
  bottomTab: 'diff',
  selectedIndex: 0,
  fileListScrollOffset: 0,
  diffScrollOffset: 0,
  historyScrollOffset: 0,
  compareScrollOffset: 0,
  explorerScrollOffset: 0,
  explorerFileScrollOffset: 0,
  historySelectedIndex: 0,
  compareSelectedIndex: 0,
  includeUncommitted: false,
  explorerSelectedIndex: 0,
  wrapMode: false,
  autoTabEnabled: false,
  mouseEnabled: true,
  hideHiddenFiles: true,
  hideGitignored: true,
  splitRatio: 0.4,
  activeModal: null,
  pendingDiscard: null,
  commitInputFocused: false,
};

/**
 * UIState manages all UI-related state independently of React.
 * It emits events when state changes so widgets can update.
 */
export class UIState extends EventEmitter<UIStateEventMap> {
  private _state: UIStateData;

  constructor(initialState: Partial<UIStateData> = {}) {
    super();
    this._state = { ...DEFAULT_STATE, ...initialState };
  }

  get state(): UIStateData {
    return this._state;
  }

  private update(partial: Partial<UIStateData>): void {
    this._state = { ...this._state, ...partial };
    this.emit('change', this._state);
  }

  // Navigation
  setPane(pane: Pane): void {
    if (this._state.currentPane !== pane) {
      this.update({ currentPane: pane });
      this.emit('pane-change', pane);
    }
  }

  setTab(tab: BottomTab): void {
    if (this._state.bottomTab !== tab) {
      // Map tab to appropriate pane
      const paneMap: Record<BottomTab, Pane> = {
        diff: 'files',
        commit: 'commit',
        history: 'history',
        compare: 'compare',
        explorer: 'explorer',
      };
      this.update({
        bottomTab: tab,
        currentPane: paneMap[tab],
      });
      this.emit('tab-change', tab);
    }
  }

  setSelectedIndex(index: number): void {
    if (this._state.selectedIndex !== index) {
      this.update({ selectedIndex: index });
      this.emit('selection-change', index);
    }
  }

  // Scroll operations
  setFileListScrollOffset(offset: number): void {
    this.update({ fileListScrollOffset: Math.max(0, offset) });
    this.emit('scroll-change', { type: 'fileList', offset });
  }

  setDiffScrollOffset(offset: number): void {
    this.update({ diffScrollOffset: Math.max(0, offset) });
    this.emit('scroll-change', { type: 'diff', offset });
  }

  setHistoryScrollOffset(offset: number): void {
    this.update({ historyScrollOffset: Math.max(0, offset) });
    this.emit('scroll-change', { type: 'history', offset });
  }

  setCompareScrollOffset(offset: number): void {
    this.update({ compareScrollOffset: Math.max(0, offset) });
    this.emit('scroll-change', { type: 'compare', offset });
  }

  setExplorerScrollOffset(offset: number): void {
    this.update({ explorerScrollOffset: Math.max(0, offset) });
    this.emit('scroll-change', { type: 'explorer', offset });
  }

  setExplorerFileScrollOffset(offset: number): void {
    this.update({ explorerFileScrollOffset: Math.max(0, offset) });
    this.emit('scroll-change', { type: 'explorerFile', offset });
  }

  // History navigation
  setHistorySelectedIndex(index: number): void {
    this.update({ historySelectedIndex: Math.max(0, index) });
  }

  // Compare navigation
  setCompareSelectedIndex(index: number): void {
    this.update({ compareSelectedIndex: Math.max(0, index) });
  }

  toggleIncludeUncommitted(): void {
    this.update({ includeUncommitted: !this._state.includeUncommitted });
  }

  // Explorer navigation
  setExplorerSelectedIndex(index: number): void {
    this.update({ explorerSelectedIndex: Math.max(0, index) });
  }

  // Display toggles
  toggleWrapMode(): void {
    this.update({ wrapMode: !this._state.wrapMode, diffScrollOffset: 0 });
  }

  toggleAutoTab(): void {
    this.update({ autoTabEnabled: !this._state.autoTabEnabled });
  }

  toggleMouse(): void {
    this.update({ mouseEnabled: !this._state.mouseEnabled });
  }

  toggleHideHiddenFiles(): void {
    this.update({ hideHiddenFiles: !this._state.hideHiddenFiles });
  }

  toggleHideGitignored(): void {
    this.update({ hideGitignored: !this._state.hideGitignored });
  }

  // Split ratio
  adjustSplitRatio(delta: number): void {
    const newRatio = Math.min(0.85, Math.max(0.15, this._state.splitRatio + delta));
    this.update({ splitRatio: newRatio });
  }

  setSplitRatio(ratio: number): void {
    this.update({ splitRatio: Math.min(0.85, Math.max(0.15, ratio)) });
  }

  // Modals
  openModal(modal: 'theme' | 'hotkeys' | 'baseBranch'): void {
    this.update({ activeModal: modal });
    this.emit('modal-change', modal);
  }

  closeModal(): void {
    this.update({ activeModal: null });
    this.emit('modal-change', null);
  }

  toggleModal(modal: 'theme' | 'hotkeys' | 'baseBranch'): void {
    if (this._state.activeModal === modal) {
      this.closeModal();
    } else {
      this.openModal(modal);
    }
  }

  // Discard confirmation
  setPendingDiscard(file: FileEntry | null): void {
    this.update({ pendingDiscard: file });
  }

  // Commit input focus
  setCommitInputFocused(focused: boolean): void {
    this.update({ commitInputFocused: focused });
  }

  // Helper for toggling between panes
  togglePane(): void {
    const { bottomTab, currentPane } = this._state;
    if (bottomTab === 'diff' || bottomTab === 'commit') {
      this.setPane(currentPane === 'files' ? 'diff' : 'files');
    } else if (bottomTab === 'history') {
      this.setPane(currentPane === 'history' ? 'diff' : 'history');
    } else if (bottomTab === 'compare') {
      this.setPane(currentPane === 'compare' ? 'diff' : 'compare');
    } else if (bottomTab === 'explorer') {
      this.setPane(currentPane === 'explorer' ? 'diff' : 'explorer');
    }
  }

  // Reset repo-specific state when switching repositories
  resetForNewRepo(): void {
    this._state = {
      ...this._state,
      selectedIndex: 0,
      fileListScrollOffset: 0,
      diffScrollOffset: 0,
      historySelectedIndex: 0,
      historyScrollOffset: 0,
      compareSelectedIndex: 0,
      compareScrollOffset: 0,
      explorerSelectedIndex: 0,
      explorerScrollOffset: 0,
      explorerFileScrollOffset: 0,
    };
    this.emit('change', this._state);
  }
}
