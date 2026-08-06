/**
 * What the outline panel says, for every state it can be in.
 *
 * Seven distinct states, seven distinct strings, and that is the whole
 * point of this module existing. The states are easy to collapse — "no
 * symbols", "no outline for this language", "outline unavailable" and
 * "binary file" all look like "nothing to show" from the template's point
 * of view — and collapsing any two of them tells the reader something
 * false about their file.
 *
 * Keeping the decision here rather than in a Vue template also keeps it
 * unit-testable without mounting anything, and keeps the template out of
 * cognitive-complexity territory.
 *
 * Precedence is flags first, then outcome: a binary file has no outline
 * for a reason that has nothing to do with the parser, so its own reason
 * wins over whatever the parser said.
 */

import type { FileSymbol, SymbolOutcome } from '../symbols/types.js';

export type OutlineStatus =
  /** Symbols to show. */
  | { kind: 'symbols'; symbols: FileSymbol[]; note: string | null }
  /** Nothing to show, and why. */
  | { kind: 'note'; note: string };

/** The subset of a file read this decision needs. */
export interface OutlineFile {
  path: string;
  binary: boolean;
  tooLarge: boolean;
  truncated: boolean;
  /** Lines in the whole file, which may exceed what was returned. */
  totalLines: number;
}

/** Lines the daemon returns at most; past this the outline is partial. */
const DISPLAY_LINE_CAP = 5000;

function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot) : base;
}

export function outlineStatus(
  file: OutlineFile,
  outcome: SymbolOutcome | null
): OutlineStatus {
  // Flags first: these are facts about the file, not about the parser.
  if (file.binary) return { kind: 'note', note: 'Binary file — no outline.' };
  if (file.tooLarge) return { kind: 'note', note: 'File too large to outline.' };

  if (outcome === null) return { kind: 'note', note: 'Outline not loaded.' };

  if (outcome.status === 'unavailable') {
    // Deliberately the same words for both reasons: to a reader, "the
    // parser timed out" and "the parser died" are one thing — it did not
    // answer. They stay separate in the data for the log.
    return { kind: 'note', note: 'Outline unavailable for this file.' };
  }

  if (outcome.status === 'unsupported') {
    if (outcome.reason === 'no-script-block') {
      return { kind: 'note', note: 'No <script> block in this component.' };
    }
    // Named, so it reads as a deliberate boundary rather than a failure.
    return { kind: 'note', note: `No outline for ${extensionOf(file.path)} files.` };
  }

  if (outcome.symbols.length === 0) {
    return { kind: 'note', note: 'No symbols in this file.' };
  }

  // Symbols, plus the honesty note when the outline describes only the
  // part of the file that was actually read.
  const note =
    file.truncated && file.totalLines > DISPLAY_LINE_CAP
      ? `Outline of the first ${DISPLAY_LINE_CAP.toLocaleString()} of ${file.totalLines.toLocaleString()} lines.`
      : null;

  return { kind: 'symbols', symbols: outcome.symbols, note };
}
