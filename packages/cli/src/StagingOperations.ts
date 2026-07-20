import type { UIState } from './state/UIState.js';
import type { RepoSession } from './daemon/RepoSession.js';
import type { FileEntry } from '@diffstalker/core/git/status';
import type { FlatFileEntry } from './utils/flatFileList.js';
import type { CombinedHunkInfo } from './utils/displayRows.js';
import { getFlatFileAtIndex } from './utils/flatFileList.js';
import { getCategoryForIndex, type CategoryName } from './utils/fileCategories.js';
import { extractHunkPatch } from '@diffstalker/core/git/diff';

/**
 * Read-only context provided by App for staging decisions.
 */
export interface StagingContext {
  uiState: UIState;
  getSession(): RepoSession | null;
  getCachedFlatFiles(): FlatFileEntry[];
  getCombinedHunkMapping(): CombinedHunkInfo[];
  resolveFileAtIndex(index: number): FileEntry | null;
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
    const session = this.ctx.getSession();
    const files = session?.shared.status?.files ?? [];
    const index = this.ctx.uiState.state.selectedIndex;

    if (this.ctx.uiState.state.flatViewMode) {
      const flatEntry = getFlatFileAtIndex(this.ctx.getCachedFlatFiles(), index);
      if (!flatEntry) return;
      const file = flatEntry.unstagedEntry;
      if (file) {
        this.pendingFlatSelectionPath = flatEntry.path;
        await session?.stage(file);
      }
    } else {
      const selectedFile = this.ctx.resolveFileAtIndex(index);
      if (selectedFile && !selectedFile.staged) {
        this.pendingSelectionAnchor = getCategoryForIndex(files, index);
        await session?.stage(selectedFile);
      }
    }
  }

  async unstageSelected(): Promise<void> {
    const session = this.ctx.getSession();
    const files = session?.shared.status?.files ?? [];
    const index = this.ctx.uiState.state.selectedIndex;

    if (this.ctx.uiState.state.flatViewMode) {
      const flatEntry = getFlatFileAtIndex(this.ctx.getCachedFlatFiles(), index);
      if (!flatEntry) return;
      const file = flatEntry.stagedEntry;
      if (file) {
        this.pendingFlatSelectionPath = flatEntry.path;
        await session?.unstage(file);
      }
    } else {
      const selectedFile = this.ctx.resolveFileAtIndex(index);
      if (selectedFile?.staged) {
        this.pendingSelectionAnchor = getCategoryForIndex(files, index);
        await session?.unstage(selectedFile);
      }
    }
  }

  async toggleSelected(): Promise<void> {
    const index = this.ctx.uiState.state.selectedIndex;

    if (this.ctx.uiState.state.flatViewMode) {
      const flatEntry = getFlatFileAtIndex(this.ctx.getCachedFlatFiles(), index);
      if (flatEntry) await this.toggleFlatEntry(flatEntry);
    } else {
      const session = this.ctx.getSession();
      const files = session?.shared.status?.files ?? [];
      const selectedFile = this.ctx.resolveFileAtIndex(index);
      if (selectedFile) {
        this.pendingSelectionAnchor = getCategoryForIndex(files, index);
        if (selectedFile.staged) {
          await session?.unstage(selectedFile);
        } else {
          await session?.stage(selectedFile);
        }
      }
    }
  }

  async stageAll(): Promise<void> {
    await this.ctx.getSession()?.stageAll();
  }

  async unstageAll(): Promise<void> {
    await this.ctx.getSession()?.unstageAll();
  }

  async toggleFlatEntry(entry: FlatFileEntry): Promise<void> {
    const session = this.ctx.getSession();
    this.pendingFlatSelectionPath = entry.path;
    if (entry.stagingState === 'staged') {
      if (entry.stagedEntry) await session?.unstage(entry.stagedEntry);
    } else {
      if (entry.unstagedEntry) await session?.stage(entry.unstagedEntry);
    }
  }

  async toggleFileByIndex(index: number): Promise<void> {
    if (this.ctx.uiState.state.flatViewMode) {
      const flatEntry = getFlatFileAtIndex(this.ctx.getCachedFlatFiles(), index);
      if (flatEntry) await this.toggleFlatEntry(flatEntry);
    } else {
      const session = this.ctx.getSession();
      const files = session?.shared.status?.files ?? [];
      const file = this.ctx.resolveFileAtIndex(index);
      if (file) {
        this.pendingSelectionAnchor = getCategoryForIndex(
          files,
          this.ctx.uiState.state.selectedIndex
        );
        if (file.staged) {
          await session?.unstage(file);
        } else {
          await session?.stage(file);
        }
      }
    }
  }

  // Hunk staging

  async toggleCurrentHunk(): Promise<void> {
    const session = this.ctx.getSession();
    const selectedFile = session?.selection.file;
    if (!selectedFile) return;
    if (selectedFile.status === 'untracked') {
      // Hunk staging not available for untracked files; stage the whole file
      // but preserve selection state like a normal hunk toggle would
      const files = session?.shared.status?.files ?? [];
      this.pendingSelectionAnchor = getCategoryForIndex(
        files,
        this.ctx.uiState.state.selectedIndex
      );
      this.pendingHunkIndex = this.ctx.uiState.state.selectedHunkIndex;
      await session?.stage(selectedFile);
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

    const session = this.ctx.getSession();
    const combined = session?.selection.combined;
    if (!combined) return;

    const rawDiff = mapping.source === 'unstaged' ? combined.unstaged.raw : combined.staged.raw;
    const patch = extractHunkPatch(rawDiff, mapping.hunkIndex);
    if (!patch) return;

    this.pendingHunkIndex = this.ctx.uiState.state.selectedHunkIndex;

    if (mapping.source === 'staged') {
      await session?.unstageHunk(patch);
    } else {
      await session?.stageHunk(patch);
    }
  }

  private async toggleCurrentHunkCategorized(selectedFile: FileEntry): Promise<void> {
    const session = this.ctx.getSession();
    const rawDiff = session?.selection.diff?.raw;
    if (!rawDiff) return;

    const patch = extractHunkPatch(rawDiff, this.ctx.uiState.state.selectedHunkIndex);
    if (!patch) return;

    const files = session?.shared.status?.files ?? [];
    this.pendingSelectionAnchor = getCategoryForIndex(files, this.ctx.uiState.state.selectedIndex);

    if (selectedFile.staged) {
      await session?.unstageHunk(patch);
    } else {
      await session?.stageHunk(patch);
    }
  }
}
