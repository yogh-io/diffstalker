/**
 * splitDiffByFile: split a whole-tree DiffResult into per-file
 * DiffResults, grouped by "diff --git a/… b/…" section headers — the
 * same boundary buildDiffModel's section grouping keys on
 * (extractDiffFilePath, shared from core).
 *
 * Both halves of the DiffResult are split in one shape:
 * - `raw` is regrouped from the raw text, each per-file raw ending in
 *   exactly one trailing newline — byte-identical to what a per-file
 *   `GET /diff?path=…` returns, which is what makes raw-string value
 *   comparison work across mixed whole-tree/per-file pulls;
 * - `lines` are regrouped from the ALREADY-PARSED DiffLines (never
 *   re-parsed), so daemon-side annotations like per-hunk editedAt
 *   stamps survive the split.
 *
 * Content before the first "diff --git" header (not valid git-diff
 * output) is dropped. A path appearing in two sections (git never
 * emits this) merges into one entry in first-seen order.
 */

import type { DiffLine, DiffResult } from '@diffstalker/core/git/diff';
import { extractDiffFilePath } from '@diffstalker/core/view/diffPrimitives';

interface FileGroup {
  rawLines: string[];
  lines: DiffLine[];
}

/** Split a whole-tree diff into per-file DiffResults, keyed by path. */
export function splitDiffByFile(diff: DiffResult): Map<string, DiffResult> {
  const groups = new Map<string, FileGroup>();

  // Pass 1: group the raw text by "diff --git" boundaries.
  const rawLines = diff.raw.split('\n');
  // Drop the trailing empty string from git's final newline, otherwise
  // it lands as a phantom last line on the final section.
  if (rawLines.length > 1 && rawLines[rawLines.length - 1] === '') {
    rawLines.pop();
  }
  let current: FileGroup | null = null;
  for (const line of rawLines) {
    if (line.startsWith('diff --git')) {
      const path = extractDiffFilePath(line);
      if (path !== null) {
        current = groups.get(path) ?? { rawLines: [], lines: [] };
        groups.set(path, current);
      }
    }
    current?.rawLines.push(line);
  }

  // Pass 2: the same grouping over the parsed lines (1:1 with the raw
  // text), keeping the line objects — and their editedAt stamps — as-is.
  let currentLines: DiffLine[] | null = null;
  for (const line of diff.lines) {
    if (line.type === 'header') {
      const path = extractDiffFilePath(line.content);
      if (path !== null) {
        currentLines = groups.get(path)?.lines ?? null;
      }
    }
    currentLines?.push(line);
  }

  const result = new Map<string, DiffResult>();
  for (const [path, group] of groups) {
    result.set(path, { raw: group.rawLines.join('\n') + '\n', lines: group.lines });
  }
  return result;
}
