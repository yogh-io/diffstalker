import { EventEmitter } from 'node:events';
import type { BottomTab } from '../types/tabs.js';
import type { FileEntry } from '../git/status.js';
import { FocusRing } from './FocusRing.js';

export type Pane = 'files' | 'diff' | 'commit' | 'history' | 'compare' | 'explorer';

export type FocusZone =
  | 'fileList'
  | 'diffView'
  | 'commitMessage'
  | 'commitAmend'
  | 'historyList'
  | 'historyDiff'
  | 'compareList'
  | 'compareDiff'
  | 'explorerTree'
  | 'explorerContent';

/** Map each focus zone to its derived currentPane value. */
export const ZONE_TO_PANE: Record<FocusZone, Pane> = {
  fileList: 'files',
  diffView: 'diff',
  commitMessage: 'commit',
  commitAmend: 'commit',
  historyList: 'history',
  historyDiff: 'diff',
  compareList: 'compare',
  compareDiff: 'diff',
  explorerTree: 'explorer',
  explorerContent: 'diff',
};

/** Ordered list of focus zones per tab (Tab order). */
export const TAB_ZONES: Record<BottomTab, FocusZone[]> = {
  diff: ['fileList', 'diffView'],
  commit: ['fileList', 'commitMessage', 'commitAmend'],
  history: ['historyList', 'historyDiff'],
  compare: ['compareList', 'compareDiff'],
  explorer: ['explorerTree', 'explorerContent'],
};

/** Default focus zone when switching to each tab. */
export const DEFAULT_TAB_ZONE: Record<BottomTab, FocusZone> = {
  diff: 'fileList',
  commit: 'commitMessage',
  history: 'historyList',
  compare: 'compareList',
  explorer: 'explorerTree',
};

export interface UIStateData {
  // Navigation
  focusedZone: FocusZone;
  currentPane: Pane; // Derived from focusedZone via ZONE_TO_PANE
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

  // Hunk selection (diff pane)
  selectedHunkIndex: number;

  // Display options
  wrapMode: boolean;
  autoTabEnabled: boolean;
  mouseEnabled: boolean;
  hideHiddenFiles: boolean;
  hideGitignored: boolean;
  flatViewMode: boolean;

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
  focusedZone: 'fileList',
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
  selectedHunkIndex: 0,
  wrapMode: false,
  autoTabEnabled: false,
  mouseEnabled: true,
  hideHiddenFiles: true,
  hideGitignored: true,
  flatViewMode: false,
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
  private focusRing: FocusRing<FocusZone>;

  constructor(initialState: Partial<UIStateData> = {}) {
    super();
    this._state = { ...DEFAULT_STATE, ...initialState };
    const tab = this._state.bottomTab;
    const zones = TAB_ZONES[tab];
    this.focusRing = new FocusRing(zones);
    if (this._state.focusedZone) {
      this.focusRing.setCurrent(this._state.focusedZone);
    }
    // Ensure currentPane is in sync
    this._state.currentPane = ZONE_TO_PANE[this._state.focusedZone];
  }

  get state(): UIStateData {
    return this._state;
  }

  private update(partial: Partial<UIStateData>): void {
    this._state = { ...this._state, ...partial };
    // Derive currentPane from focusedZone
    this._state.currentPane = ZONE_TO_PANE[this._state.focusedZone];
    this.emit('change', this._state);
  }

  // Navigation
  setPane(pane: Pane): void {
    // Map pane to the first matching zone for the current tab
    const zones = TAB_ZONES[this._state.bottomTab];
    const zone = zones.find((z) => ZONE_TO_PANE[z] === pane);
    if (zone) {
      this.setFocusedZone(zone);
    }
  }

  setFocusedZone(zone: FocusZone): void {
    if (this._state.focusedZone !== zone) {
      this.focusRing.setCurrent(zone);
      const oldPane = this._state.currentPane;
      this.update({ focusedZone: zone });
      if (this._state.currentPane !== oldPane) {
        this.emit('pane-change', this._state.currentPane);
      }
    }
  }

  setTab(tab: BottomTab): void {
    if (this._state.bottomTab !== tab) {
      const defaultZone = DEFAULT_TAB_ZONE[tab];
      this.focusRing.setItems(TAB_ZONES[tab], defaultZone);
      this.update({
        bottomTab: tab,
        focusedZone: defaultZone,
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

  // Hunk selection
  setSelectedHunkIndex(index: number): void {
    this.update({ selectedHunkIndex: Math.max(0, index) });
  }

  /**
   * Silently clamp selectedHunkIndex to valid range without emitting events.
   * Called during render to sync state with actual hunk count.
   */
  clampSelectedHunkIndex(hunkCount: number): void {
    if (hunkCount <= 0) {
      this._state.selectedHunkIndex = 0;
    } else if (this._state.selectedHunkIndex >= hunkCount) {
      this._state.selectedHunkIndex = hunkCount - 1;
    }
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

  toggleFlatViewMode(): void {
    this.update({ flatViewMode: !this._state.flatViewMode, fileListScrollOffset: 0 });
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

  // Focus zone cycling
  advanceFocus(): void {
    const zone = this.focusRing.next();
    const oldPane = this._state.currentPane;
    this.update({ focusedZone: zone });
    if (this._state.currentPane !== oldPane) {
      this.emit('pane-change', this._state.currentPane);
    }
  }

  retreatFocus(): void {
    const zone = this.focusRing.prev();
    const oldPane = this._state.currentPane;
    this.update({ focusedZone: zone });
    if (this._state.currentPane !== oldPane) {
      this.emit('pane-change', this._state.currentPane);
    }
  }

  /** Backward compat alias for advanceFocus(). */
  togglePane(): void {
    this.advanceFocus();
  }

  // Reset repo-specific state when switching repositories
  resetForNewRepo(): void {
    const defaultZone = DEFAULT_TAB_ZONE[this._state.bottomTab];
    this.focusRing.setItems(TAB_ZONES[this._state.bottomTab], defaultZone);
    this._state = {
      ...this._state,
      focusedZone: defaultZone,
      currentPane: ZONE_TO_PANE[defaultZone],
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
      selectedHunkIndex: 0,
    };
    this.emit('change', this._state);
  }
}
