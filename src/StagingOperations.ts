import type { UIState } from './state/UIState.js';
import type { GitStateManager } from './core/GitStateManager.js';
import type { FileEntry } from './git/status.js';
import type { FlatFileEntry } from './utils/flatFileList.js';
import type { CombinedHunkInfo } from './utils/displayRows.js';
import { getFileAtIndex } from './ui/widgets/FileList.js';
import { getFlatFileAtIndex } from './utils/flatFileList.js';
import { getCategoryForIndex, type CategoryName } from './utils/fileCategories.js';
import { extractHunkPatch } from './git/diff.js';

/**
 * Read-only context provided by App for staging decisions.
 */
export interface StagingContext {
  uiState: UIState;
  getGitManager(): GitStateManager | null;
  getCachedFlatFiles(): FlatFileEntry[];
  getCombinedHunkMapping(): CombinedHunkInfo[];
}

/**
 * Handles all file and hunk staging/unstaging operations.
 * Owns selection anchoring state used for reconciliation after git state changes.
 */
export class StagingOperations {
  private pendingSelectionAnchor: { category: CategoryName; categoryIndex: number } | null = null;
  private pendingFlatSelectionPath: string | null = null;
  private pendingHunkIndex: number | null = null;

  constructor(private ctx: StagingContext) {}

  consumePendingSelectionAnchor(): { category: CategoryName; categoryIndex: number } | null {
    const value = this.pendingSelectionAnchor;
    this.pendingSelectionAnchor = null;
    return value;
  }

  consumePendingFlatSelectionPath(): string | null {
    const value = this.pendingFlatSelectionPath;
    this.pendingFlatSelectionPath = null;
    return value;
  }

  consumePendingHunkIndex(): number | null {
    const value = this.pendingHunkIndex;
    this.pendingHunkIndex = null;
    return value;
  }

  async stageSelected(): Promise<void> {
    const gm = this.ctx.getGitManager();
    const wt = gm?.workingTree;
    const files = wt?.state.status?.files ?? [];
    const index = this.ctx.uiState.state.selectedIndex;

    if (this.ctx.uiState.state.flatViewMode) {
      const flatEntry = getFlatFileAtIndex(this.ctx.getCachedFlatFiles(), index);
      if (!flatEntry) return;
      const file = flatEntry.unstagedEntry;
      if (file) {
        this.pendingFlatSelectionPath = flatEntry.path;
        await wt?.stage(file);
      }
    } else {
      const selectedFile = getFileAtIndex(files, index);
      if (selectedFile && !selectedFile.staged) {
        this.pendingSelectionAnchor = getCategoryForIndex(files, index);
        await wt?.stage(selectedFile);
      }
    }
  }

  async unstageSelected(): Promise<void> {
    const gm = this.ctx.getGitManager();
    const wt = gm?.workingTree;
    const files = wt?.state.status?.files ?? [];
    const index = this.ctx.uiState.state.selectedIndex;

    if (this.ctx.uiState.state.flatViewMode) {
      const flatEntry = getFlatFileAtIndex(this.ctx.getCachedFlatFiles(), index);
      if (!flatEntry) return;
      const file = flatEntry.stagedEntry;
      if (file) {
        this.pendingFlatSelectionPath = flatEntry.path;
        await wt?.unstage(file);
      }
    } else {
      const selectedFile = getFileAtIndex(files, index);
      if (selectedFile?.staged) {
        this.pendingSelectionAnchor = getCategoryForIndex(files, index);
        await wt?.unstage(selectedFile);
      }
    }
  }

  async toggleSelected(): Promise<void> {
    const index = this.ctx.uiState.state.selectedIndex;

    if (this.ctx.uiState.state.flatViewMode) {
      const flatEntry = getFlatFileAtIndex(this.ctx.getCachedFlatFiles(), index);
      if (flatEntry) await this.toggleFlatEntry(flatEntry);
    } else {
      const gm = this.ctx.getGitManager();
      const wt = gm?.workingTree;
      const files = wt?.state.status?.files ?? [];
      const selectedFile = getFileAtIndex(files, index);
      if (selectedFile) {
        this.pendingSelectionAnchor = getCategoryForIndex(files, index);
        if (selectedFile.staged) {
          await wt?.unstage(selectedFile);
        } else {
          await wt?.stage(selectedFile);
        }
      }
    }
  }

  async stageAll(): Promise<void> {
    await this.ctx.getGitManager()?.workingTree.stageAll();
  }

  async unstageAll(): Promise<void> {
    await this.ctx.getGitManager()?.workingTree.unstageAll();
  }

  async toggleFlatEntry(entry: FlatFileEntry): Promise<void> {
    const wt = this.ctx.getGitManager()?.workingTree;
    this.pendingFlatSelectionPath = entry.path;
    if (entry.stagingState === 'staged') {
      if (entry.stagedEntry) await wt?.unstage(entry.stagedEntry);
    } else {
      if (entry.unstagedEntry) await wt?.stage(entry.unstagedEntry);
    }
  }

  async toggleFileByIndex(index: number): Promise<void> {
    if (this.ctx.uiState.state.flatViewMode) {
      const flatEntry = getFlatFileAtIndex(this.ctx.getCachedFlatFiles(), index);
      if (flatEntry) await this.toggleFlatEntry(flatEntry);
    } else {
      const gm = this.ctx.getGitManager();
      const wt = gm?.workingTree;
      const files = wt?.state.status?.files ?? [];
      const file = getFileAtIndex(files, index);
      if (file) {
        this.pendingSelectionAnchor = getCategoryForIndex(
          files,
          this.ctx.uiState.state.selectedIndex
        );
        if (file.staged) {
          await wt?.unstage(file);
        } else {
          await wt?.stage(file);
        }
      }
    }
  }

  // Hunk staging

  async toggleCurrentHunk(): Promise<void> {
    const selectedFile = this.ctx.getGitManager()?.workingTree.state.selectedFile;
    if (!selectedFile) return;
    if (selectedFile.status === 'untracked') {
      // Hunk staging not available for untracked files; stage the whole file
      // but preserve selection state like a normal hunk toggle would
      const wt = this.ctx.getGitManager()?.workingTree;
      const files = wt?.state.status?.files ?? [];
      this.pendingSelectionAnchor = getCategoryForIndex(
        files,
        this.ctx.uiState.state.selectedIndex
      );
      this.pendingHunkIndex = this.ctx.uiState.state.selectedHunkIndex;
      await wt?.stage(selectedFile);
      return;
    }

    if (this.ctx.uiState.state.flatViewMode) {
      await this.toggleCurrentHunkFlat();
    } else {
      await this.toggleCurrentHunkCategorized(selectedFile);
    }
  }

  private async toggleCurrentHunkFlat(): Promise<void> {
    const mapping = this.ctx.getCombinedHunkMapping()[this.ctx.uiState.state.selectedHunkIndex];
    if (!mapping) return;

    const wt = this.ctx.getGitManager()?.workingTree;
    const combined = wt?.state.combinedFileDiffs;
    if (!combined) return;

    const rawDiff = mapping.source === 'unstaged' ? combined.unstaged.raw : combined.staged.raw;
    const patch = extractHunkPatch(rawDiff, mapping.hunkIndex);
    if (!patch) return;

    this.pendingHunkIndex = this.ctx.uiState.state.selectedHunkIndex;

    if (mapping.source === 'staged') {
      await wt?.unstageHunk(patch);
    } else {
      await wt?.stageHunk(patch);
    }
  }

  private async toggleCurrentHunkCategorized(selectedFile: FileEntry): Promise<void> {
    const wt = this.ctx.getGitManager()?.workingTree;
    const rawDiff = wt?.state.diff?.raw;
    if (!rawDiff) return;

    const patch = extractHunkPatch(rawDiff, this.ctx.uiState.state.selectedHunkIndex);
    if (!patch) return;

    const files = wt?.state.status?.files ?? [];
    this.pendingSelectionAnchor = getCategoryForIndex(files, this.ctx.uiState.state.selectedIndex);

    if (selectedFile.staged) {
      await wt?.unstageHunk(patch);
    } else {
      await wt?.stageHunk(patch);
    }
  }
}
