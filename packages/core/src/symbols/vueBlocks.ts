/**
 * Find the `<script>` blocks in a Vue single-file component.
 *
 * There is no Vue grammar to ship, so the script blocks are handed to the
 * TypeScript parser as included ranges. Ranges rather than a substring is
 * what keeps line numbers file-absolute: the parser sees the real offsets,
 * so a symbol on line 40 of the file reports line 40, with no arithmetic
 * for a caller to get wrong.
 *
 * **Plural, and that is the point.** A component may legally carry two —
 * `<script setup>` beside a plain `<script>` — and three files in this
 * repo already do. A scanner that returns the first block silently drops
 * the symbols in the other.
 *
 * This is a scanner, not a parser, and it has no upstream to inherit fixes
 * from. So it is written to fail toward NOTHING rather than toward wrong:
 * a block counts only when an opening tag, a closing tag and a non-empty
 * body are all positively identified. An SFC shape it does not understand
 * yields no range, which surfaces as "no script block found" — never as
 * symbols from the wrong offsets.
 *
 * Indices are UTF-16 code units, matching JavaScript string offsets and
 * what web-tree-sitter expects.
 */

import type { IncludedRange } from './types.js';

/** Spans of `<!-- … -->`, so a commented-out block is not mistaken for one. */
function commentSpans(content: string): Array<[start: number, end: number]> {
  const spans: Array<[number, number]> = [];
  let from = 0;
  for (;;) {
    const open = content.indexOf('<!--', from);
    if (open === -1) break;
    const close = content.indexOf('-->', open + 4);
    // An unterminated comment swallows the rest of the file — which is
    // also how a browser would read it.
    const end = close === -1 ? content.length : close + 3;
    spans.push([open, end]);
    if (close === -1) break;
    from = end;
  }
  return spans;
}

function insideAny(spans: Array<[number, number]>, index: number): boolean {
  return spans.some(([start, end]) => index >= start && index < end);
}

/** Line and column of `index`, both file-absolute. Rows are 0-based. */
function positionAt(content: string, index: number): { row: number; column: number } {
  let row = 0;
  let lineStart = 0;
  for (let i = 0; i < index; i++) {
    if (content.charCodeAt(i) === 10) {
      row += 1;
      lineStart = i + 1;
    }
  }
  return { row, column: index - lineStart };
}

/**
 * Every `<script>` body in `content`, in document order, non-overlapping.
 *
 * An empty array means "nothing to parse" — a template-only component, or
 * a shape this scanner does not recognise. Callers report that as
 * `unsupported: 'no-script-block'`, distinct from "parsed and found
 * nothing".
 */
export function scanScriptBlocks(content: string): IncludedRange[] {
  const comments = commentSpans(content);
  const ranges: IncludedRange[] = [];
  const openTag = /<script\b[^>]*>/gi;

  let match: RegExpExecArray | null;
  while ((match = openTag.exec(content)) !== null) {
    const tagStart = match.index;
    if (insideAny(comments, tagStart)) continue;

    const bodyStart = tagStart + match[0].length;
    const closeIndex = content.toLowerCase().indexOf('</script', bodyStart);
    // No closing tag: not a block we are willing to guess about.
    if (closeIndex === -1) continue;

    // Never scan the same bytes twice: a nested `<script` inside a body
    // would otherwise produce an overlapping range, which the parser
    // rejects outright.
    openTag.lastIndex = closeIndex;

    if (content.slice(bodyStart, closeIndex).trim() === '') continue;

    ranges.push({
      startIndex: bodyStart,
      endIndex: closeIndex,
      startPosition: positionAt(content, bodyStart),
      endPosition: positionAt(content, closeIndex),
    });
  }

  return ranges;
}
