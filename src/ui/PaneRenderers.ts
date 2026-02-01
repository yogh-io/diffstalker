import type { UIStateData } from '../state/UIState.js';
import type { CommitFlowStateData } from '../state/CommitFlowState.js';
import type { FileEntry, CommitInfo } from '../git/status.js';
import type { DiffResult, CompareDiff } from '../git/diff.js';
import type { CombinedFileDiffs } from '../core/GitStateManager.js';
import type { ExplorerState } from '../core/ExplorerStateManager.js';
import type { HistoryState, CompareSelectionState } from '../core/GitStateManager.js';
import type { FileHunkCounts } from '../git/diff.js';
import type { CompareListSelection } from './widgets/CompareListView.js';
import type { ThemeName } from '../themes.js';
import type { SelectedFile } from '../core/ExplorerStateManager.js';

import { formatFileList } from './widgets/FileList.js';
import { formatFlatFileList } from './widgets/FlatFileList.js';
import { formatHistoryView } from './widgets/HistoryView.js';
import { formatCompareListView } from './widgets/CompareListView.js';
import { formatExplorerView } from './widgets/ExplorerView.js';
import { formatDiff, formatCombinedDiff, formatHistoryDiff } from './widgets/DiffView.js';
import { formatCommitPanel } from './widgets/CommitPanel.js';
import { formatExplorerContent } from './widgets/ExplorerContent.js';
import type { FlatFileEntry } from '../utils/flatFileList.js';

/**
 * Render the top pane content for the current tab.
 */
export function renderTopPane(
  state: UIStateData,
  files: FileEntry[],
  historyCommits: CommitInfo[],
  compareDiff: CompareDiff | null,
  compareSelection: CompareListSelection | null,
  explorerState: ExplorerState | undefined,
  width: number,
  topPaneHeight: number,
  hunkCounts?: FileHunkCounts | null,
  flatFiles?: FlatFileEntry[]
): string {
  if (state.bottomTab === 'history') {
    return formatHistoryView(
      historyCommits,
      state.historySelectedIndex,
      state.currentPane === 'history',
      width,
      state.historyScrollOffset,
      topPaneHeight
    );
  }

  if (state.bottomTab === 'compare') {
    const commits = compareDiff?.commits ?? [];
    const compareFiles = compareDiff?.files ?? [];

    return formatCompareListView(
      commits,
      compareFiles,
      compareSelection,
      state.currentPane === 'compare',
      width,
      state.compareScrollOffset,
      topPaneHeight
    );
  }

  if (state.bottomTab === 'explorer') {
    const displayRows = explorerState?.displayRows ?? [];

    return formatExplorerView(
      displayRows,
      state.explorerSelectedIndex,
      state.currentPane === 'explorer',
      width,
      state.explorerScrollOffset,
      topPaneHeight,
      explorerState?.isLoading ?? false,
      explorerState?.error ?? null
    );
  }

  // Default: diff/commit tab file list
  if (state.flatViewMode && flatFiles) {
    return formatFlatFileList(
      flatFiles,
      state.selectedIndex,
      state.currentPane === 'files',
      width,
      state.fileListScrollOffset,
      topPaneHeight
    );
  }

  return formatFileList(
    files,
    state.selectedIndex,
    state.currentPane === 'files',
    width,
    state.fileListScrollOffset,
    topPaneHeight,
    hunkCounts
  );
}

import type { HunkBoundary, CombinedHunkInfo } from '../utils/displayRows.js';

export interface BottomPaneResult {
  content: string;
  totalRows: number;
  hunkCount: number;
  hunkBoundaries: HunkBoundary[];
  hunkMapping?: CombinedHunkInfo[];
}

/**
 * Render the bottom pane content for the current tab.
 */
export function renderBottomPane(
  state: UIStateData,
  diff: DiffResult | null,
  historyState: HistoryState | undefined,
  compareSelectionState: CompareSelectionState | undefined,
  explorerSelectedFile: SelectedFile | null,
  commitFlowState: CommitFlowStateData,
  stagedCount: number,
  currentTheme: ThemeName,
  width: number,
  bottomPaneHeight: number,
  selectedHunkIndex?: number,
  isFileStaged?: boolean,
  combinedFileDiffs?: CombinedFileDiffs | null
): BottomPaneResult {
  if (state.bottomTab === 'commit') {
    const content = formatCommitPanel(commitFlowState, stagedCount, width);
    return { content, totalRows: 0, hunkCount: 0, hunkBoundaries: [] };
  }

  if (state.bottomTab === 'history') {
    const selectedCommit = historyState?.selectedCommit ?? null;
    const commitDiff = historyState?.commitDiff ?? null;

    const { content, totalRows } = formatHistoryDiff(
      selectedCommit,
      commitDiff,
      width,
      state.diffScrollOffset,
      bottomPaneHeight,
      currentTheme,
      state.wrapMode
    );

    return { content, totalRows, hunkCount: 0, hunkBoundaries: [] };
  }

  if (state.bottomTab === 'compare') {
    const compareDiff = compareSelectionState?.diff ?? null;

    if (compareDiff) {
      const { content, totalRows } = formatDiff(
        compareDiff,
        width,
        state.diffScrollOffset,
        bottomPaneHeight,
        currentTheme,
        state.wrapMode
      );
      return { content, totalRows, hunkCount: 0, hunkBoundaries: [] };
    }

    return {
      content: '{gray-fg}Select a commit or file to view diff{/gray-fg}',
      totalRows: 0,
      hunkCount: 0,
      hunkBoundaries: [],
    };
  }

  if (state.bottomTab === 'explorer') {
    const content = formatExplorerContent(
      explorerSelectedFile?.path ?? null,
      explorerSelectedFile?.content ?? null,
      width,
      state.explorerFileScrollOffset,
      bottomPaneHeight,
      explorerSelectedFile?.truncated ?? false,
      state.wrapMode
    );

    return { content, totalRows: 0, hunkCount: 0, hunkBoundaries: [] };
  }

  // Flat mode: show combined unstaged+staged diff with section headers
  if (state.flatViewMode && combinedFileDiffs) {
    const result = formatCombinedDiff(
      combinedFileDiffs.unstaged,
      combinedFileDiffs.staged,
      width,
      state.diffScrollOffset,
      bottomPaneHeight,
      currentTheme,
      state.wrapMode,
      selectedHunkIndex
    );
    return {
      content: result.content,
      totalRows: result.totalRows,
      hunkCount: result.hunkCount,
      hunkBoundaries: result.hunkBoundaries,
      hunkMapping: result.hunkMapping,
    };
  }

  // Default: diff tab — pass selectedHunkIndex for hunk gutter
  const { content, totalRows, hunkCount, hunkBoundaries } = formatDiff(
    diff,
    width,
    state.diffScrollOffset,
    bottomPaneHeight,
    currentTheme,
    state.wrapMode,
    selectedHunkIndex,
    isFileStaged
  );

  return { content, totalRows, hunkCount, hunkBoundaries };
}
