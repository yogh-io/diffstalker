/**
 * Optional syntax highlighting for DiffView's content rows, layered over
 * the existing word-level diff — the second viewing mode (a global,
 * persisted toggle). Off, rows render as before (plain text, or word-hl
 * spans on similar del/add pairs); on, each content line is tokenized by
 * highlight.js and rendered as colored runs, with the word-diff "changed"
 * background preserved on top.
 *
 * The hard case is a row that has BOTH: word-diff segments (character
 * ranges of the changed words) AND syntax tokens (highlight.js spans).
 * Their boundaries don't align, so we flatten the highlighted line to a
 * flat run list, then merge those runs with the word segments over the
 * same character sequence — every output piece carries a syntax class
 * (foreground color) and a changed flag (word-hl background). The two
 * concerns compose cleanly because one paints text, the other paints
 * behind it.
 *
 * No v-html: runs are flattened to DECODED text (hljs's HTML entities
 * undone), so the caller renders each piece as a plain `{{ text }}` span
 * that Vue re-escapes — the injection surface highlight.js's raw HTML
 * would open never exists here.
 *
 * Per-line highlighting (not whole-file) is inherent to a diff: a hunk
 * interleaves two file versions, so there is no single valid document to
 * feed hljs. Cross-line constructs (block comments, template strings)
 * therefore aren't carried between rows — the same tradeoff every
 * hunk-only diff highlighter makes.
 *
 * Results are memoized per row object + mode signature. Rows are
 * immutable per model build, so a new diff naturally evicts stale
 * entries (WeakMap), and repeated renders (the relative-time ticker)
 * hit the cache instead of re-tokenizing.
 */

import hljs from './hljs';
import { getLanguageFromPath } from '@diffstalker/core/view/languageDetection';
import type { WordDiffSegment } from '@diffstalker/core/view/wordDiff';
import type { DiffContentRow } from './diffRows';

/** One rendered run of a content line. */
export interface DiffPiece {
  text: string;
  /** highlight.js token class (e.g. 'hljs-keyword'), or '' for plain text. */
  cls: string;
  /** True when this run falls inside a changed word-diff segment (word-hl). */
  changed: boolean;
}

/**
 * The hljs language for a path, or null when unsupported / plaintext
 * (caller renders the plain path). Mirrors utils/highlight's gate so the
 * diff and the explorer file view agree on what is highlightable.
 */
export function diffLanguage(filePath: string | null | undefined): string | null {
  if (!filePath) return null;
  const detected = getLanguageFromPath(filePath);
  return detected !== null && detected !== 'plaintext' && hljs.getLanguage(detected) !== undefined
    ? detected
    : null;
}

/**
 * Above this per-line length, skip hljs (its regex work is ~quadratic on
 * one huge token). Matches utils/highlight's MAX_HIGHLIGHT_LINE_LENGTH.
 */
export const MAX_HIGHLIGHT_LINE_LENGTH = 2000;

interface Run {
  text: string;
  cls: string;
}

/** hljs's output grammar: a span open (maybe with class), a close, or text. */
const TOKEN_RE = /<span[^>]*class="([^"]*)"[^>]*>|<span[^>]*>|<\/span>|[^<]+/g;

/** Undo the entities hljs escapes into its value output. */
function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Flatten one highlighted line into a linear run list, each run tagged
 * with the innermost open hljs class. Nested scopes (a subst inside a
 * string) collapse to the inner token's color — a minor fidelity loss
 * that keeps the merge one-dimensional.
 */
function highlightToRuns(text: string, language: string): Run[] {
  const html = hljs.highlight(text, { language, ignoreIllegals: true }).value;
  const runs: Run[] = [];
  const stack: string[] = [];
  for (const match of html.matchAll(TOKEN_RE)) {
    const token = match[0];
    if (token.charCodeAt(0) === 0x3c /* '<' */) {
      if (token[1] === '/') stack.pop();
      else stack.push(match[1] ?? '');
    } else {
      runs.push({ text: decodeEntities(token), cls: stack[stack.length - 1] ?? '' });
    }
  }
  return runs;
}

/** Fold neighbouring pieces that share a class and changed flag. */
function coalesce(pieces: DiffPiece[]): DiffPiece[] {
  const out: DiffPiece[] = [];
  for (const piece of pieces) {
    const last = out[out.length - 1];
    if (last && last.cls === piece.cls && last.changed === piece.changed) last.text += piece.text;
    else out.push({ ...piece });
  }
  return out;
}

/**
 * Merge syntax runs with word-diff segments over the same characters.
 * Both partition the identical line, so a two-pointer walk emits a piece
 * at every boundary of either, carrying the run's class and the
 * segment's changed flag. Without segments, runs map straight through.
 */
function mergePieces(runs: Run[], segments: WordDiffSegment[] | undefined): DiffPiece[] {
  if (!segments || segments.length === 0) {
    return runs.map((run) => ({ text: run.text, cls: run.cls, changed: false }));
  }
  const pieces: DiffPiece[] = [];
  let ri = 0;
  let si = 0;
  let ro = 0;
  let so = 0;
  while (ri < runs.length && si < segments.length) {
    const take = Math.min(runs[ri].text.length - ro, segments[si].text.length - so);
    if (take > 0) {
      pieces.push({
        text: runs[ri].text.slice(ro, ro + take),
        cls: runs[ri].cls,
        changed: segments[si].type === 'changed',
      });
    }
    ro += take;
    so += take;
    if (ro === runs[ri].text.length) {
      ri++;
      ro = 0;
    }
    if (si < segments.length && so === segments[si].text.length) {
      si++;
      so = 0;
    }
  }
  // Defensive: if the two partitions disagreed on total length, keep any
  // leftover run text (uncolored by a segment) rather than dropping it.
  while (ri < runs.length) {
    const text = runs[ri].text.slice(ro);
    if (text) pieces.push({ text, cls: runs[ri].cls, changed: false });
    ri++;
    ro = 0;
  }
  return pieces;
}

const cache = new WeakMap<DiffContentRow, { sig: string; pieces: DiffPiece[] | null }>();

/**
 * Pieces for a content row when syntax highlighting should apply, else
 * null — signaling the caller to keep its plain / word-diff-only render
 * (so word-hl still works for languages hljs doesn't know). Memoized per
 * row + mode signature.
 */
export function syntaxPieces(
  row: DiffContentRow,
  language: string | null,
  enabled: boolean
): DiffPiece[] | null {
  const sig = `${enabled ? '1' : '0'}|${language ?? ''}`;
  const hit = cache.get(row);
  if (hit && hit.sig === sig) return hit.pieces;
  const pieces =
    // A "\ No newline" row is git's prose, not code — highlighting it
    // would colour the sentence as if it were part of the file.
    enabled &&
    row.kind !== 'no-newline' &&
    language !== null &&
    row.content.length <= MAX_HIGHLIGHT_LINE_LENGTH
      ? coalesce(mergePieces(highlightToRuns(row.content, language), row.segments))
      : null;
  cache.set(row, { sig, pieces });
  return pieces;
}
