/**
 * Every fixture here is built by hand out of bytes. That is the point: the
 * sniffer must decide from magic and structure alone, so a test that leaned on
 * a real file on disk (with a real extension) would be testing the wrong
 * thing. The hostile cases — dimension bombs, truncations, overrunning chunk
 * lengths, vetoed signatures — are constructed to be exactly as malformed as
 * an attacker would make them, and every one of them must come back as a
 * returned refusal, never a throw.
 */

import { describe, it, expect } from 'vitest';
import {
  sniffImage,
  sniffWindow,
  IMAGE_HEADER_WINDOW,
  MAX_GIF_BYTES,
  MAX_ICC_BYTES,
  MAX_IMAGE_BYTES,
  type ImageRefusal,
  type SniffResult,
} from './imageSniff.js';

// --- byte builders ---

function b(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

function str(text: string): Uint8Array {
  return Uint8Array.from(text, (c) => c.charCodeAt(0));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function repeat(part: Uint8Array, times: number): Uint8Array {
  return concat(...Array.from({ length: times }, () => part));
}

function u32be(value: number): Uint8Array {
  return b((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
}

function u16be(value: number): Uint8Array {
  return b((value >>> 8) & 0xff, value & 0xff);
}

function u16le(value: number): Uint8Array {
  return b(value & 0xff, (value >>> 8) & 0xff);
}

function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

/** Sniff a complete buffer: the daemon's own call shape. */
function sniff(bytes: Uint8Array): SniffResult {
  return sniffImage(bytes, bytes.length, true);
}

function refusalOf(result: SniffResult): ImageRefusal | 'accepted' {
  return result.ok ? 'accepted' : result.refusal;
}

// --- PNG fixtures ---

const PNG_SIGNATURE = b(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

/** CRC is never validated by the sniffer, so four zeroes stand in for it. */
function pngChunk(type: string, data: Uint8Array, declaredLength?: number): Uint8Array {
  return concat(u32be(declaredLength ?? data.length), str(type), data, b(0, 0, 0, 0));
}

function ihdr(width: number, height: number, depth = 8, colorType = 6): Uint8Array {
  return pngChunk('IHDR', concat(u32be(width), u32be(height), b(depth, colorType, 0, 0, 0)));
}

function buildPng(...chunks: Uint8Array[]): Uint8Array {
  return concat(PNG_SIGNATURE, ...chunks);
}

const IDAT = pngChunk('IDAT', b(0x78, 0x9c, 0x63, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01));

/** A genuine 1x1 RGBA PNG, so at least one accept case is a file a decoder made. */
const REAL_PNG = fromBase64(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
);

// --- JPEG fixtures ---

function jpegSegment(marker: number, payload: Uint8Array): Uint8Array {
  return concat(b(0xff, marker), u16be(payload.length + 2), payload);
}

const JFIF_APP0 = jpegSegment(
  0xe0,
  concat(str('JFIF'), b(0), b(1, 1, 0), u16be(1), u16be(1), b(0, 0))
);

/** SOFn payload: precision, height, width, component count, one component. */
function sof(marker: number, width: number, height: number): Uint8Array {
  return jpegSegment(marker, concat(b(8), u16be(height), u16be(width), b(1, 1, 0x11, 0)));
}

function buildJpeg(...segments: Uint8Array[]): Uint8Array {
  return concat(b(0xff, 0xd8), ...segments, b(0xff, 0xd9));
}

// --- GIF fixtures ---

function gifHeader(width: number, height: number, version = 'GIF89a'): Uint8Array {
  // No global colour table: packed flags 0, background 0, aspect 0.
  return concat(str(version), u16le(width), u16le(height), b(0, 0, 0));
}

/** Descriptor, LZW minimum code size, one data sub-block, terminator. */
function gifFrame(width: number, height: number): Uint8Array {
  return concat(
    b(0x2c),
    u16le(0),
    u16le(0),
    u16le(width),
    u16le(height),
    b(0),
    b(0x02),
    b(0x01, 0x44),
    b(0x00)
  );
}

const GIF_TRAILER = b(0x3b);

/** The canonical 1x1 transparent GIF: real bytes, with a GCE and a colour table. */
const REAL_GIF = fromBase64('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7');

// ---------------------------------------------------------------------------

describe('sniffImage — accepted formats', () => {
  it('accepts a real 1x1 PNG with its exact dimensions and mime', () => {
    const result = sniff(REAL_PNG);
    expect(result).toEqual({
      ok: true,
      info: {
        format: 'png',
        mime: 'image/png',
        width: 1,
        height: 1,
        bytes: REAL_PNG.length,
      },
    });
  });

  it('accepts a built 1x1 JPEG with its exact dimensions and mime', () => {
    const bytes = buildJpeg(JFIF_APP0, sof(0xc0, 1, 1));
    expect(sniff(bytes)).toEqual({
      ok: true,
      info: { format: 'jpeg', mime: 'image/jpeg', width: 1, height: 1, bytes: bytes.length },
    });
  });

  it('accepts a real 1x1 GIF with its exact dimensions and mime', () => {
    expect(sniff(REAL_GIF)).toEqual({
      ok: true,
      info: { format: 'gif', mime: 'image/gif', width: 1, height: 1, bytes: REAL_GIF.length },
    });
  });

  it('accepts progressive JPEG (SOF2) and extended sequential (SOF1)', () => {
    for (const marker of [0xc1, 0xc2]) {
      const result = sniff(buildJpeg(JFIF_APP0, sof(marker, 640, 480)));
      expect(result.ok).toBe(true);
      expect(result.ok && result.info.width).toBe(640);
      expect(result.ok && result.info.height).toBe(480);
    }
  });

  it('accepts GIF87a as well as GIF89a', () => {
    const bytes = concat(gifHeader(4, 2, 'GIF87a'), gifFrame(4, 2), GIF_TRAILER);
    const result = sniff(bytes);
    expect(result.ok).toBe(true);
    expect(result.ok && result.info.width).toBe(4);
  });

  it('reports frames only for an animated GIF', () => {
    const still = sniff(concat(gifHeader(2, 2), gifFrame(2, 2), GIF_TRAILER));
    expect(still.ok && still.info.frames).toBeUndefined();

    const animated = sniff(concat(gifHeader(2, 2), repeat(gifFrame(2, 2), 3), GIF_TRAILER));
    expect(animated.ok && animated.info.frames).toBe(3);
  });

  it('reports the declared size, not the length of the buffer it was handed', () => {
    const png = buildPng(ihdr(8, 8), IDAT);
    const result = sniffImage(png, 4096, false);
    expect(result.ok && result.info.bytes).toBe(4096);
  });

  it('accepts every legal PNG bit-depth / colour-type pair', () => {
    const legal: [number, number][] = [
      [1, 0],
      [16, 0],
      [8, 2],
      [16, 2],
      [4, 3],
      [8, 4],
      [16, 6],
    ];
    for (const [depth, colorType] of legal) {
      expect(sniff(buildPng(ihdr(1, 1, depth, colorType), IDAT)).ok).toBe(true);
    }
  });
});

describe('sniffImage — truncation', () => {
  it('refuses every truncation of a real PNG without throwing', () => {
    for (const at of [1, 7, 8, 13, 24]) {
      const result = sniff(REAL_PNG.slice(0, at));
      expect(result.ok).toBe(false);
    }
  });

  it('calls a short prefix not-an-image and a truncated PNG malformed', () => {
    // The signature is 8 bytes, so anything shorter matches nothing at all.
    expect(refusalOf(sniff(REAL_PNG.slice(0, 1)))).toBe('not-an-image');
    expect(refusalOf(sniff(REAL_PNG.slice(0, 7)))).toBe('not-an-image');
    // Signature matched but the header is not there: a truncated file.
    expect(refusalOf(sniff(REAL_PNG.slice(0, 8)))).toBe('malformed');
    expect(refusalOf(sniff(REAL_PNG.slice(0, 13)))).toBe('malformed');
    expect(refusalOf(sniff(REAL_PNG.slice(0, 24)))).toBe('malformed');
  });

  it('refuses an empty buffer', () => {
    expect(refusalOf(sniff(new Uint8Array(0)))).toBe('not-an-image');
  });

  it('refuses a truncated JPEG and a truncated GIF', () => {
    const jpeg = buildJpeg(JFIF_APP0, sof(0xc0, 1, 1));
    expect(refusalOf(sniff(jpeg.slice(0, 3)))).toBe('malformed');
    expect(refusalOf(sniff(jpeg.slice(0, 12)))).toBe('malformed');
    expect(refusalOf(sniff(REAL_GIF.slice(0, 10)))).toBe('malformed');
  });

  it('says header-not-found when only a prefix was supplied', () => {
    const png = buildPng(ihdr(16, 16), pngChunk('tEXt', new Uint8Array(40_000)), IDAT);
    expect(refusalOf(sniffImage(png.slice(0, 100), png.length, false))).toBe('header-not-found');
  });
});

describe('sniffImage — PNG structure', () => {
  it('refuses APNG: acTL before IDAT is a second animation decode path', () => {
    const apng = buildPng(ihdr(1, 1), pngChunk('acTL', new Uint8Array(8)), IDAT);
    expect(refusalOf(sniff(apng))).toBe('animation');
  });

  it('accepts a PNG whose acTL sits after IDAT, because the walk stops at IDAT', () => {
    const bytes = buildPng(ihdr(1, 1), IDAT, pngChunk('acTL', new Uint8Array(8)));
    expect(sniff(bytes).ok).toBe(true);
  });

  it('refuses a dimension bomb declaring 60000x60000', () => {
    expect(refusalOf(sniff(buildPng(ihdr(60_000, 60_000), IDAT)))).toBe('too-many-pixels');
  });

  it('refuses a side over the per-side cap even when the product would fit', () => {
    // 9000 * 1 is only 9000 pixels, but 9000 px on a side is still refused.
    expect(refusalOf(sniff(buildPng(ihdr(9000, 1), IDAT)))).toBe('too-many-pixels');
  });

  it('refuses a pixel bomb that stays under the per-side cap', () => {
    expect(refusalOf(sniff(buildPng(ihdr(8000, 8000), IDAT)))).toBe('too-many-pixels');
  });

  it('refuses a zero side as malformed, not as a pixel bomb', () => {
    expect(refusalOf(sniff(buildPng(ihdr(0, 1), IDAT)))).toBe('malformed');
    expect(refusalOf(sniff(buildPng(ihdr(1, 0), IDAT)))).toBe('malformed');
    expect(refusalOf(sniff(buildPng(ihdr(0, 60_000), IDAT)))).toBe('malformed');
  });

  it('refuses illegal bit-depth / colour-type pairs', () => {
    const illegal: [number, number][] = [
      [3, 2], // depth 3 is not a PNG depth at all
      [1, 2], // truecolour is 8 or 16 only
      [16, 3], // indexed tops out at 8
      [2, 4], // greyscale+alpha is 8 or 16 only
      [4, 6], // truecolour+alpha is 8 or 16 only
      [8, 5], // colour type 5 does not exist
      [8, 7], // colour type 7 does not exist
    ];
    for (const [depth, colorType] of illegal) {
      expect(refusalOf(sniff(buildPng(ihdr(1, 1, depth, colorType), IDAT)))).toBe('malformed');
    }
  });

  it('refuses an IHDR that is not first or not 13 bytes long', () => {
    const notFirst = buildPng(pngChunk('tEXt', str('x')), ihdr(1, 1), IDAT);
    expect(refusalOf(sniff(notFirst))).toBe('malformed');

    const wrongLength = concat(
      PNG_SIGNATURE,
      pngChunk('IHDR', concat(u32be(1), u32be(1), b(8, 6, 0, 0, 0)), 14),
      IDAT
    );
    expect(refusalOf(sniff(wrongLength))).toBe('malformed');
  });

  it('refuses an iCCP profile over 64 KiB', () => {
    const bytes = buildPng(ihdr(1, 1), pngChunk('iCCP', new Uint8Array(MAX_ICC_BYTES + 1)), IDAT);
    expect(refusalOf(sniff(bytes))).toBe('malformed');
  });

  it('accepts an iCCP profile at the cap', () => {
    const bytes = buildPng(ihdr(1, 1), pngChunk('iCCP', new Uint8Array(MAX_ICC_BYTES)), IDAT);
    expect(sniff(bytes).ok).toBe(true);
  });

  it('refuses a chunk length that overruns the buffer', () => {
    const bytes = buildPng(ihdr(1, 1), pngChunk('tEXt', new Uint8Array(0), 0xffffffff), IDAT);
    expect(refusalOf(sniff(bytes))).toBe('malformed');
  });

  it('terminates on a chunk stream that never reaches IDAT', () => {
    // 300 zero-length chunks: the cursor advances every step (a PNG length is
    // unsigned, so a real cycle is impossible), and the 256-chunk cap fires
    // before IDAT is ever reached.
    const filler = repeat(pngChunk('tEXt', new Uint8Array(0)), 300);
    expect(refusalOf(sniff(buildPng(ihdr(1, 1), filler, IDAT)))).toBe('malformed');
  });

  it('refuses a PNG with no IDAT at all', () => {
    expect(refusalOf(sniff(buildPng(ihdr(1, 1), pngChunk('IEND', new Uint8Array(0)))))).toBe(
      'malformed'
    );
  });
});

describe('sniffImage — JPEG structure', () => {
  it('refuses a JPEG whose fourth byte is not a legal marker', () => {
    expect(refusalOf(sniff(concat(b(0xff, 0xd8, 0xff, 0x00), new Uint8Array(64))))).toBe(
      'malformed'
    );
  });

  it('refuses lossless, differential and arithmetic frame headers', () => {
    for (const marker of [0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]) {
      const bytes = buildJpeg(JFIF_APP0, sof(marker, 16, 16));
      expect(refusalOf(sniff(bytes))).toBe('malformed');
    }
  });

  it('refuses scan data reached before any frame header', () => {
    const bytes = buildJpeg(JFIF_APP0, jpegSegment(0xda, b(1, 1, 0, 0, 63, 0)));
    expect(refusalOf(sniff(bytes))).toBe('malformed');
  });

  it('refuses a JPEG dimension bomb', () => {
    expect(refusalOf(sniff(buildJpeg(JFIF_APP0, sof(0xc0, 60_000, 60_000))))).toBe(
      'too-many-pixels'
    );
    expect(refusalOf(sniff(buildJpeg(JFIF_APP0, sof(0xc0, 0, 16))))).toBe('malformed');
  });

  it('refuses a cumulative APP2 ICC run over 64 KiB', () => {
    const app2 = jpegSegment(0xe2, concat(str('ICC_PROFILE'), b(0), new Uint8Array(40_000)));
    const bytes = buildJpeg(JFIF_APP0, app2, app2, sof(0xc0, 16, 16));
    expect(refusalOf(sniff(bytes))).toBe('malformed');
  });

  it('accepts a single ICC profile segment under the cap', () => {
    const app2 = jpegSegment(0xe2, concat(str('ICC_PROFILE'), b(0), new Uint8Array(40_000)));
    expect(sniff(buildJpeg(JFIF_APP0, app2, sof(0xc0, 16, 16))).ok).toBe(true);
  });

  it('says header-not-found when the frame header sits past the 64 KiB window', () => {
    const filler = jpegSegment(0xe1, new Uint8Array(40_000));
    const bytes = buildJpeg(JFIF_APP0, filler, filler, sof(0xc0, 16, 16));
    expect(bytes.length).toBeGreaterThan(IMAGE_HEADER_WINDOW);

    const prefix = bytes.slice(0, IMAGE_HEADER_WINDOW);
    expect(refusalOf(sniffImage(prefix, bytes.length, false))).toBe('header-not-found');
    // The same bytes, honestly declared complete, are a truncated file.
    expect(refusalOf(sniffImage(prefix, prefix.length, true))).toBe('malformed');
  });

  it('skips 0xFF fill bytes between segments', () => {
    const bytes = buildJpeg(JFIF_APP0, b(0xff, 0xff, 0xff), sof(0xc0, 3, 5));
    const result = sniff(bytes);
    expect(result.ok).toBe(true);
    expect(result.ok && result.info.height).toBe(5);
  });

  it('refuses a segment with a length under its own two length bytes', () => {
    const bytes = concat(b(0xff, 0xd8), b(0xff, 0xe0), u16be(1), new Uint8Array(32));
    expect(refusalOf(sniff(bytes))).toBe('malformed');
  });

  it('terminates on a segment stream that never reaches a frame header', () => {
    // Zero-payload segments advance by 4 bytes each; the 1024-segment cap is
    // what ends the walk, well before the 2000 segments here run out.
    const empty = jpegSegment(0xe1, new Uint8Array(0));
    const bytes = concat(b(0xff, 0xd8), repeat(empty, 2000), sof(0xc0, 1, 1));
    expect(refusalOf(sniff(bytes))).toBe('malformed');
  });
});

describe('sniffImage — GIF structure', () => {
  it('needs the whole file: a prefix is header-not-found', () => {
    const bytes = concat(gifHeader(2, 2), gifFrame(2, 2), GIF_TRAILER);
    expect(refusalOf(sniffImage(bytes, bytes.length, false))).toBe('header-not-found');
  });

  it('refuses a GIF over the 2 MiB GIF cap', () => {
    const bytes = concat(gifHeader(2, 2), gifFrame(2, 2), GIF_TRAILER);
    expect(refusalOf(sniffImage(bytes, MAX_GIF_BYTES + 1, true))).toBe('too-large');
  });

  it('refuses a GIF with 300 image descriptors', () => {
    const bytes = concat(gifHeader(2, 2), repeat(gifFrame(2, 2), 300), GIF_TRAILER);
    expect(refusalOf(sniff(bytes))).toBe('too-many-pixels');
  });

  it('refuses an animation over the animated-pixel budget', () => {
    // 100 frames of 700x700 is 49 MPix of decode for a file of a few KB.
    const bytes = concat(gifHeader(700, 700), repeat(gifFrame(700, 700), 100), GIF_TRAILER);
    expect(refusalOf(sniff(bytes))).toBe('too-many-pixels');
  });

  it('refuses a GIF dimension bomb and a zero side', () => {
    expect(refusalOf(sniff(concat(gifHeader(60_000, 60_000), GIF_TRAILER)))).toBe(
      'too-many-pixels'
    );
    expect(refusalOf(sniff(concat(gifHeader(0, 8), GIF_TRAILER)))).toBe('malformed');
  });

  it('refuses an unknown block id', () => {
    const bytes = concat(gifHeader(2, 2), gifFrame(2, 2), b(0x99), GIF_TRAILER);
    expect(refusalOf(sniff(bytes))).toBe('malformed');
  });

  it('refuses a block stream with no trailer', () => {
    expect(refusalOf(sniff(concat(gifHeader(2, 2), gifFrame(2, 2))))).toBe('malformed');
  });

  it('refuses a sub-block chain that runs past the end of the file', () => {
    const truncated = concat(
      gifHeader(2, 2),
      b(0x2c),
      u16le(0),
      u16le(0),
      u16le(2),
      u16le(2),
      b(0),
      b(0x02),
      b(0x40) // declares 64 bytes of data that are not there
    );
    expect(refusalOf(sniff(truncated))).toBe('malformed');
  });

  it('refuses a GIF with no image descriptor', () => {
    expect(refusalOf(sniff(concat(gifHeader(2, 2), GIF_TRAILER)))).toBe('malformed');
  });

  it('walks past a global colour table and an extension block', () => {
    const header = concat(str('GIF89a'), u16le(2), u16le(2), b(0x80, 0, 0));
    const globalColorTable = new Uint8Array(6);
    const graphicControl = concat(b(0x21, 0xf9), b(0x04), b(0, 0, 0, 0), b(0x00));
    const bytes = concat(header, globalColorTable, graphicControl, gifFrame(2, 2), GIF_TRAILER);
    expect(sniff(bytes).ok).toBe(true);
  });
});

describe('sniffImage — vetoed image formats', () => {
  const vetoed: [string, Uint8Array][] = [
    ['webp', concat(str('RIFF'), u32be(64), str('WEBPVP8 '), new Uint8Array(32))],
    ['avif', concat(u32be(32), str('ftyp'), str('avif'), str('avifmif1'), new Uint8Array(16))],
    ['avis', concat(u32be(32), str('ftyp'), str('avis'), new Uint8Array(16))],
    ['heic', concat(u32be(32), str('ftyp'), str('heic'), new Uint8Array(16))],
    ['heix', concat(u32be(32), str('ftyp'), str('heix'), new Uint8Array(16))],
    ['mif1', concat(u32be(32), str('ftyp'), str('mif1'), new Uint8Array(16))],
    ['tiff little-endian', concat(b(0x49, 0x49, 0x2a, 0x00), new Uint8Array(32))],
    ['tiff big-endian', concat(b(0x4d, 0x4d, 0x00, 0x2a), new Uint8Array(32))],
    ['bmp', concat(str('BM'), u32be(64), new Uint8Array(32))],
    ['ico', concat(b(0x00, 0x00, 0x01, 0x00, 0x01, 0x00), new Uint8Array(32))],
    ['cur', concat(b(0x00, 0x00, 0x02, 0x00, 0x01, 0x00), new Uint8Array(32))],
    ['jpeg xl codestream', concat(b(0xff, 0x0a), new Uint8Array(32))],
    [
      'jpeg xl container',
      concat(
        b(0x00, 0x00, 0x00, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a),
        new Uint8Array(32)
      ),
    ],
  ];

  for (const [name, bytes] of vetoed) {
    it(`refuses ${name} as unsupported-format`, () => {
      expect(refusalOf(sniff(bytes))).toBe('unsupported-format');
    });
  }
});

describe('sniffImage — everything else is not an image', () => {
  const tarHeader = concat(str('file.txt'), new Uint8Array(249), str('ustar'), new Uint8Array(250));

  const notImages: [string, Uint8Array][] = [
    ['svg', str('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')],
    ['svg with an xml prolog', str('<?xml version="1.0"?>\n<svg viewBox="0 0 1 1"></svg>')],
    ['html', str('<!DOCTYPE html>\n<html><body><script>alert(1)</script></body></html>')],
    ['xml', str('<?xml version="1.0" encoding="UTF-8"?><root/>')],
    ['elf', concat(b(0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00), new Uint8Array(56))],
    ['mach-o', concat(b(0xcf, 0xfa, 0xed, 0xfe), new Uint8Array(28))],
    ['wasm', concat(b(0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00), new Uint8Array(16))],
    ['pdf', concat(str('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n'), new Uint8Array(32))],
    ['zip', concat(b(0x50, 0x4b, 0x03, 0x04), new Uint8Array(28))],
    ['tar', tarHeader],
    ['plain text', str('hello, this is a commit message\n')],
    ['a run of NUL bytes', new Uint8Array(64)],
    ['arbitrary binary', b(0x13, 0x37, 0xde, 0xad, 0xbe, 0xef, 0x00, 0x42, 0x99, 0xa5)],
  ];

  for (const [name, bytes] of notImages) {
    it(`refuses ${name} as not-an-image`, () => {
      expect(refusalOf(sniff(bytes))).toBe('not-an-image');
    });
  }
});

describe('sniffImage — caps and robustness', () => {
  it('refuses anything over the 8 MiB byte cap before looking at the bytes', () => {
    expect(refusalOf(sniffImage(REAL_PNG, MAX_IMAGE_BYTES + 1, true))).toBe('too-large');
  });

  it('accepts at exactly the byte cap', () => {
    expect(sniffImage(REAL_PNG, MAX_IMAGE_BYTES, true).ok).toBe(true);
  });

  it('never throws on truncations of any fixture', () => {
    const fixtures = [
      REAL_PNG,
      REAL_GIF,
      buildJpeg(JFIF_APP0, sof(0xc0, 8, 8)),
      concat(gifHeader(4, 4), repeat(gifFrame(4, 4), 4), GIF_TRAILER),
      concat(str('RIFF'), u32be(64), str('WEBPVP8 ')),
    ];
    for (const fixture of fixtures) {
      for (let at = 0; at <= fixture.length; at++) {
        for (const complete of [true, false]) {
          const result = sniffImage(fixture.slice(0, at), fixture.length, complete);
          expect(typeof result.ok).toBe('boolean');
        }
      }
    }
  });

  it('never throws on pseudo-random bytes', () => {
    // A fixed LCG, so a failure is reproducible rather than a flaky surprise.
    let seed = 0x2545f491;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) >>> 0;
      return (seed >>> 16) & 0xff;
    };
    for (let run = 0; run < 500; run++) {
      const bytes = Uint8Array.from({ length: 1 + (next() % 96) }, next);
      const result = sniffImage(bytes, bytes.length, true);
      expect(typeof result.ok).toBe('boolean');
    }
  });
});

describe('sniffWindow', () => {
  it('asks for the 64 KiB metadata window for PNG, JPEG and unknown bytes', () => {
    expect(sniffWindow(REAL_PNG.slice(0, 16), 4_000_000)).toBe(IMAGE_HEADER_WINDOW);
    expect(sniffWindow(b(0xff, 0xd8, 0xff, 0xe0), 4_000_000)).toBe(IMAGE_HEADER_WINDOW);
    expect(sniffWindow(str('<svg'), 100)).toBe(IMAGE_HEADER_WINDOW);
  });

  it('asks for the whole file for a GIF', () => {
    expect(sniffWindow(str('GIF89a'), 12_345)).toBe(12_345);
    expect(sniffWindow(str('GIF87a'), 12_345)).toBe(12_345);
  });

  it('never asks for more than the GIF cap', () => {
    // Past the cap the verdict is too-large regardless, so reading on is waste.
    expect(sniffWindow(str('GIF89a'), MAX_GIF_BYTES * 4)).toBe(MAX_GIF_BYTES);
  });
});
