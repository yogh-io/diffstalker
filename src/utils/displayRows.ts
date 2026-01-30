// Unified row model for all diff views
// Every row = exactly 1 terminal row

import { DiffResult, DiffLine, CompareDiff } from '../git/diff.js';
import { CommitInfo } from '../git/status.js';
import { formatDateAbsolute } from './formatDate.js';
import { isDisplayableDiffLine } from './diffFilters.js';
import { breakLine, getLineRowCount } from './lineBreaking.js';
import { computeWordDiff, areSimilarEnough, WordDiffSegment } from './wordDiff.js';
import { getLanguageFromPath, highlightBlockPreserveBg } from './languageDetection.js';

export type { WordDiffSegment } from './wordDiff.js';

// Unified display row types - every type renders as exactly 1 terminal row
export type DisplayRow =
  | { type: 'diff-header'; content: string }
  | { type: 'diff-hunk'; content: string }
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
  let content: string;
  if (line.type === 'addition' || line.type === 'deletion') {
    content = line.content.slice(1);
  } else if (line.type === 'context') {
    // Context lines start with space
    content = line.content.startsWith(' ') ? line.content.slice(1) : line.content;
  } else {
    content = line.content;
  }
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
      return { type: 'diff-hunk', content: line.content };
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

/**
 * Extract file path from a diff --git header line.
 */
function extractFilePathFromHeader(content: string): string | null {
  const match = content.match(/^diff --git a\/.+ b\/(.+)$/);
  return match ? match[1] : null;
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

/**
 * Build display rows from a DiffResult.
 * Filters out non-displayable lines (index, ---, +++ headers).
 * Pairs consecutive deletions/additions within hunks and computes word-level diffs.
 * Applies block-based syntax highlighting to properly handle multi-line constructs.
 */
export function buildDiffDisplayRows(diff: DiffResult | null): DisplayRow[] {
  if (!diff) return [];

  const filteredLines = diff.lines.filter(isDisplayableDiffLine);
  const rows: DisplayRow[] = [];
  const fileSections: FileSection[] = [];
  let currentSection: FileSection | null = null;

  // Phase 1: Build display rows and collect content streams per file section
  let i = 0;
  while (i < filteredLines.length) {
    const line = filteredLines[i];

    // Headers - start new file section
    if (line.type === 'header') {
      const filePath = extractFilePathFromHeader(line.content);
      if (filePath) {
        if (currentSection) {
          fileSections.push(currentSection);
          rows.push({ type: 'spacer' });
        }
        currentSection = {
          language: getLanguageFromPath(filePath),
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
    const delSegmentsMap: Map<number, WordDiffSegment[]> = new Map();
    const addSegmentsMap: Map<number, WordDiffSegment[]> = new Map();
    const pairCount = Math.min(deletions.length, additions.length);

    for (let j = 0; j < pairCount; j++) {
      const delContent = getLineContent(deletions[j]);
      const addContent = getLineContent(additions[j]);

      if (areSimilarEnough(delContent, addContent)) {
        const { oldSegments, newSegments } = computeWordDiff(delContent, addContent);
        delSegmentsMap.set(j, oldSegments);
        addSegmentsMap.set(j, newSegments);
      }
    }

    for (let j = 0; j < deletions.length; j++) {
      const delLine = deletions[j];
      const delContent = getLineContent(delLine);
      const segments = delSegmentsMap.get(j);
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
      const segments = addSegmentsMap.get(j);
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

  // Phase 2: Apply block highlighting for each file section
  for (const section of fileSections) {
    if (!section.language) continue;

    if (section.oldContent.length > 0) {
      const oldHighlighted = highlightBlockPreserveBg(section.oldContent, section.language);
      for (let j = 0; j < section.oldRowIndices.length; j++) {
        const rowIndex = section.oldRowIndices[j];
        const row = rows[rowIndex];
        const highlighted = oldHighlighted[j];
        if (
          highlighted &&
          highlighted !== (row as { content: string }).content &&
          (row.type === 'diff-del' || row.type === 'diff-context')
        ) {
          (row as { highlighted?: string }).highlighted = highlighted;
        }
      }
    }

    if (section.newContent.length > 0) {
      const newHighlighted = highlightBlockPreserveBg(section.newContent, section.language);
      for (let j = 0; j < section.newRowIndices.length; j++) {
        const rowIndex = section.newRowIndices[j];
        const row = rows[rowIndex];
        const highlighted = newHighlighted[j];
        if (
          highlighted &&
          highlighted !== (row as { content: string }).content &&
          (row.type === 'diff-add' || row.type === 'diff-context')
        ) {
          (row as { highlighted?: string }).highlighted = highlighted;
        }
      }
    }
  }

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
 * Build display rows for compare view from CompareDiff.
 * Combines all file diffs into a single DisplayRow array.
 */
export function buildCompareDisplayRows(compareDiff: CompareDiff | null): DisplayRow[] {
  if (!compareDiff || compareDiff.files.length === 0) {
    return [];
  }

  const rows: DisplayRow[] = [];

  for (const file of compareDiff.files) {
    rows.push(...buildDiffDisplayRows(file.diff));
  }

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
  return Math.max(3, String(max).length);
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

/**
 * Calculate the total row count after wrapping.
 * More efficient than wrapDisplayRows().length when you only need the count.
 */
export function getWrappedRowCount(
  rows: DisplayRow[],
  contentWidth: number,
  wrapEnabled: boolean
): number {
  if (!wrapEnabled) return rows.length;

  const minWidth = 10;
  const effectiveWidth = Math.max(minWidth, contentWidth);

  let count = 0;
  for (const row of rows) {
    if (row.type === 'diff-add' || row.type === 'diff-del' || row.type === 'diff-context') {
      const content = row.content;
      if (!content || content.length <= effectiveWidth) {
        count += 1;
      } else {
        count += getLineRowCount(content, effectiveWidth);
      }
    } else {
      count += 1;
    }
  }

  return count;
}
