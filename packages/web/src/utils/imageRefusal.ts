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
 * The numbers come from core's cap constants, never from a literal typed
 * here: a cap that moves in imageSniff.ts must move this prose with it,
 * and prose is exactly where a stale second copy goes unnoticed.
 *
 * `not-an-image`, `malformed` and `header-not-found` say nothing extra on
 * purpose (null). To a reader they all mean what the note already says —
 * this is a binary file, there is nothing to show — and naming the internal
 * distinction would be noise.
 */

import type { ImageRefusal } from '@diffstalker/client';
import {
  MAX_ANIMATED_PIXELS,
  MAX_GIF_BYTES,
  MAX_GIF_FRAMES,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_DIMENSION,
  MAX_IMAGE_PIXELS,
} from '@diffstalker/core/utils/imageSniff';

/**
 * The caps are binary (8 MiB, 2^24 pixels) but MB and MP are decimal
 * units, so both helpers divide by the decimal million and round DOWN.
 * Down, never nearest: a rounded-up number would name a cap HIGHER than
 * the one enforced, and telling a reader "over the 9 MB cap" about an
 * 8.5 MB file is the same class of lie this file exists to stop. Rounded
 * down the sentence stays true — everything refused really is over the
 * number printed.
 */
function mb(bytes: number): string {
  return `${Math.floor(bytes / 1_000_000)} MB`;
}

function mp(pixels: number): string {
  return `${Math.floor(pixels / 1_000_000)} MP`;
}

/**
 * `too-large` has TWO caps behind it: the general byte cap, and the
 * tighter GIF one (a GIF is validated by walking the whole file, so it
 * must stay small). The refusal that reaches us does not say which format
 * was sniffed, so the note names both and says which is which — naming
 * only the general cap told a reader refused at 3 MB of GIF a number that
 * was never applied to their file.
 */
const TOO_LARGE = `no preview (over the preview size cap: ${mb(MAX_IMAGE_BYTES)}, or ${mb(
  MAX_GIF_BYTES
)} for GIF)`;

/**
 * `too-many-pixels` has FOUR caps behind it, and the same problem as
 * `too-large`, one step worse: a 20000x100 PNG breaks the per-side
 * dimension cap at 2 MP, and a 256-frame 4x4 GIF breaks the frame cap at
 * 16 pixels. Naming only the per-image pixel cap told both of them a
 * number that had never been applied to their file.
 *
 * So the note names the whole budget. The refusal enum carries no format
 * and no offending number by design (nothing repo-derived reaches the
 * UI), which leaves naming every cap as the only wording that is true
 * whichever one applied — and it stays true as the sniffer charges more
 * cases against these same caps.
 */
const TOO_MANY_PIXELS =
  `no preview (over the preview pixel budget: ${MAX_IMAGE_DIMENSION} px per side, ` +
  `${mp(MAX_IMAGE_PIXELS)} per image, ${MAX_GIF_FRAMES} frames, ` +
  `or ${mp(MAX_ANIMATED_PIXELS)} across an animation)`;

/** Phrase for a note SUFFIX (" · no preview (…)"). null = say nothing. */
export const REFUSAL_TEXT: Record<ImageRefusal, string | null> = {
  'not-an-image': null,
  malformed: null,
  'header-not-found': null,
  'unsupported-format': 'no preview (format not rendered)',
  animation: 'no preview (animated PNG not rendered)',
  'too-large': TOO_LARGE,
  'too-many-pixels': TOO_MANY_PIXELS,
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
