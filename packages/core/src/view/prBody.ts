/**
 * The PR body, as text: how the two draft zones compose, where the
 * placeholders are, and where the top zone of a published body ends.
 * See docs/work-page.md §3. Pure and browser-safe.
 */

import type { DraftChangeEvent } from '../types/work.js';

const PLACEHOLDER_SOURCE = '\\{\\{[^{}\\n]+\\}\\}';

/** A fresh `{{...}}` matcher: on one line, with something inside. */
export function placeholderPattern(): RegExp {
  return new RegExp(PLACEHOLDER_SOURCE, 'g');
}

/** A half-open span of a string: `text.slice(start, end)`. */
export interface TextRange {
  start: number;
  end: number;
}

/** Where the placeholders are, in order. */
export function placeholderRanges(text: string): TextRange[] {
  const ranges: TextRange[] = [];
  for (const match of text.matchAll(placeholderPattern())) {
    ranges.push({ start: match.index, end: match.index + match[0].length });
  }
  return ranges;
}

export function countPlaceholders(text: string): number {
  return placeholderRanges(text).length;
}

/** Line endings to `\n`, then trimmed on both sides. */
export function normalizeBody(text: string): string {
  return text.replace(/\r\n/g, '\n').trim();
}

/**
 * The PR body from its two zones: the top, a blank line, `---`, then the
 * AI zone. The top alone when there is no AI zone.
 */
export function composeBody(top: string | null, ai: string | null): string {
  const topText = normalizeBody(top ?? '');
  const aiText = normalizeBody(ai ?? '');
  if (aiText === '') return topText;
  if (topText === '') return `---\n${aiText}`;
  return `${topText}\n\n---\n${aiText}`;
}

/** The first non-blank line after `from` starts with `<details>`. */
function detailsFollows(lines: string[], from: number): boolean {
  for (let i = from; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    return lines[i].startsWith('<details>');
  }
  return false;
}

/**
 * The top zone of a published PR body: everything before the first line
 * that is exactly `---` and is followed, after optional blank lines, by a
 * line starting with `<details>`. The whole body when there is no such
 * line. Normalized like normalizeBody.
 */
export function topZoneOf(prBody: string): string {
  const lines = prBody.replace(/\r\n/g, '\n').split('\n');
  const cut = lowerZoneStart(lines);
  return lines
    .slice(0, cut ?? lines.length)
    .join('\n')
    .trim();
}

/** The index of the `---` line the top zone ends at; null when the whole body is the top zone. */
function lowerZoneStart(lines: string[]): number | null {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === '---' && detailsFollows(lines, i + 1)) return i;
  }
  return null;
}

/**
 * The PR body with its top zone replaced by `top`. The `---` line and
 * everything under it stay exactly as they are; with no lower zone the
 * body is `top` alone. Line endings become `\n`.
 */
export function replaceTopZone(prBody: string, top: string): string {
  const lines = prBody.replace(/\r\n/g, '\n').split('\n');
  const cut = lowerZoneStart(lines);
  const newTop = normalizeBody(top);
  if (cut === null) return newTop;
  const lower = lines.slice(cut).join('\n');
  return newTop === '' ? lower : `${newTop}\n\n${lower}`;
}

/** The top zone on GitHub is not the draft's top.md. */
export function bodyDiffersFromDraft(prBody: string, top: string): boolean {
  return topZoneOf(prBody) !== normalizeBody(top);
}

/** A `draft-change` event may be about this branch's draft. */
export function draftChangeTouches(event: DraftChangeEvent, branch: string): boolean {
  if (event.branch === branch) return true;
  if (!event.prefix) return false;
  return event.branch === '' || branch.startsWith(`${event.branch}/`);
}
