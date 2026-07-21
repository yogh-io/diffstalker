/**
 * Shared diff-parsing primitives used by the CLI and web row builders.
 * Browser-safe: no node or UI imports.
 */

import type { DiffLine } from '../git/diff.js';
import { computeWordDiff, areSimilarEnough, WordDiffSegment } from './wordDiff.js';

/** Parsed "@@ -a,b +c,d @@ ctx" hunk header. Counts default to 1 when omitted. */
export interface ParsedHunkHeader {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  /** Trailing context after the closing @@ (usually the enclosing function), trimmed. */
  context: string;
}

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
const GIT_HEADER_RE = /^diff --git a\/.+ b\/(.+)$/;

/**
 * Parse a hunk header line into its ranges. Returns null when the line
 * is not a well-formed "@@ -a,b +c,d @@" header.
 */
export function parseHunkHeader(content: string): ParsedHunkHeader | null {
  const match = HUNK_HEADER_RE.exec(content);
  if (!match) return null;
  return {
    oldStart: parseInt(match[1], 10),
    oldCount: match[2] !== undefined ? parseInt(match[2], 10) : 1,
    newStart: parseInt(match[3], 10),
    newCount: match[4] !== undefined ? parseInt(match[4], 10) : 1,
    context: match[5].trim(),
  };
}

/**
 * Extract the file path from a "diff --git a/... b/..." header line.
 * Returns null for any other header content.
 */
export function extractDiffFilePath(content: string): string | null {
  return GIT_HEADER_RE.exec(content)?.[1] ?? null;
}

/**
 * Width of a line-number gutter: digit count of the largest line number,
 * with a minimum of 3.
 */
export function getLineNumColumnWidth(maxLineNum: number): number {
  return Math.max(3, String(maxLineNum).length);
}

/** Word-diff segments per pair index, for each side of a change run. */
export interface ChangeRunSegments {
  delSegments: Map<number, WordDiffSegment[]>;
  addSegments: Map<number, WordDiffSegment[]>;
}

/**
 * Pair a run of consecutive deletions with the additions that follow it,
 * by position. Each pair whose contents pass areSimilarEnough gets
 * word-level segments from computeWordDiff. getContent supplies each
 * line's display content (callers clean control characters differently).
 */
export function pairChangeRuns(
  deletions: DiffLine[],
  additions: DiffLine[],
  getContent: (line: DiffLine) => string
): ChangeRunSegments {
  const delSegments: Map<number, WordDiffSegment[]> = new Map();
  const addSegments: Map<number, WordDiffSegment[]> = new Map();
  const pairCount = Math.min(deletions.length, additions.length);

  for (let j = 0; j < pairCount; j++) {
    const delContent = getContent(deletions[j]);
    const addContent = getContent(additions[j]);

    if (areSimilarEnough(delContent, addContent)) {
      const { oldSegments, newSegments } = computeWordDiff(delContent, addContent);
      delSegments.set(j, oldSegments);
      addSegments.set(j, newSegments);
    }
  }

  return { delSegments, addSegments };
}
