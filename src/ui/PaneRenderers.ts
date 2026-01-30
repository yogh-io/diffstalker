import type { UIStateData } from '../state/UIState.js';
import type { CommitFlowStateData } from '../state/CommitFlowState.js';
import type { FileEntry, CommitInfo } from '../git/status.js';
import type { DiffResult, CompareDiff } from '../git/diff.js';
import type { ExplorerState } from '../core/ExplorerStateManager.js';
import type { HistoryState, CompareState, CompareSelectionState } from '../core/GitStateManager.js';
import type { CompareListSelection } from './widgets/CompareListView.js';
import type { ThemeName } from '../themes.js';
import type { SelectedFile } from '../core/ExplorerStateManager.js';

import { formatFileList } from './widgets/FileList.js';
import { formatHistoryView } from './widgets/HistoryView.js';
import { formatCompareListView } from './widgets/CompareListView.js';
import { formatExplorerView } from './widgets/ExplorerView.js';
import { formatDiff, formatHistoryDiff } from './widgets/DiffView.js';
import { formatCommitPanel } from './widgets/CommitPanel.js';
import { formatExplorerContent } from './widgets/ExplorerContent.js';

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
  topPaneHeight: number
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

  // Default: diff tab file list
  return formatFileList(
    files,
    state.selectedIndex,
    state.currentPane === 'files',
    width,
    state.fileListScrollOffset,
    topPaneHeight
  );
}

export interface BottomPaneResult {
  content: string;
  totalRows: number;
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
  bottomPaneHeight: number
): BottomPaneResult {
  if (state.bottomTab === 'commit') {
    const content = formatCommitPanel(commitFlowState, stagedCount, width);
    return { content, totalRows: 0 };
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

    return { content, totalRows };
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
      return { content, totalRows };
    }

    return { content: '{gray-fg}Select a commit or file to view diff{/gray-fg}', totalRows: 0 };
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

    return { content, totalRows: 0 };
  }

  // Default: diff tab
  const { content, totalRows } = formatDiff(
    diff,
    width,
    state.diffScrollOffset,
    bottomPaneHeight,
    currentTheme,
    state.wrapMode
  );

  return { content, totalRows };
}
