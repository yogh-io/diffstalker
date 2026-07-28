// Unified row model for all diff views
// Every row = exactly 1 terminal row

import { DiffResult, DiffLine } from '@diffstalker/core/git/diff';
import { CommitInfo } from '@diffstalker/core/git/status';
import { formatDateAbsolute } from '@diffstalker/core/view/formatDate';
import { isDisplayableDiffLine } from '@diffstalker/core/view/diffFilters';
import { breakLine } from '@diffstalker/core/view/lineBreaking';
import { WordDiffSegment } from '@diffstalker/core/view/wordDiff';
import {
  extractDiffFilePath,
  getLineNumColumnWidth,
  pairChangeRuns,
} from '@diffstalker/core/view/diffPrimitives';
import { getSupportedLanguage, highlightBlockPreserveBg } from './syntaxHighlight.js';
import { getLineContent as extractLineContent } from '@diffstalker/core/view/diffRowCalculations';

export type { WordDiffSegment } from '@diffstalker/core/view/wordDiff';

// Unified display row types - every type renders as exactly 1 terminal row
export type DisplayRow =
  | { type: 'diff-header'; content: string }
  | { type: 'diff-hunk'; content: string; editedAt?: number }
  | {
      type: 'diff-add';
      lineNum?: number;
      content: string;
      wordDiffSegments?: WordDiffSegment[];
      highlighted?: string;
    }
  | {
      type: 'diff-del';
      lineNum?: number;
      content: string;
      wordDiffSegments?: WordDiffSegment[];
      highlighted?: string;
    }
  | { type: 'diff-context'; lineNum?: number; content: string; highlighted?: string }
  | { type: 'commit-header'; content: string }
  | { type: 'commit-message'; content: string }
  | { type: 'spacer' };

/**
 * Get the text content from a diff line (strip leading +/-/space and control chars)
 */
function getLineContent(line: DiffLine): string {
  const content = extractLineContent(line);
  // Strip control characters that cause rendering artifacts
  // and convert tabs to spaces for consistent width calculation
  return content.replace(/[\x00-\x08\x0a-\x1f\x7f]/g, '').replace(/\t/g, '    ');
}

/**
 * Convert a DiffLine to a DisplayRow
 */
function convertDiffLineToDisplayRow(line: DiffLine): DisplayRow {
  switch (line.type) {
    case 'header':
      return { type: 'diff-header', content: line.content };
    case 'hunk':
      return { type: 'diff-hunk', content: line.content, editedAt: line.editedAt };
    case 'addition':
      return {
        type: 'diff-add',
        lineNum: line.newLineNum,
        content: getLineContent(line),
      };
    case 'deletion':
      return {
        type: 'diff-del',
        lineNum: line.oldLineNum,
        content: getLineContent(line),
      };
    case 'context':
      return {
        type: 'diff-context',
        lineNum: line.oldLineNum ?? line.newLineNum,
        content: getLineContent(line),
      };
  }
}

// Track file sections for block highlighting
// Each file section has: language, startRowIndex, and content streams
interface FileSection {
  language: string | null;
  startRowIndex: number;
  // Old stream: context + deletions (for highlighting with old file context)
  oldContent: string[];
  oldRowIndices: number[]; // Maps oldContent index -> row index
  // New stream: context + additions (for highlighting with new file context)
  newContent: string[];
  newRowIndices: number[]; // Maps newContent index -> row index
}

/** Result of building raw display rows before syntax highlighting. */
interface RawDiffResult {
  rows: DisplayRow[];
  fileSections: FileSection[];
}

/** Type guard for rows that can receive syntax highlighting. */
function isHighlightable(
  row: DisplayRow
): row is DisplayRow & { type: 'diff-add' | 'diff-del' | 'diff-context' } {
  return row.type === 'diff-add' || row.type === 'diff-del' || row.type === 'diff-context';
}

/**
 * Build display rows from filtered diff lines in a single pass.
 * Collects content streams per file section for later syntax highlighting.
 * Pairs consecutive del/add lines for word-level diff computation.
 */
function buildRawDiffRows(filteredLines: DiffLine[]): RawDiffResult {
  const rows: DisplayRow[] = [];
  const fileSections: FileSection[] = [];
  let currentSection: FileSection | null = null;

  let i = 0;
  while (i < filteredLines.length) {
    const line = filteredLines[i];

    // Headers - start new file section
    if (line.type === 'header') {
      const filePath = extractDiffFilePath(line.content);
      if (filePath) {
        if (currentSection) {
          fileSections.push(currentSection);
          rows.push({ type: 'spacer' });
        }
        currentSection = {
          language: getSupportedLanguage(filePath),
          startRowIndex: rows.length,
          oldContent: [],
          oldRowIndices: [],
          newContent: [],
          newRowIndices: [],
        };
      }
      rows.push(convertDiffLineToDisplayRow(line));
      i++;
      continue;
    }

    if (line.type === 'hunk') {
      rows.push(convertDiffLineToDisplayRow(line));
      i++;
      continue;
    }

    // Context lines - add to both streams
    if (line.type === 'context') {
      const content = getLineContent(line);
      const rowIndex = rows.length;

      rows.push({
        type: 'diff-context',
        lineNum: line.oldLineNum ?? line.newLineNum,
        content,
      });

      if (currentSection && currentSection.language) {
        currentSection.oldContent.push(content);
        currentSection.oldRowIndices.push(rowIndex);
        currentSection.newContent.push(content);
        currentSection.newRowIndices.push(rowIndex);
      }

      i++;
      continue;
    }

    // Collect consecutive deletions
    const deletions: DiffLine[] = [];
    while (i < filteredLines.length && filteredLines[i].type === 'deletion') {
      deletions.push(filteredLines[i]);
      i++;
    }

    // Collect consecutive additions (immediately following deletions)
    const additions: DiffLine[] = [];
    while (i < filteredLines.length && filteredLines[i].type === 'addition') {
      additions.push(filteredLines[i]);
      i++;
    }

    // Pair deletions with additions for word-level diff
    const { delSegments, addSegments } = pairChangeRuns(deletions, additions, getLineContent);

    for (let j = 0; j < deletions.length; j++) {
      const delLine = deletions[j];
      const delContent = getLineContent(delLine);
      const segments = delSegments.get(j);
      const rowIndex = rows.length;

      rows.push({
        type: 'diff-del',
        lineNum: delLine.oldLineNum,
        content: delContent,
        ...(segments && { wordDiffSegments: segments }),
      });

      if (currentSection && currentSection.language && !segments) {
        currentSection.oldContent.push(delContent);
        currentSection.oldRowIndices.push(rowIndex);
      }
    }

    for (let j = 0; j < additions.length; j++) {
      const addLine = additions[j];
      const addContent = getLineContent(addLine);
      const segments = addSegments.get(j);
      const rowIndex = rows.length;

      rows.push({
        type: 'diff-add',
        lineNum: addLine.newLineNum,
        content: addContent,
        ...(segments && { wordDiffSegments: segments }),
      });

      if (currentSection && currentSection.language && !segments) {
        currentSection.newContent.push(addContent);
        currentSection.newRowIndices.push(rowIndex);
      }
    }
  }

  if (currentSection) {
    fileSections.push(currentSection);
  }

  return { rows, fileSections };
}

/**
 * Highlight a content stream and map results back to display rows.
 * Only applies highlighting to rows that match the expected types.
 */
function applyStreamHighlighting(
  rows: DisplayRow[],
  content: string[],
  rowIndices: number[],
  language: string,
  allowedTypes: ReadonlySet<string>
): void {
  if (content.length === 0) return;

  const highlighted = highlightBlockPreserveBg(content, language);
  for (let j = 0; j < rowIndices.length; j++) {
    const rowIndex = rowIndices[j];
    const row = rows[rowIndex];
    const hl = highlighted[j];
    if (hl && isHighlightable(row) && allowedTypes.has(row.type) && hl !== row.content) {
      row.highlighted = hl;
    }
  }
}

const OLD_STREAM_TYPES: ReadonlySet<string> = new Set(['diff-del', 'diff-context']);
const NEW_STREAM_TYPES: ReadonlySet<string> = new Set(['diff-add', 'diff-context']);

/**
 * Apply block-based syntax highlighting to display rows.
 * Each file section's old and new content streams are highlighted separately,
 * then mapped back to the corresponding row indices.
 */
function applySyntaxHighlighting(rows: DisplayRow[], fileSections: FileSection[]): void {
  for (const section of fileSections) {
    if (!section.language) continue;
    applyStreamHighlighting(
      rows,
      section.oldContent,
      section.oldRowIndices,
      section.language,
      OLD_STREAM_TYPES
    );
    applyStreamHighlighting(
      rows,
      section.newContent,
      section.newRowIndices,
      section.language,
      NEW_STREAM_TYPES
    );
  }
}

/**
 * Build display rows from a DiffResult.
 * Filters out non-displayable lines (index, ---, +++ headers).
 * Pairs consecutive deletions/additions within hunks and computes word-level diffs.
 * Applies block-based syntax highlighting to properly handle multi-line constructs.
 */
export function buildDiffDisplayRows(diff: DiffResult | null): DisplayRow[] {
  if (!diff) return [];

  const filteredLines = diff.lines.filter(isDisplayableDiffLine);
  const { rows, fileSections } = buildRawDiffRows(filteredLines);
  applySyntaxHighlighting(rows, fileSections);
  return rows;
}

/**
 * Build display rows from commit + diff (for History tab).
 * Includes commit metadata, message, then diff lines.
 */
export function buildHistoryDisplayRows(
  commit: CommitInfo | null,
  diff: DiffResult | null
): DisplayRow[] {
  const rows: DisplayRow[] = [];

  if (commit) {
    rows.push({ type: 'commit-header', content: `commit ${commit.hash}` });
    rows.push({ type: 'commit-header', content: `Author: ${commit.author}` });
    rows.push({ type: 'commit-header', content: `Date:   ${formatDateAbsolute(commit.date)}` });
    rows.push({ type: 'spacer' });

    for (const line of commit.message.split('\n')) {
      rows.push({ type: 'commit-message', content: `    ${line}` });
    }
    rows.push({ type: 'spacer' });
  }

  rows.push(...buildDiffDisplayRows(diff));
  return rows;
}

/**
 * Get the maximum line number width needed for alignment.
 * Scans all rows with line numbers and returns the digit count.
 */
export function getDisplayRowsLineNumWidth(rows: DisplayRow[]): number {
  let max = 0;
  for (const row of rows) {
    if ('lineNum' in row && row.lineNum !== undefined) {
      max = Math.max(max, row.lineNum);
    }
  }
  return getLineNumColumnWidth(max);
}

// Extended row type with wrap metadata
export type WrappedDisplayRow = DisplayRow & {
  isContinuation?: boolean;
};

/**
 * Expand display rows for wrap mode.
 * Long content lines are broken into multiple rows with continuation markers.
 * Headers, hunks, and metadata rows remain truncated (not wrapped).
 *
 * @param rows - Original display rows
 * @param contentWidth - Available width for content (after line num, symbol, padding)
 * @param wrapEnabled - Whether wrap mode is enabled
 * @returns Array of rows, potentially expanded with continuations
 */
export function wrapDisplayRows(
  rows: DisplayRow[],
  contentWidth: number,
  wrapEnabled: boolean
): WrappedDisplayRow[] {
  if (!wrapEnabled) return rows;

  // Minimum content width to prevent excessive segments
  const minWidth = 10;
  const effectiveWidth = Math.max(minWidth, contentWidth);

  const result: WrappedDisplayRow[] = [];

  for (const row of rows) {
    // Only wrap diff content lines (add, del, context)
    if (row.type === 'diff-add' || row.type === 'diff-del' || row.type === 'diff-context') {
      const content = row.content;

      // Skip wrapping for empty or short content
      if (!content || content.length <= effectiveWidth) {
        result.push(row);
        continue;
      }

      const segments = breakLine(content, effectiveWidth);

      for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        result.push({
          ...row,
          content: segment.text,
          lineNum: segment.isContinuation ? undefined : row.lineNum,
          isContinuation: segment.isContinuation,
        });
      }
    } else {
      // Headers, hunks, commit metadata - don't wrap
      result.push(row);
    }
  }

  return result;
}

export interface HunkBoundary {
  startRow: number; // index of the @@ row
  endRow: number; // exclusive end (next @@, diff-header, spacer, or array end)
  editedAt?: number; // when this hunk's content was last observed to change
}

/**
 * Find hunk boundaries in a DisplayRow or WrappedDisplayRow array.
 * Each hunk spans from a 'diff-hunk' row to the next 'diff-hunk', 'diff-header', 'spacer', or end.
 */
export function getHunkBoundaries(rows: (DisplayRow | WrappedDisplayRow)[]): HunkBoundary[] {
  const boundaries: HunkBoundary[] = [];
  let currentStart = -1;
  let currentEditedAt: number | undefined;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const type = row.type;
    if (type === 'diff-hunk') {
      if (currentStart !== -1) {
        boundaries.push({ startRow: currentStart, endRow: i, editedAt: currentEditedAt });
      }
      currentStart = i;
      currentEditedAt = row.editedAt;
    } else if (type === 'diff-header' || type === 'spacer') {
      if (currentStart !== -1) {
        boundaries.push({ startRow: currentStart, endRow: i, editedAt: currentEditedAt });
        currentStart = -1;
      }
    }
  }

  if (currentStart !== -1) {
    boundaries.push({ startRow: currentStart, endRow: rows.length, editedAt: currentEditedAt });
  }

  return boundaries;
}

/**
 * Info about which source a hunk in the combined view came from.
 */
export interface CombinedHunkInfo {
  source: 'unstaged' | 'staged';
  hunkIndex: number;
}

/**
 * Parse the index-referenced line number from a hunk header.
 * Staged diffs (HEAD→index): use +new (new-side = index lines).
 * Unstaged diffs (index→working tree): use -old (old-side = index lines).
 */
function parseHunkSortKey(hunkContent: string, source: 'unstaged' | 'staged'): number {
  const m = hunkContent.match(/@@ -(\d+)(?:,\d+)? \+(\d+)/);
  if (!m) return 0;
  return source === 'staged' ? parseInt(m[2], 10) : parseInt(m[1], 10);
}

interface ExtractedHunk {
  headerLine: DiffLine;
  bodyLines: DiffLine[];
  sortKey: number;
  source: 'unstaged' | 'staged';
  hunkIndex: number;
}

/**
 * Extract individual hunks from a DiffResult's lines.
 * Returns file-level header lines separately.
 */
function extractHunks(
  diff: DiffResult | null,
  source: 'unstaged' | 'staged'
): { fileHeaders: DiffLine[]; hunks: ExtractedHunk[] } {
  if (!diff || diff.lines.length === 0) return { fileHeaders: [], hunks: [] };

  const fileHeaders: DiffLine[] = [];
  const hunks: ExtractedHunk[] = [];
  let currentHunk: ExtractedHunk | null = null;
  let hunkIdx = 0;

  for (const line of diff.lines) {
    if (line.type === 'header') {
      if (currentHunk) {
        hunks.push(currentHunk);
        currentHunk = null;
      }
      fileHeaders.push(line);
    } else if (line.type === 'hunk') {
      if (currentHunk) hunks.push(currentHunk);
      currentHunk = {
        headerLine: line,
        bodyLines: [],
        sortKey: parseHunkSortKey(line.content, source),
        source,
        hunkIndex: hunkIdx++,
      };
    } else if (currentHunk) {
      currentHunk.bodyLines.push(line);
    }
  }
  if (currentHunk) hunks.push(currentHunk);

  return { fileHeaders, hunks };
}

/**
 * Build combined display rows from unstaged and staged diffs for the same file.
 * Hunks are interleaved by file position (index line number) into a single
 * unified view. Returns display rows and a mapping from combined hunk index
 * to source (unstaged/staged) and original hunk index.
 */
export function buildCombinedDiffDisplayRows(
  unstaged: DiffResult | null,
  staged: DiffResult | null
): { rows: DisplayRow[]; hunkMapping: CombinedHunkInfo[] } {
  const u = extractHunks(unstaged, 'unstaged');
  const s = extractHunks(staged, 'staged');

  const allHunks = [...u.hunks, ...s.hunks];
  allHunks.sort((a, b) => a.sortKey - b.sortKey);

  // Build a merged DiffLine array: file headers from whichever has them, then sorted hunks
  const fileHeaders = u.fileHeaders.length > 0 ? u.fileHeaders : s.fileHeaders;
  const mergedLines: DiffLine[] = [...fileHeaders];
  const hunkMapping: CombinedHunkInfo[] = [];

  for (const hunk of allHunks) {
    mergedLines.push(hunk.headerLine, ...hunk.bodyLines);
    hunkMapping.push({ source: hunk.source, hunkIndex: hunk.hunkIndex });
  }

  const rows = buildDiffDisplayRows({ lines: mergedLines });
  return { rows, hunkMapping };
}
