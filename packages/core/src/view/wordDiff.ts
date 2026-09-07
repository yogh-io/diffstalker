// Word-level diff utility using fast-diff

import fastDiff from 'fast-diff';

export interface WordDiffSegment {
  text: string;
  type: 'same' | 'changed';
}

/**
 * Check if two lines are similar enough to warrant word-level diffing.
 * Returns true if they share at least 30% common content.
 */
export function areSimilarEnough(oldText: string, newText: string): boolean {
  if (!oldText || !newText) return false;

  const diffs = fastDiff(oldText, newText);
  let commonLength = 0;
  let totalLength = 0;

  for (const [type, text] of diffs) {
    totalLength += text.length;
    if (type === fastDiff.EQUAL) {
      commonLength += text.length;
    }
  }

  if (totalLength === 0) return false;

  // Require at least 50% similarity for word-level highlighting to be useful
  const similarity = commonLength / totalLength;
  return similarity >= 0.5;
}

/**
 * Compute word-level diff between two strings.
 * Returns segments for both the old (deleted) and new (added) lines,
 * marking which portions changed.
 */
export function computeWordDiff(
  oldText: string,
  newText: string
): {
  oldSegments: WordDiffSegment[];
  newSegments: WordDiffSegment[];
} {
  const diffs = fastDiff(oldText, newText);

  const oldSegments: WordDiffSegment[] = [];
  const newSegments: WordDiffSegment[] = [];

  for (const [type, text] of diffs) {
    if (type === fastDiff.EQUAL) {
      // Same in both - add to both segment lists
      oldSegments.push({ text, type: 'same' });
      newSegments.push({ text, type: 'same' });
    } else if (type === fastDiff.DELETE) {
      // Deleted from old - only in old segments
      oldSegments.push({ text, type: 'changed' });
    } else if (type === fastDiff.INSERT) {
      // Inserted in new - only in new segments
      newSegments.push({ text, type: 'changed' });
    }
  }

  return { oldSegments, newSegments };
}

/**
 * What counts as inside a word, for expandSegmentsToWords. Letters,
 * digits and `_` — the identifier alphabet, so `-`, `.`, `:`, `/`, `,`
 * and quotes all read as boundaries. That is what makes
 * `debian-bullseye` two words and stops the expansion from swallowing
 * a whole path or a whole comma-separated list.
 */
const WORD_CHAR = /[\p{L}\p{N}_]/u;

/**
 * Grow every changed run out to whole words.
 *
 * fast-diff works in characters, so a change inside a word keeps the
 * shared prefix and suffix out of the highlight: `bullseye` ->
 * `bookworm` marks only `ullseye`/`ookworm`, leaving the `b` painted as
 * unchanged. The reader sees a highlight that starts mid-word and has
 * to reconstruct the actual edit. In practice the WORD was replaced, so
 * the word is what to show.
 *
 * A run only grows over characters that are inside the same word: it
 * extends left only when the run already starts on a word character
 * (and then only across word characters), and the mirror on the right.
 * A change that starts at a boundary — a whole added argument, a
 * changed separator — is left exactly where fast-diff put it.
 *
 * Per side and purely textual: given the same surrounding context, the
 * old and new sides expand to the same word edges without needing to
 * agree with each other.
 */
export function expandSegmentsToWords(segments: WordDiffSegment[]): WordDiffSegment[] {
  const text = segments.map((segment) => segment.text).join('');
  if (text.length === 0) return segments;
  return segmentsFromMask(text, growToWords(text, changedMask(segments, text.length)));
}

/** One flag per character of the joined text: 1 where a segment is 'changed'. */
function changedMask(segments: WordDiffSegment[], length: number): Uint8Array {
  const mask = new Uint8Array(length);
  let at = 0;
  for (const segment of segments) {
    if (segment.type === 'changed') mask.fill(1, at, at + segment.text.length);
    at += segment.text.length;
  }
  return mask;
}

/**
 * Widen each changed run in `changed` to its word edges. Reads the
 * ORIGINAL mask and writes a copy, so a run cannot grow through a
 * neighbour's growth: two changes inside one word each reach that word's
 * edges and meet, which is the same single highlight either way.
 */
function growToWords(text: string, changed: Uint8Array): Uint8Array {
  const grown = Uint8Array.from(changed);
  for (let i = 0; i < text.length; i++) {
    if (!changed[i] || !WORD_CHAR.test(text[i])) continue;
    if (i === 0 || !changed[i - 1]) {
      for (let j = i - 1; j >= 0 && WORD_CHAR.test(text[j]); j--) grown[j] = 1;
    }
    if (i === text.length - 1 || !changed[i + 1]) {
      for (let j = i + 1; j < text.length && WORD_CHAR.test(text[j]); j++) grown[j] = 1;
    }
  }
  return grown;
}

/** Group the text back into segments, one per run of equal flags. */
function segmentsFromMask(text: string, mask: Uint8Array): WordDiffSegment[] {
  const segments: WordDiffSegment[] = [];
  let start = 0;
  for (let i = 1; i <= text.length; i++) {
    if (i < text.length && mask[i] === mask[start]) continue;
    segments.push({ text: text.slice(start, i), type: mask[start] ? 'changed' : 'same' });
    start = i;
  }
  return segments;
}
