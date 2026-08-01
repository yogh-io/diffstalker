/**
 * Why a picture is missing, in words — the one copy, shared by the
 * Explorer's binary note (FileContentPane) and the diff's per-side plate
 * (ImageDiffView).
 *
 * The daemon's refusal enum is closed and carries no prose: it sends
 * `unsupported-format`, never a sentence. That is deliberate — no
 * repo-derived string ever reaches the UI — so the wording lives here, on
 * the client, keyed by the enum. A `Record` over the union rather than a
 * lookup with a fallback: adding a refusal to the daemon must fail the type
 * check here instead of silently rendering nothing.
 *
 * `not-an-image`, `malformed` and `header-not-found` say nothing extra on
 * purpose (null). To a reader they all mean what the note already says —
 * this is a binary file, there is nothing to show — and naming the internal
 * distinction would be noise.
 */

import type { ImageRefusal } from '@diffstalker/client';

/** Phrase for a note SUFFIX (" · no preview (…)"). null = say nothing. */
export const REFUSAL_TEXT: Record<ImageRefusal, string | null> = {
  'not-an-image': null,
  malformed: null,
  'header-not-found': null,
  'unsupported-format': 'no preview (format not rendered)',
  animation: 'no preview (animated PNG not rendered)',
  'too-large': 'no preview (over the 8 MB preview cap)',
  'too-many-pixels': 'no preview (over the 16 MP preview cap)',
};

/**
 * The same wording as a STANDALONE line, for a plate that stands where a
 * picture would have been. Capitalized here rather than stored twice, so
 * the two renderings can never drift apart.
 */
export function refusalSentence(refusal: ImageRefusal | null): string {
  const text = refusal === null ? null : REFUSAL_TEXT[refusal];
  if (text === null) return 'No preview';
  return text[0].toUpperCase() + text.slice(1);
}
