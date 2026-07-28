/**
 * splitDiffByFile: split a whole-tree DiffResult into per-file
 * DiffResults, grouped by "diff --git a/… b/…" section headers — the
 * same boundary buildDiffModel's section grouping keys on
 * (extractDiffFilePath).
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
 *
 * Lives in view/ (browser-safe, no node deps): the web client splits
 * whole-tree pulls with it and the daemon-side JournalManager splits
 * each observation's HEAD diff with it — one copy for both.
 */

import type { DiffLine, DiffResult } from '../git/diffParse.js';
import { extractDiffFilePath } from './diffPrimitives.js';

/**
 * Split a whole-tree diff into per-file DiffResults, keyed by path.
 *
 * One pass over the parsed lines — they ARE the diff (raw text is derived
 * from them), so the old second pass over the raw string is gone. Line
 * objects are carried across as-is, keeping their editedAt stamps.
 */
export function splitDiffByFile(diff: DiffResult): Map<string, DiffResult> {
  const groups = new Map<string, DiffLine[]>();

  let current: DiffLine[] | null = null;
  for (const line of diff.lines) {
    if (line.type === 'header') {
      const path = extractDiffFilePath(line.content);
      if (path !== null) {
        // A repeated path merges into its existing section (a file can be
        // both staged and unstaged in one whole-tree read).
        current = groups.get(path) ?? [];
        groups.set(path, current);
      }
    }
    current?.push(line);
  }

  const result = new Map<string, DiffResult>();
  for (const [path, lines] of groups) {
    result.set(path, { lines });
  }
  return result;
}
