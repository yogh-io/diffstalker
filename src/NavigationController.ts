import type { UIState } from './state/UIState.js';
import type { GitStateManager } from './core/GitStateManager.js';
import type { ExplorerStateManager } from './core/ExplorerStateManager.js';
import type { FlatFileEntry } from './utils/flatFileList.js';
import type { HunkBoundary } from './utils/displayRows.js';
import {
  getNextCompareSelection,
  getRowFromCompareSelection,
  type CompareListSelection,
} from './ui/widgets/CompareListView.js';
import { getFileAtIndex, getRowFromFileIndex } from './ui/widgets/FileList.js';
import { getCommitAtIndex } from './ui/widgets/HistoryView.js';
import { getFlatFileAtIndex } from './utils/flatFileList.js';

/**
 * Read-only context provided by App for navigation decisions.
 */
export interface NavigationContext {
  uiState: UIState;
  getGitManager(): GitStateManager | null;
  getExplorerManager(): ExplorerStateManager | null;
  getTopPaneHeight(): number;
  getBottomPaneHeight(): number;
  getCachedFlatFiles(): FlatFileEntry[];
  getHunkCount(): number;
  getHunkBoundaries(): HunkBoundary[];
  getRepoPath(): string;
  onError(message: string): void;
}

/**
 * Handles all list and pane navigation: file list, history, compare, explorer, hunks.
 * Owns the compareSelection state.
 */
export class NavigationController {
  compareSelection: CompareListSelection | null = null;

  constructor(private ctx: NavigationContext) {}

  scrollActiveDiffPane(delta: number): void {
    const state = this.ctx.uiState.state;
    if (state.bottomTab === 'explorer') {
      const newOffset = Math.max(0, state.explorerFileScrollOffset + delta);
      this.ctx.uiState.setExplorerFileScrollOffset(newOffset);
    } else {
      const newOffset = Math.max(0, state.diffScrollOffset + delta);
      this.ctx.uiState.setDiffScrollOffset(newOffset);
    }
  }

  navigateFileList(direction: -1 | 1): void {
    const state = this.ctx.uiState.state;
    const files = this.ctx.getGitManager()?.workingTree.state.status?.files ?? [];

    const maxIndex = state.flatViewMode
      ? this.ctx.getCachedFlatFiles().length - 1
      : files.length - 1;
    if (maxIndex < 0) return;

    const newIndex =
      direction === -1
        ? Math.max(0, state.selectedIndex - 1)
        : Math.min(maxIndex, state.selectedIndex + 1);
    this.ctx.uiState.setSelectedIndex(newIndex);
    this.selectFileByIndex(newIndex);

    const row = state.flatViewMode ? newIndex + 1 : getRowFromFileIndex(newIndex, files);
    this.scrollToKeepRowVisible(row, direction, state.fileListScrollOffset);
  }

  private scrollToKeepRowVisible(row: number, direction: -1 | 1, currentOffset: number): void {
    if (direction === -1 && row < currentOffset) {
      this.ctx.uiState.setFileListScrollOffset(row);
    } else if (direction === 1) {
      const visibleEnd = currentOffset + this.ctx.getTopPaneHeight() - 1;
      if (row >= visibleEnd) {
        this.ctx.uiState.setFileListScrollOffset(currentOffset + (row - visibleEnd + 1));
      }
    }
  }

  navigateActiveList(direction: -1 | 1): void {
    const tab = this.ctx.uiState.state.bottomTab;

    if (tab === 'history') {
      if (direction === -1) this.navigateHistoryUp();
      else this.navigateHistoryDown();
    } else if (tab === 'compare') {
      if (direction === -1) this.navigateCompareUp();
      else this.navigateCompareDown();
    } else if (tab === 'explorer') {
      if (direction === -1) this.navigateExplorerUp();
      else this.navigateExplorerDown();
    } else {
      this.navigateFileList(direction);
    }
  }

  navigateUp(): void {
    const state = this.ctx.uiState.state;
    const isListPane = state.currentPane !== 'diff';

    if (isListPane) {
      this.navigateActiveList(-1);
    } else {
      this.scrollActiveDiffPane(-3);
    }
  }

  navigateDown(): void {
    const state = this.ctx.uiState.state;
    const isListPane = state.currentPane !== 'diff';

    if (isListPane) {
      this.navigateActiveList(1);
    } else {
      this.scrollActiveDiffPane(3);
    }
  }

  private navigateHistoryUp(): void {
    const state = this.ctx.uiState.state;
    const newIndex = Math.max(0, state.historySelectedIndex - 1);

    if (newIndex !== state.historySelectedIndex) {
      this.ctx.uiState.setHistorySelectedIndex(newIndex);
      if (newIndex < state.historyScrollOffset) {
        this.ctx.uiState.setHistoryScrollOffset(newIndex);
      }
      this.selectHistoryCommitByIndex(newIndex);
    }
  }

  private navigateHistoryDown(): void {
    const state = this.ctx.uiState.state;
    const commits = this.ctx.getGitManager()?.history.historyState.commits ?? [];
    const newIndex = Math.min(commits.length - 1, state.historySelectedIndex + 1);

    if (newIndex !== state.historySelectedIndex) {
      this.ctx.uiState.setHistorySelectedIndex(newIndex);
      const visibleEnd = state.historyScrollOffset + this.ctx.getTopPaneHeight() - 1;
      if (newIndex >= visibleEnd) {
        this.ctx.uiState.setHistoryScrollOffset(state.historyScrollOffset + 1);
      }
      this.selectHistoryCommitByIndex(newIndex);
    }
  }

  selectHistoryCommitByIndex(index: number): void {
    const gm = this.ctx.getGitManager();
    const commits = gm?.history.historyState.commits ?? [];
    const commit = getCommitAtIndex(commits, index);
    if (commit) {
      this.ctx.uiState.setDiffScrollOffset(0);
      gm?.history.selectHistoryCommit(commit).catch((err) => {
        this.ctx.onError(
          `Failed to load commit diff: ${err instanceof Error ? err.message : String(err)}`
        );
      });
    }
  }

  private navigateCompareUp(): void {
    const compareState = this.ctx.getGitManager()?.compare.compareState;
    const commits = compareState?.compareDiff?.commits ?? [];
    const files = compareState?.compareDiff?.files ?? [];

    if (commits.length === 0 && files.length === 0) return;

    const next = getNextCompareSelection(this.compareSelection, commits, files, 'up');
    if (
      next &&
      (next.type !== this.compareSelection?.type || next.index !== this.compareSelection?.index)
    ) {
      this.selectCompareItem(next);

      const state = this.ctx.uiState.state;
      const row = getRowFromCompareSelection(next, commits, files);
      if (row < state.compareScrollOffset) {
        this.ctx.uiState.setCompareScrollOffset(row);
      }
    }
  }

  private navigateCompareDown(): void {
    const compareState = this.ctx.getGitManager()?.compare.compareState;
    const commits = compareState?.compareDiff?.commits ?? [];
    const files = compareState?.compareDiff?.files ?? [];

    if (commits.length === 0 && files.length === 0) return;

    if (!this.compareSelection) {
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

      const state = this.ctx.uiState.state;
      const row = getRowFromCompareSelection(next, commits, files);
      const visibleEnd = state.compareScrollOffset + this.ctx.getTopPaneHeight() - 1;
      if (row >= visibleEnd) {
        this.ctx.uiState.setCompareScrollOffset(state.compareScrollOffset + (row - visibleEnd + 1));
      }
    }
  }

  selectCompareItem(selection: CompareListSelection): void {
    this.compareSelection = selection;
    this.ctx.uiState.setDiffScrollOffset(0);

    const gm = this.ctx.getGitManager();
    if (selection.type === 'commit') {
      gm?.compare.selectCompareCommit(selection.index).catch((err) => {
        this.ctx.onError(
          `Failed to load commit diff: ${err instanceof Error ? err.message : String(err)}`
        );
      });
    } else {
      gm?.compare.selectCompareFile(selection.index);
    }
  }

  navigateExplorerUp(): void {
    const state = this.ctx.uiState.state;
    const explorer = this.ctx.getExplorerManager();
    const rows = explorer?.state.displayRows ?? [];

    if (rows.length === 0) return;

    const newScrollOffset = explorer?.navigateUp(state.explorerScrollOffset);
    if (newScrollOffset !== null && newScrollOffset !== undefined) {
      this.ctx.uiState.setExplorerScrollOffset(newScrollOffset);
    }
    this.ctx.uiState.setExplorerSelectedIndex(explorer?.state.selectedIndex ?? 0);
  }

  navigateExplorerDown(): void {
    const state = this.ctx.uiState.state;
    const explorer = this.ctx.getExplorerManager();
    const rows = explorer?.state.displayRows ?? [];

    if (rows.length === 0) return;

    const visibleHeight = this.ctx.getTopPaneHeight();
    const newScrollOffset = explorer?.navigateDown(state.explorerScrollOffset, visibleHeight);
    if (newScrollOffset !== null && newScrollOffset !== undefined) {
      this.ctx.uiState.setExplorerScrollOffset(newScrollOffset);
    }
    this.ctx.uiState.setExplorerSelectedIndex(explorer?.state.selectedIndex ?? 0);
  }

  async enterExplorerDirectory(): Promise<void> {
    const explorer = this.ctx.getExplorerManager();
    await explorer?.enterDirectory();
    this.ctx.uiState.setExplorerFileScrollOffset(0);
    this.ctx.uiState.setExplorerSelectedIndex(explorer?.state.selectedIndex ?? 0);
  }

  async goExplorerUp(): Promise<void> {
    const explorer = this.ctx.getExplorerManager();
    await explorer?.goUp();
    this.ctx.uiState.setExplorerFileScrollOffset(0);
    this.ctx.uiState.setExplorerSelectedIndex(explorer?.state.selectedIndex ?? 0);
  }

  selectFileByIndex(index: number): void {
    if (this.ctx.uiState.state.flatViewMode) {
      const flatEntry = getFlatFileAtIndex(this.ctx.getCachedFlatFiles(), index);
      if (flatEntry) {
        const file = flatEntry.unstagedEntry ?? flatEntry.stagedEntry;
        if (file) {
          this.ctx.uiState.setDiffScrollOffset(0);
          this.ctx.uiState.setSelectedHunkIndex(0);
          this.ctx.getGitManager()?.workingTree.selectFile(file);
        }
      }
    } else {
      const files = this.ctx.getGitManager()?.workingTree.state.status?.files ?? [];
      const file = getFileAtIndex(files, index);
      if (file) {
        this.ctx.uiState.setDiffScrollOffset(0);
        this.ctx.uiState.setSelectedHunkIndex(0);
        this.ctx.getGitManager()?.workingTree.selectFile(file);
      }
    }
  }

  navigateToFile(absolutePath: string): void {
    const repoPath = this.ctx.getRepoPath();
    if (!absolutePath || !repoPath) return;

    const repoPrefix = repoPath.endsWith('/') ? repoPath : repoPath + '/';
    if (!absolutePath.startsWith(repoPrefix)) return;

    const relativePath = absolutePath.slice(repoPrefix.length);
    if (!relativePath) return;

    const files = this.ctx.getGitManager()?.workingTree.state.status?.files ?? [];
    const fileIndex = files.findIndex((f) => f.path === relativePath);

    if (fileIndex >= 0) {
      this.ctx.uiState.setSelectedIndex(fileIndex);
      this.selectFileByIndex(fileIndex);
    }
  }

  // Hunk navigation

  navigateNextHunk(): void {
    const current = this.ctx.uiState.state.selectedHunkIndex;
    const hunkCount = this.ctx.getHunkCount();
    if (hunkCount > 0 && current < hunkCount - 1) {
      this.ctx.uiState.setSelectedHunkIndex(current + 1);
      this.scrollHunkIntoView(current + 1);
    }
  }

  navigatePrevHunk(): void {
    const current = this.ctx.uiState.state.selectedHunkIndex;
    if (current > 0) {
      this.ctx.uiState.setSelectedHunkIndex(current - 1);
      this.scrollHunkIntoView(current - 1);
    }
  }

  private scrollHunkIntoView(hunkIndex: number): void {
    const boundary = this.ctx.getHunkBoundaries()[hunkIndex];
    if (!boundary) return;

    const scrollOffset = this.ctx.uiState.state.diffScrollOffset;
    const visibleHeight = this.ctx.getBottomPaneHeight();

    if (boundary.startRow < scrollOffset || boundary.startRow >= scrollOffset + visibleHeight) {
      this.ctx.uiState.setDiffScrollOffset(boundary.startRow);
    }
  }

  selectHunkAtRow(visualRow: number): void {
    if (this.ctx.uiState.state.bottomTab !== 'diff') return;
    const boundaries = this.ctx.getHunkBoundaries();
    if (boundaries.length === 0) return;

    this.ctx.uiState.setPane('diff');

    const absoluteRow = this.ctx.uiState.state.diffScrollOffset + visualRow;
    for (let i = 0; i < boundaries.length; i++) {
      const b = boundaries[i];
      if (absoluteRow >= b.startRow && absoluteRow < b.endRow) {
        this.ctx.uiState.setSelectedHunkIndex(i);
        return;
      }
    }
  }
}
