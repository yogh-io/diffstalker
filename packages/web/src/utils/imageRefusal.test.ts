/**
 * The refusal copy: it must name the caps that actually applied, and it
 * must take every number from core's constants.
 *
 * The bug this pins, twice over. `too-large` used to say "over the 8 MB
 * preview cap", but a GIF is refused at MAX_GIF_BYTES (2 MB) — the
 * daemon's own tests produce exactly that refusal from a 3 MB GIF.
 * `too-many-pixels` named the 16 MP per-image cap alone, but four caps
 * emit it: a 20000x100 PNG breaks the per-side dimension cap at 2 MP and
 * a 256-frame 4x4 GIF breaks the frame cap at 16 pixels. Both were told a
 * number that had never been applied to their file. The refusal enum is
 * closed and carries no format and no offending number, so each note
 * names the whole budget behind its refusal.
 */

import { describe, test, expect } from 'vitest';
import { REFUSAL_TEXT, refusalSentence } from './imageRefusal';
import {
  MAX_ANIMATED_PIXELS,
  MAX_GIF_BYTES,
  MAX_GIF_FRAMES,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_DIMENSION,
  MAX_IMAGE_PIXELS,
} from '@diffstalker/core/utils/imageSniff';

/**
 * The formatting rule the copy is written to, restated: MB and MP are
 * decimal units, and a cap is rounded DOWN so the sentence never names a
 * cap higher than the one enforced.
 */
function mb(bytes: number): number {
  return Math.floor(bytes / 1_000_000);
}

function mp(pixels: number): number {
  return Math.floor(pixels / 1_000_000);
}

describe('too-large', () => {
  test('names both byte caps, and says the tighter one is the GIF one', () => {
    const text = REFUSAL_TEXT['too-large'];

    expect(text).toContain('8 MB');
    expect(text).toContain('2 MB for GIF');
  });

  test('the numbers come from core, not from a literal typed here', () => {
    const text = REFUSAL_TEXT['too-large'] ?? '';

    // Move a cap in imageSniff.ts and this prose moves with it.
    expect(text).toContain(`${mb(MAX_IMAGE_BYTES)} MB`);
    expect(text).toContain(`${mb(MAX_GIF_BYTES)} MB`);
  });
});

describe('too-many-pixels', () => {
  test('names every cap that emits it, each number from core', () => {
    const text = REFUSAL_TEXT['too-many-pixels'] ?? '';

    // Per side (a 20000x100 PNG), per image, and the two animation caps.
    expect(text).toContain(`${MAX_IMAGE_DIMENSION} px per side`);
    expect(text).toContain(`${mp(MAX_IMAGE_PIXELS)} MP per image`);
    expect(text).toContain(`${MAX_GIF_FRAMES} frames`);
    expect(text).toContain(`${mp(MAX_ANIMATED_PIXELS)} MP`);
  });

  test('names no cap the sniffer does not enforce', () => {
    const text = REFUSAL_TEXT['too-many-pixels'] ?? '';

    // The byte caps belong to `too-large`; a reader refused on pixels must
    // not be handed a size limit their file was never measured against.
    expect(text).not.toContain('MB');
  });
});

describe('the labels are honest', () => {
  test('MB and MP are decimal, and a cap is never rounded up', () => {
    // The caps are binary (8 MiB, 2^24 px). Printed as decimal MB/MP they
    // must round DOWN, so everything refused really is over the number
    // shown. Rounding to nearest would print 17 MP for a 16.8 MP cap.
    expect(mb(MAX_IMAGE_BYTES)).toBe(8);
    expect(mp(MAX_IMAGE_PIXELS)).toBe(16);
    expect(mp(MAX_ANIMATED_PIXELS)).toBe(33);
    expect(REFUSAL_TEXT['too-many-pixels']).toContain('33 MP');
  });
});

describe('refusalSentence', () => {
  test('capitalizes the shared phrase rather than storing it twice', () => {
    expect(refusalSentence('unsupported-format')).toBe('No preview (format not rendered)');
    expect(refusalSentence('too-large')).toBe(
      (REFUSAL_TEXT['too-large'] ?? '').replace('no preview', 'No preview')
    );
    expect(refusalSentence('too-many-pixels')).toBe(
      (REFUSAL_TEXT['too-many-pixels'] ?? '').replace('no preview', 'No preview')
    );
  });

  test('the silent refusals fall back to the bare line', () => {
    expect(refusalSentence('not-an-image')).toBe('No preview');
    expect(refusalSentence(null)).toBe('No preview');
  });
});
