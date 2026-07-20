/**
 * Syntax highlighting for the Explorer's file viewer, on highlight.js's
 * `lib/common` build (the ~35 common languages — bundled, no CDN).
 *
 * Language comes from the shared getLanguageFromPath mapping; a language
 * hljs doesn't know (or no language at all) falls back to plain escaped
 * text. Files with any very long line also fall back to plain text for
 * the WHOLE file (like editors do): hljs is ~quadratic on one huge token,
 * and a single ~100k-char line would freeze the tab for minutes.
 *
 * Line endings are normalized first: '\r\n' and a lone '\r' both count
 * as line breaks, so no '\r' ever reaches the rendered rows (a stray CR
 * inside a numbered row would misalign line numbers and leak into copy).
 *
 * Output is per-LINE HTML: hljs emits one HTML string for the whole
 * file whose token spans may cross newlines (block comments, template
 * strings), so splitting re-balances the open span stack on every line —
 * each line closes what it opened and the next line reopens the stack.
 *
 * Safety: every code path escapes. hljs escapes source text inside its
 * value output, the plain fallback escapes manually, and the splitter
 * only ever re-emits hljs's own span tags — so the result is safe to
 * inject via v-html.
 */

import hljs from 'highlight.js/lib/common';
import { getLanguageFromPath } from '@diffstalker/core/view/languageDetection';

export interface HighlightedFile {
  /** Per-line HTML, escaped and span-balanced — safe for v-html. */
  lines: string[];
  /** The hljs language used, or null when rendered as plain text. */
  language: string | null;
}

/** Minimal HTML escape (matches what hljs escapes: & < >, plus quotes). */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

/** hljs's own output grammar: span open tags, close tags, escaped text. */
const TOKEN_PATTERN = /(<span[^>]*>)|(<\/span>)|(\n)/g;

/**
 * Split one highlighted HTML string into lines, keeping every line's
 * span markup balanced: at a newline all open spans close, and the next
 * line reopens the same stack.
 */
export function splitHighlightedHtml(html: string): string[] {
  const lines: string[] = [];
  const stack: string[] = [];
  let line = '';
  let last = 0;

  for (const match of html.matchAll(TOKEN_PATTERN)) {
    line += html.slice(last, match.index);
    last = match.index + match[0].length;

    if (match[1]) {
      stack.push(match[1]);
      line += match[1];
    } else if (match[2]) {
      stack.pop();
      line += match[2];
    } else {
      // Newline: close the open stack, emit, reopen on the next line.
      lines.push(line + '</span>'.repeat(stack.length));
      line = stack.join('');
    }
  }
  line += html.slice(last);
  lines.push(line);
  return lines;
}

/**
 * Above this per-line length, skip hljs for the whole file. hljs's
 * regex work is ~quadratic on a single huge token; one long minified
 * line can freeze the main thread for minutes. Editors draw the same
 * line: past a threshold, no syntax highlighting.
 */
export const MAX_HIGHLIGHT_LINE_LENGTH = 2000;

/**
 * Highlight file content into per-line HTML. Unknown/unsupported
 * languages — and files containing any oversized line — render as plain
 * escaped lines (language: null). A trailing newline does NOT produce a
 * phantom empty last line.
 */
export function highlightContent(content: string, filePath: string): HighlightedFile {
  // Normalize line endings: CRLF and lone CR both become '\n', so no
  // '\r' survives into the rendered rows.
  const normalized = content.replace(/\r\n?/g, '\n');
  // Drop the trailing newline's empty tail before splitting: a file
  // ending in '\n' has N lines, not N + an empty one.
  const trimmed = normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized;
  const rawLines = trimmed.split('\n');

  const detected = getLanguageFromPath(filePath);
  const language =
    detected !== null && detected !== 'plaintext' && hljs.getLanguage(detected) !== undefined
      ? detected
      : null;

  if (language === null || rawLines.some((line) => line.length > MAX_HIGHLIGHT_LINE_LENGTH)) {
    return { lines: rawLines.map(escapeHtml), language: null };
  }

  const html = hljs.highlight(trimmed, { language, ignoreIllegals: true }).value;
  return { lines: splitHighlightedHtml(html), language };
}
