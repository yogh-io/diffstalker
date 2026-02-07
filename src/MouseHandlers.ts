import type { LayoutManager } from './ui/Layout.js';
import type { UIState } from './state/UIState.js';
import type { FileEntry, CommitInfo } from './git/status.js';
import type { CompareFileDiff } from './git/diff.js';
import type { CompareListSelection } from './ui/widgets/CompareListView.js';
import type { ExplorerStateManager } from './core/ExplorerStateManager.js';
import type { FlatFileEntry } from './utils/flatFileList.js';
import { getFileListTotalRows, getFileIndexFromRow } from './ui/widgets/FileList.js';
import { getFlatFileListTotalRows } from './ui/widgets/FlatFileList.js';
import {
  getCompareListTotalRows,
  getCompareSelectionFromRow,
} from './ui/widgets/CompareListView.js';
import { getExplorerTotalRows } from './ui/widgets/ExplorerView.js';
import { getExplorerContentTotalRows } from './ui/widgets/ExplorerContent.js';

const SCROLL_AMOUNT = 3;

/**
 * Actions that mouse handlers can trigger on the App.
 */
export interface MouseActions {
  selectHistoryCommitByIndex(index: number): void;
  selectCompareItem(selection: CompareListSelection): void;
  selectFileByIndex(index: number): void;
  toggleFileByIndex(index: number): void;
  enterExplorerDirectory(): void;
  toggleMouseMode(): void;
  toggleFollow(): void;
  selectHunkAtRow(visualRow: number): void;
  focusCommitInput(): void;
  render(): void;
}

/**
 * Read-only context needed by mouse handlers.
 */
export interface MouseContext {
  uiState: UIState;
  getExplorerManager(): ExplorerStateManager | null;
  getStatusFiles(): FileEntry[];
  getHistoryCommitCount(): number;
  getCompareCommits(): CommitInfo[];
  getCompareFiles(): CompareFileDiff[];
  getBottomPaneTotalRows(): number;
  getScreenWidth(): number;
  getCachedFlatFiles(): FlatFileEntry[];
}

/**
 * Register all mouse event handlers on the layout.
 */
export function setupMouseHandlers(
  layout: LayoutManager,
  actions: MouseActions,
  ctx: MouseContext
): void {
  // Mouse wheel on top pane
  layout.topPane.on('wheeldown', () => {
    handleTopPaneScroll(SCROLL_AMOUNT, layout, ctx);
  });

  layout.topPane.on('wheelup', () => {
    handleTopPaneScroll(-SCROLL_AMOUNT, layout, ctx);
  });

  // Mouse wheel on bottom pane
  layout.bottomPane.on('wheeldown', () => {
    handleBottomPaneScroll(SCROLL_AMOUNT, layout, ctx);
  });

  layout.bottomPane.on('wheelup', () => {
    handleBottomPaneScroll(-SCROLL_AMOUNT, layout, ctx);
  });

  // Click on top pane to select item
  layout.topPane.on('click', (mouse: { x: number; y: number }) => {
    const clickedRow = layout.screenYToTopPaneRow(mouse.y);
    if (clickedRow >= 0) {
      handleTopPaneClick(clickedRow, mouse.x, actions, ctx);
    }
  });

  // Click on bottom pane
  layout.bottomPane.on('click', (mouse: { x: number; y: number }) => {
    const clickedRow = layout.screenYToBottomPaneRow(mouse.y);
    if (clickedRow >= 0) {
      if (ctx.uiState.state.bottomTab === 'commit') {
        actions.focusCommitInput();
      } else {
        actions.selectHunkAtRow(clickedRow);
      }
    }
  });

  // Click on footer for tabs and toggles
  layout.footerBox.on('click', (mouse: { x: number; y: number }) => {
    handleFooterClick(mouse.x, actions, ctx);
  });
}

function handleFileListClick(
  row: number,
  x: number | undefined,
  actions: MouseActions,
  ctx: MouseContext
): void {
  const state = ctx.uiState.state;

  if (state.flatViewMode) {
    // Flat mode: row 0 is header, files start at row 1
    const absoluteRow = row + state.fileListScrollOffset;
    const fileIndex = absoluteRow - 1; // subtract header row
    const flatFiles = ctx.getCachedFlatFiles();
    if (fileIndex < 0 || fileIndex >= flatFiles.length) return;

    if (x !== undefined && x >= 2 && x <= 4) {
      actions.toggleFileByIndex(fileIndex);
    } else {
      ctx.uiState.setSelectedIndex(fileIndex);
      actions.selectFileByIndex(fileIndex);
    }
  } else {
    const files = ctx.getStatusFiles();
    const fileIndex = getFileIndexFromRow(row + state.fileListScrollOffset, files);
    if (fileIndex === null || fileIndex < 0) return;

    if (x !== undefined && x >= 2 && x <= 4) {
      actions.toggleFileByIndex(fileIndex);
    } else {
      ctx.uiState.setSelectedIndex(fileIndex);
      actions.selectFileByIndex(fileIndex);
    }
  }
}

function handleTopPaneClick(
  row: number,
  x: number | undefined,
  actions: MouseActions,
  ctx: MouseContext
): void {
  const state = ctx.uiState.state;

  if (state.bottomTab === 'history') {
    const index = state.historyScrollOffset + row;
    ctx.uiState.setHistorySelectedIndex(index);
    actions.selectHistoryCommitByIndex(index);
  } else if (state.bottomTab === 'compare') {
    const commits = ctx.getCompareCommits();
    const files = ctx.getCompareFiles();
    const selection = getCompareSelectionFromRow(state.compareScrollOffset + row, commits, files);
    if (selection) {
      actions.selectCompareItem(selection);
    }
  } else if (state.bottomTab === 'explorer') {
    const index = state.explorerScrollOffset + row;
    const explorerManager = ctx.getExplorerManager();
    const isAlreadySelected = explorerManager?.state.selectedIndex === index;
    const displayRow = explorerManager?.state.displayRows[index];
    if (isAlreadySelected && displayRow?.node.isDirectory) {
      actions.enterExplorerDirectory();
    } else {
      explorerManager?.selectIndex(index);
      ctx.uiState.setExplorerSelectedIndex(index);
    }
  } else {
    handleFileListClick(row, x, actions, ctx);
  }
}

function handleFooterClick(x: number, actions: MouseActions, ctx: MouseContext): void {
  const width = ctx.getScreenWidth();

  // Tabs are right-aligned
  const tabPositions = [
    { tab: 'explorer' as const, width: 11 },
    { tab: 'compare' as const, width: 10 },
    { tab: 'history' as const, width: 10 },
    { tab: 'commit' as const, width: 9 },
    { tab: 'diff' as const, width: 7 },
  ];

  let rightEdge = width;
  for (const { tab, width: tabWidth } of tabPositions) {
    const leftEdge = rightEdge - tabWidth - 1;
    if (x >= leftEdge && x < rightEdge) {
      ctx.uiState.setTab(tab);
      return;
    }
    rightEdge = leftEdge;
  }

  // Left side toggles (approximate positions)
  if (x >= 2 && x <= 9) {
    actions.toggleMouseMode();
  } else if (x >= 11 && x <= 16) {
    ctx.uiState.toggleAutoTab();
  } else if (x >= 18 && x <= 23) {
    ctx.uiState.toggleWrapMode();
  } else if (x >= 25 && x <= 32) {
    actions.toggleFollow();
  } else if (x >= 34 && x <= 43 && ctx.uiState.state.bottomTab === 'explorer') {
    ctx.getExplorerManager()?.toggleShowOnlyChanges();
  } else if (x === 0) {
    ctx.uiState.openModal('hotkeys');
  }
}

function handleTopPaneScroll(delta: number, layout: LayoutManager, ctx: MouseContext): void {
  const state = ctx.uiState.state;
  const visibleHeight = layout.dimensions.topPaneHeight;

  if (state.bottomTab === 'history') {
    const totalRows = ctx.getHistoryCommitCount();
    const maxOffset = Math.max(0, totalRows - visibleHeight);
    const newOffset = Math.min(maxOffset, Math.max(0, state.historyScrollOffset + delta));
    ctx.uiState.setHistoryScrollOffset(newOffset);
  } else if (state.bottomTab === 'compare') {
    const totalRows = getCompareListTotalRows(ctx.getCompareCommits(), ctx.getCompareFiles());
    const maxOffset = Math.max(0, totalRows - visibleHeight);
    const newOffset = Math.min(maxOffset, Math.max(0, state.compareScrollOffset + delta));
    ctx.uiState.setCompareScrollOffset(newOffset);
  } else if (state.bottomTab === 'explorer') {
    const totalRows = getExplorerTotalRows(ctx.getExplorerManager()?.state.displayRows ?? []);
    const maxOffset = Math.max(0, totalRows - visibleHeight);
    const newOffset = Math.min(maxOffset, Math.max(0, state.explorerScrollOffset + delta));
    ctx.uiState.setExplorerScrollOffset(newOffset);
  } else {
    const totalRows = state.flatViewMode
      ? getFlatFileListTotalRows(ctx.getCachedFlatFiles())
      : getFileListTotalRows(ctx.getStatusFiles());
    const maxOffset = Math.max(0, totalRows - visibleHeight);
    const newOffset = Math.min(maxOffset, Math.max(0, state.fileListScrollOffset + delta));
    ctx.uiState.setFileListScrollOffset(newOffset);
  }
}

function handleBottomPaneScroll(delta: number, layout: LayoutManager, ctx: MouseContext): void {
  const state = ctx.uiState.state;
  const visibleHeight = layout.dimensions.bottomPaneHeight;
  const width = ctx.getScreenWidth();

  if (state.bottomTab === 'explorer') {
    const selectedFile = ctx.getExplorerManager()?.state.selectedFile;
    const totalRows = getExplorerContentTotalRows(
      selectedFile?.content ?? null,
      selectedFile?.path ?? null,
      selectedFile?.truncated ?? false,
      width,
      state.wrapMode
    );
    const maxOffset = Math.max(0, totalRows - visibleHeight);
    const newOffset = Math.min(maxOffset, Math.max(0, state.explorerFileScrollOffset + delta));
    ctx.uiState.setExplorerFileScrollOffset(newOffset);
  } else {
    const maxOffset = Math.max(0, ctx.getBottomPaneTotalRows() - visibleHeight);
    const newOffset = Math.min(maxOffset, Math.max(0, state.diffScrollOffset + delta));
    ctx.uiState.setDiffScrollOffset(newOffset);
  }
}
