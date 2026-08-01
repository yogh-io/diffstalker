/**
 * Image sniffing: the one place that decides whether repo bytes may be handed
 * to a browser as an image, and as which type.
 *
 * This module is the security control for the whole image-viewing feature, so
 * it is deliberately small, pure and paranoid.
 *
 * Why magic bytes only. The bytes come from a git repository, which is
 * attacker-controlled content on an unauthenticated local API. A file called
 * `logo.png` may hold anything. So the format is decided ONLY by the bytes:
 * never by an extension, never by a query parameter, never by a verdict some
 * earlier request cached. The caller re-sniffs the exact buffer it is about to
 * write, on every request, and uses the returned `mime` verbatim.
 *
 * Why a three-entry allow-list. PNG, JPEG and GIF are the formats every
 * browser has decoded for 25 years, they are what actually shows up in repos,
 * and each has a header we can validate with fixed-offset integer reads. Every
 * other format is refused. SVG is scriptable XML, so serving it same-origin
 * would be full compromise; WebP had a zero-click `<img>` RCE (CVE-2023-4863);
 * AVIF/HEIC compose a huge canvas out of small tiles, so a header dimension
 * check does not bound the decode; TIFF is an IFD graph with cycles. WebP is
 * the strongest later candidate, but adding it is a separately reviewed,
 * default-off opt-in — not an edit to the table below.
 *
 * Why we never decode. No image library may enter this repo. Decoding hostile
 * bytes belongs in the browser's sandboxed, auto-updated renderer, not in an
 * unsandboxed Node process with write access to every repo. Everything here is
 * integer reads plus bounded, bounds-checked walks over length-prefixed
 * structures.
 *
 * Why the pixel budget and not just a byte cap. Compression ratio is
 * unbounded: a 40 KB PNG can declare 60000x60000 and cost the renderer
 * gigabytes of RGBA. The dimension and pixel caps are the real DoS control;
 * the byte cap only bounds what we read.
 *
 * What the pixel budget covers. PNG and JPEG declare one frame, so the header
 * dimensions are the whole decode. GIF declares dimensions twice: the logical
 * screen in the header, and a rect on every frame's image descriptor. A frame
 * rect may legally be bigger than the screen — browsers composite into the
 * screen and clip — but a decoder still allocates and decodes the rect, so both
 * are checked against the same budget: every rect against the per-side and
 * per-image caps a still image gets, and the sum of the rects against the
 * animated-pixel cap on top. What is NOT covered is the LZW stream inside a
 * frame; we never decompress, so the declared rect is what bounds a frame.
 *
 * What the pixel budget does not cover: progressive JPEG scans. SOF2 is
 * allowed and the number of SOS scans is not capped, so decode cost is
 * pixels x scans while only pixels are capped. That is a decision, not an
 * oversight. The segment walk stops at the first SOF; everything after it is
 * entropy-coded data that is not length-prefixed, so counting scans means
 * byte-scanning the whole file for markers instead of stepping length-prefixed
 * structures. And PNG/JPEG are decided from a 64 KiB prefix, so for exactly the
 * large files that would matter the count is not available at all — capping
 * only when the whole file happens to be in hand would accept a file through
 * one route and refuse it through another, which is worse than not capping. The
 * residual cost is a slow decode in the browser's own sandboxed renderer, never
 * work in the daemon, and it is bounded by the 8 MiB byte cap because every
 * scan carries its own header.
 *
 * Why every walk is capped twice. Each walk is bounds-checked against the
 * buffer AND limited to a fixed number of iterations. A hostile length field
 * that overruns, or a block stream crafted to make no progress, must end in a
 * refusal rather than a hang or an out-of-range read.
 *
 * Nothing here throws. Every refusal is a returned `SniffResult`, so a caller
 * can never turn a hostile file into a 500.
 */

export type ImageFormat = 'png' | 'jpeg' | 'gif';
export type ImageMime = 'image/png' | 'image/jpeg' | 'image/gif';

export interface ImageInfo {
  format: ImageFormat;
  mime: ImageMime;
  width: number;
  height: number;
  bytes: number;
  /** GIF only, present when > 1. */
  frames?: number;
}

export type ImageRefusal =
  | 'not-an-image' // no known image signature at all
  | 'unsupported-format' // a KNOWN image format that is vetoed (WebP, AVIF, TIFF, BMP, ICO, HEIC, JXL)
  | 'animation' // APNG
  | 'malformed' // signature matched, structure failed or a walk overran
  | 'header-not-found' // dimensions not inside the bytes provided
  | 'too-large'
  | 'too-many-pixels';

export type SniffResult = { ok: true; info: ImageInfo } | { ok: false; refusal: ImageRefusal };

// --- Caps (the numbers the daemon enforces before writing a byte) ---

/** 8 MiB, any allowed format. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** 2 MiB, GIF only — the frame walk spans the whole file, so it must stay small. */
export const MAX_GIF_BYTES = 2 * 1024 * 1024;
/** Pixels per side. */
export const MAX_IMAGE_DIMENSION = 8192;
/** 16 MPix, width * height. Charged to any one image, and to any one GIF frame rect. */
export const MAX_IMAGE_PIXELS = 16_777_216;
export const MAX_GIF_FRAMES = 256;
/** 32 MPix over a whole GIF: frames * screen, and the sum of the frame rects. */
export const MAX_ANIMATED_PIXELS = 33_554_432;
/** 64 KiB, PNG iCCP payload / cumulative JPEG APP2 run. */
export const MAX_ICC_BYTES = 65_536;
/** 64 KiB metadata probe: enough to decide a PNG or a JPEG from a prefix. */
export const IMAGE_HEADER_WINDOW = 65_536;

// --- Walk bounds (iteration caps, independent of the buffer bounds checks) ---

/** PNG chunks visited while looking for the first IDAT. */
export const MAX_PNG_CHUNKS = 256;
/** JPEG segments visited while looking for the first SOF. */
export const MAX_JPEG_SEGMENTS = 1024;
/** Steps of the GIF block walk, shared by the block and sub-block walkers. */
export const MAX_GIF_BLOCKS = 8192;

// --- Byte helpers (no node, no Buffer — Uint8Array only) ---

function ascii(text: string): readonly number[] {
  return Array.from(text, (c) => c.charCodeAt(0));
}

function matchesAt(bytes: Uint8Array, offset: number, pattern: readonly number[]): boolean {
  if (offset + pattern.length > bytes.length) return false;
  for (let i = 0; i < pattern.length; i++) {
    if (bytes[offset + i] !== pattern[i]) return false;
  }
  return true;
}

/** Big-endian u32. Built by multiplication so the sign bit never leaks in. */
function readU32BE(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] * 0x1000000 +
    (bytes[offset + 1] << 16) +
    (bytes[offset + 2] << 8) +
    bytes[offset + 3]
  );
}

function readU16BE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) + bytes[offset + 1];
}

function readU16LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] + (bytes[offset + 1] << 8);
}

function chunkType(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset],
    bytes[offset + 1],
    bytes[offset + 2],
    bytes[offset + 3]
  );
}

function fail(refusal: ImageRefusal): SniffResult {
  return { ok: false, refusal };
}

/**
 * We walked off the end of what we were given. When the caller says the buffer
 * is the whole file that is a truncated (malformed) file; when it is only a
 * prefix the header simply was not in the window we were handed.
 */
function ranOut(complete: boolean): SniffResult {
  return fail(complete ? 'malformed' : 'header-not-found');
}

/**
 * Shared size gate. A zero side is an explicit refusal in its own right —
 * `0 * 60000` passes a pixel-product check, so the product alone is not enough.
 */
function checkDimensions(width: number, height: number): ImageRefusal | null {
  if (width < 1 || height < 1) return 'malformed';
  if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) return 'too-many-pixels';
  if (width * height > MAX_IMAGE_PIXELS) return 'too-many-pixels';
  return null;
}

// --- Signatures ---

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff] as const;
const GIF87A_SIGNATURE = ascii('GIF87a');
const GIF89A_SIGNATURE = ascii('GIF89a');

/**
 * Known image formats that are refused. Flat on purpose: one row per
 * signature, matched by fixed offsets only, so the table reads as a policy
 * document and no branch hides in it. Anything that matches nothing at all is
 * `not-an-image` — SVG, HTML and XML are text and have no magic, and are
 * better served as source by the text path anyway.
 */
interface VetoedSignature {
  /** For the refusal comment only; never reaches a response or a log. */
  readonly label: string;
  readonly offset: number;
  readonly bytes: readonly number[];
  /** Container formats put the brand after the box header. */
  readonly brand?: { readonly offset: number; readonly bytes: readonly number[] };
}

const FTYP = ascii('ftyp');

function brandAt8(text: string): { offset: number; bytes: readonly number[] } {
  return { offset: 8, bytes: ascii(text) };
}

const VETOED_SIGNATURES: readonly VetoedSignature[] = [
  // RIFF container. WebP is the form we care about; the RIFF magic also
  // collides with WAV and AVI, which is one more reason it is not allow-listed.
  { label: 'webp', offset: 0, bytes: ascii('RIFF'), brand: brandAt8('WEBP') },
  // ISOBMFF brands: AVIF and the HEIF family.
  { label: 'avif', offset: 4, bytes: FTYP, brand: brandAt8('avif') },
  { label: 'avis', offset: 4, bytes: FTYP, brand: brandAt8('avis') },
  { label: 'heic', offset: 4, bytes: FTYP, brand: brandAt8('heic') },
  { label: 'heix', offset: 4, bytes: FTYP, brand: brandAt8('heix') },
  { label: 'heim', offset: 4, bytes: FTYP, brand: brandAt8('heim') },
  { label: 'heis', offset: 4, bytes: FTYP, brand: brandAt8('heis') },
  { label: 'hevc', offset: 4, bytes: FTYP, brand: brandAt8('hevc') },
  { label: 'hevx', offset: 4, bytes: FTYP, brand: brandAt8('hevx') },
  { label: 'mif1', offset: 4, bytes: FTYP, brand: brandAt8('mif1') },
  { label: 'msf1', offset: 4, bytes: FTYP, brand: brandAt8('msf1') },
  // TIFF, both byte orders.
  { label: 'tiff-le', offset: 0, bytes: [0x49, 0x49, 0x2a, 0x00] },
  { label: 'tiff-be', offset: 0, bytes: [0x4d, 0x4d, 0x00, 0x2a] },
  // BMP. Two bytes is a weak signature, which is one of the reasons it is refused.
  { label: 'bmp', offset: 0, bytes: ascii('BM') },
  // ICO and CUR share a header shape; both are containers of containers.
  { label: 'ico', offset: 0, bytes: [0x00, 0x00, 0x01, 0x00] },
  { label: 'cur', offset: 0, bytes: [0x00, 0x00, 0x02, 0x00] },
  // JPEG XL: bare codestream and ISOBMFF container.
  { label: 'jxl-codestream', offset: 0, bytes: [0xff, 0x0a] },
  {
    label: 'jxl-container',
    offset: 0,
    bytes: [0x00, 0x00, 0x00, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a],
  },
];

function matchesVetoed(bytes: Uint8Array): boolean {
  return VETOED_SIGNATURES.some(
    (sig) =>
      matchesAt(bytes, sig.offset, sig.bytes) &&
      (sig.brand === undefined || matchesAt(bytes, sig.brand.offset, sig.brand.bytes))
  );
}

// --- PNG ---

/**
 * Legal bit-depth values per colour type, straight from the PNG spec. An
 * illegal pair means the file is not a PNG a conforming decoder would accept,
 * so we refuse rather than let a decoder decide what to do with it.
 */
const PNG_LEGAL_DEPTHS: Readonly<Record<number, readonly number[]>> = {
  0: [1, 2, 4, 8, 16], // greyscale
  2: [8, 16], // truecolour
  3: [1, 2, 4, 8], // indexed
  4: [8, 16], // greyscale + alpha
  6: [8, 16], // truecolour + alpha
};

/** Signature (8) + IHDR length/type (8) + width/height (8) + depth + colour type. */
const PNG_IHDR_END = 26;

function sniffPng(bytes: Uint8Array, declaredSize: number, complete: boolean): SniffResult {
  if (bytes.length < PNG_IHDR_END) return ranOut(complete);
  if (readU32BE(bytes, 8) !== 13) return fail('malformed');
  if (chunkType(bytes, 12) !== 'IHDR') return fail('malformed');

  const width = readU32BE(bytes, 16);
  const height = readU32BE(bytes, 20);
  const sizeRefusal = checkDimensions(width, height);
  if (sizeRefusal) return fail(sizeRefusal);

  const legalDepths = PNG_LEGAL_DEPTHS[bytes[25]];
  if (!legalDepths || !legalDepths.includes(bytes[24])) return fail('malformed');

  const walk = walkPngChunks(bytes, complete);
  if (walk) return walk;

  return {
    ok: true,
    info: { format: 'png', mime: 'image/png', width, height, bytes: declaredSize },
  };
}

/**
 * Walk the length-prefixed chunk list up to the first IDAT, which is where the
 * metadata ends and the pixels begin. Returns a refusal, or null to accept.
 *
 * A chunk length is an unsigned 32-bit number and every step advances by at
 * least 12 bytes, so the cursor cannot cycle; the iteration cap and the
 * end-of-buffer check are what stop an overrunning length.
 */
function walkPngChunks(bytes: Uint8Array, complete: boolean): SniffResult | null {
  let pos = 8;
  for (let visited = 0; visited < MAX_PNG_CHUNKS; visited++) {
    if (pos + 8 > bytes.length) return ranOut(complete);
    const length = readU32BE(bytes, pos);
    const type = chunkType(bytes, pos + 4);

    // IDAT ends the metadata region: everything we veto on must appear before it.
    if (type === 'IDAT') return null;
    // acTL before IDAT is APNG — a second animation decode path, refused even
    // though the PNG signature matched.
    if (type === 'acTL') return fail('animation');
    if (type === 'iCCP' && length > MAX_ICC_BYTES) return fail('malformed');

    // length + type + payload + CRC
    const next = pos + 12 + length;
    if (next <= pos || !Number.isSafeInteger(next)) return fail('malformed');
    pos = next;
  }
  return fail('malformed');
}

// --- JPEG ---

const MARKER_SOS = 0xda;
const MARKER_APP2 = 0xe2;

/** Markers that may legally follow SOI. Anything else is not a JPEG we serve. */
const JPEG_LEAD_MARKERS = new Set([0xdb, 0xee, 0xc0, 0xc1, 0xc2, 0xc4]);

function isLegalLeadMarker(marker: number): boolean {
  return (marker >= 0xe0 && marker <= 0xef) || JPEG_LEAD_MARKERS.has(marker);
}

/** Markers that carry no length field: TEM, the restart markers, SOI and EOI. */
function isStandaloneMarker(marker: number): boolean {
  return marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9);
}

/** SOFn: 0xC0-0xCF minus DHT (C4), the reserved JPG (C8) and DAC (CC). */
function isSofMarker(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

/** Baseline, extended sequential and progressive. Everything else is refused. */
const ALLOWED_SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2]);

function sniffJpeg(bytes: Uint8Array, declaredSize: number, complete: boolean): SniffResult {
  if (bytes.length < 4) return ranOut(complete);
  if (!isLegalLeadMarker(bytes[3])) return fail('malformed');
  return walkJpegSegments(bytes, declaredSize, complete);
}

/**
 * Read the frame header a SOF marker introduces. Layout from the marker byte:
 * +2 length, +4 sample precision, +5 height, +7 width.
 */
function readSofFrame(
  bytes: Uint8Array,
  pos: number,
  marker: number,
  declaredSize: number,
  complete: boolean
): SniffResult {
  // Lossless (C3), differential (C5-C7), arithmetic (C9-CB, CD-CF): decoder
  // paths browsers barely exercise, so they are refused rather than served.
  if (!ALLOWED_SOF_MARKERS.has(marker)) return fail('malformed');
  if (pos + 9 > bytes.length) return ranOut(complete);

  const height = readU16BE(bytes, pos + 5);
  const width = readU16BE(bytes, pos + 7);
  const sizeRefusal = checkDimensions(width, height);
  if (sizeRefusal) return fail(sizeRefusal);

  return {
    ok: true,
    info: { format: 'jpeg', mime: 'image/jpeg', width, height, bytes: declaredSize },
  };
}

/** What sits at the cursor: one step of the segment walk, decided in isolation. */
type JpegStep =
  | { kind: 'skip'; next: number }
  | { kind: 'sof'; marker: number }
  | { kind: 'segment'; marker: number; length: number }
  | { kind: 'malformed' }
  | { kind: 'ran-out' };

function readJpegStep(bytes: Uint8Array, pos: number): JpegStep {
  if (pos + 1 >= bytes.length) return { kind: 'ran-out' };
  if (bytes[pos] !== 0xff) return { kind: 'malformed' };

  const marker = bytes[pos + 1];
  // A run of 0xFF is legal padding before the marker byte. Each skipped fill
  // byte costs one iteration of the walk, so padding buys no extra work.
  if (marker === 0xff) return { kind: 'skip', next: pos + 1 };
  if (isStandaloneMarker(marker)) return { kind: 'skip', next: pos + 2 };
  // Scan data before any frame header means we will never find the dimensions.
  if (marker === MARKER_SOS) return { kind: 'malformed' };

  if (pos + 4 > bytes.length) return { kind: 'ran-out' };
  const length = readU16BE(bytes, pos + 2);
  if (length < 2) return { kind: 'malformed' };
  if (isSofMarker(marker)) return { kind: 'sof', marker };
  return { kind: 'segment', marker, length };
}

/**
 * Walk the marker segments up to the first SOF, which carries the dimensions.
 *
 * The ICC run is summed over every APP2 segment rather than only over the ones
 * tagged `ICC_PROFILE`: a single segment cannot exceed 64 KiB (the length is a
 * u16), so a profile bomb has to be split across segments, and counting all of
 * APP2 is the version of that check with nothing to evade.
 */
function walkJpegSegments(bytes: Uint8Array, declaredSize: number, complete: boolean): SniffResult {
  let pos = 2;
  let iccBytes = 0;

  for (let visited = 0; visited < MAX_JPEG_SEGMENTS; visited++) {
    const step = readJpegStep(bytes, pos);
    if (step.kind === 'ran-out') return ranOut(complete);
    if (step.kind === 'malformed') return fail('malformed');
    if (step.kind === 'sof') return readSofFrame(bytes, pos, step.marker, declaredSize, complete);
    if (step.kind === 'skip') {
      pos = step.next;
      continue;
    }
    if (step.marker === MARKER_APP2) {
      iccBytes += step.length - 2;
      if (iccBytes > MAX_ICC_BYTES) return fail('malformed');
    }
    pos += 2 + step.length;
  }
  return fail('malformed');
}

// --- GIF ---

const GIF_TRAILER = 0x3b;
const GIF_IMAGE_DESCRIPTOR = 0x2c;
const GIF_EXTENSION = 0x21;

/**
 * Cursor for the GIF walk. `left` is one shared iteration budget spent by both
 * the block walker and the sub-block walker, so however the block stream nests
 * the total work stays bounded. `pixels` sums the frame rects and `overBudget`
 * records that a rect broke a cap, so the pixel budget covers the frames and
 * not just the logical screen.
 */
interface GifCursor {
  pos: number;
  left: number;
  pixels: number;
  overBudget: boolean;
}

/** Colour table size in bytes from a packed flags byte, or 0 when absent. */
function colorTableBytes(flags: number): number {
  return (flags & 0x80) === 0 ? 0 : 3 * (1 << ((flags & 0x07) + 1));
}

function sniffGif(bytes: Uint8Array, declaredSize: number, complete: boolean): SniffResult {
  // The frame walk spans the whole file, so a GIF is only ever decided with
  // every byte in hand — and that is only affordable under a tighter cap.
  if (declaredSize > MAX_GIF_BYTES) return fail('too-large');
  if (!complete) return fail('header-not-found');
  if (bytes.length < 13) return ranOut(complete);

  const width = readU16LE(bytes, 6);
  const height = readU16LE(bytes, 8);
  const sizeRefusal = checkDimensions(width, height);
  if (sizeRefusal) return fail(sizeRefusal);

  const cursor: GifCursor = {
    pos: 13 + colorTableBytes(bytes[10]),
    left: MAX_GIF_BLOCKS,
    pixels: 0,
    overBudget: false,
  };
  const frames = walkGifBlocks(bytes, cursor);
  if (frames === null) return fail('malformed');
  if (frames < 1) return fail('malformed');
  if (frames > MAX_GIF_FRAMES) return fail('too-many-pixels');
  // The screen and the frame rects are two claims about the same decode, so
  // both are charged: the rects during the walk, the screen times the frame
  // count here.
  if (cursor.overBudget) return fail('too-many-pixels');
  if (frames * width * height > MAX_ANIMATED_PIXELS) return fail('too-many-pixels');

  const info: ImageInfo = {
    format: 'gif',
    mime: 'image/gif',
    width,
    height,
    bytes: declaredSize,
  };
  if (frames > 1) info.frames = frames;
  return { ok: true, info };
}

/**
 * Walk the whole block stream to the trailer, counting image descriptors and
 * summing their rects. Returns the frame count, or null when the stream is
 * malformed, truncated or outruns the shared budget. Refusing on anything
 * unexpected is what keeps the frame count honest — a stream we cannot fully
 * parse tells us nothing about how many frames a decoder would find.
 */
function walkGifBlocks(bytes: Uint8Array, cursor: GifCursor): number | null {
  let frames = 0;
  while (cursor.left-- > 0) {
    if (cursor.pos >= bytes.length) return null;
    const id = bytes[cursor.pos];
    if (id === GIF_TRAILER) return frames;

    const isFrame = id === GIF_IMAGE_DESCRIPTOR;
    const stepped = isFrame ? skipGifImage(bytes, cursor) : skipGifExtension(bytes, cursor, id);
    if (!stepped) return null;
    // Stop as soon as a budget is blown; the caller turns the count and the
    // flag into a refusal, so there is no reason to keep walking. Pixels only
    // ever accumulate, so walking on cannot bring the file back under.
    if (isFrame && ++frames > MAX_GIF_FRAMES) return frames;
    if (cursor.overBudget) return frames;
  }
  return null;
}

/**
 * Advance past one block that is not an image descriptor. An extension is the
 * only thing that may legally be here; anything else is a stream we cannot
 * parse, and a stream we cannot parse tells us nothing about how many frames a
 * decoder would find.
 */
function skipGifExtension(bytes: Uint8Array, cursor: GifCursor, id: number): boolean {
  if (id !== GIF_EXTENSION) return false;
  cursor.pos += 2; // introducer + label
  return skipSubBlocks(bytes, cursor);
}

/**
 * Image descriptor: id, left, top, width, height (2 bytes each), packed flags.
 * The rect is charged to the pixel budget before the walk moves on — the whole
 * 10-byte descriptor is bounds-checked in one go, so reading the rect adds no
 * new read that could run off the end.
 */
function skipGifImage(bytes: Uint8Array, cursor: GifCursor): boolean {
  if (cursor.pos + 10 > bytes.length) return false;
  chargeGifFrame(cursor, readU16LE(bytes, cursor.pos + 5), readU16LE(bytes, cursor.pos + 7));
  const flags = bytes[cursor.pos + 9];
  // descriptor + optional local colour table + LZW minimum code size
  cursor.pos += 10 + colorTableBytes(flags) + 1;
  return skipSubBlocks(bytes, cursor);
}

/**
 * Charge one frame rect to the budget. One rect is one allocation in the
 * decoder, so on its own it may cost no more than a still image: the per-side
 * cap AND the per-image pixel cap. The running sum is then held to the animated
 * cap on top, which is what bounds the file as a whole.
 *
 * A zero-sided rect is not a refusal here the way a zero-sided logical screen
 * is: it decodes to nothing, and the screen check has already established the
 * file has a canvas.
 */
function chargeGifFrame(cursor: GifCursor, width: number, height: number): void {
  const pixels = width * height;
  if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION || pixels > MAX_IMAGE_PIXELS) {
    cursor.overBudget = true;
    return;
  }
  cursor.pixels += pixels;
  if (cursor.pixels > MAX_ANIMATED_PIXELS) cursor.overBudget = true;
}

/** A chain of length-prefixed sub-blocks ended by a zero length byte. */
function skipSubBlocks(bytes: Uint8Array, cursor: GifCursor): boolean {
  while (cursor.left-- > 0) {
    if (cursor.pos >= bytes.length) return false;
    const length = bytes[cursor.pos];
    cursor.pos += 1 + length;
    if (length === 0) return cursor.pos <= bytes.length;
  }
  return false;
}

// --- Entry points ---

function startsWithGif(bytes: Uint8Array): boolean {
  return matchesAt(bytes, 0, GIF87A_SIGNATURE) || matchesAt(bytes, 0, GIF89A_SIGNATURE);
}

/**
 * Decide what `bytes` is. `complete` means `bytes` is the ENTIRE file: GIF
 * requires it (the frame walk spans the file), PNG and JPEG can be decided
 * from a 64 KiB prefix. `declaredSize` is the real file size, which is what
 * the byte caps and `ImageInfo.bytes` are about — it is not assumed to equal
 * `bytes.length`.
 *
 * Default deny: no signature match, a failed structural check, or a walk that
 * overruns its bound all end in a refusal.
 */
export function sniffImage(
  bytes: Uint8Array,
  declaredSize: number,
  complete: boolean
): SniffResult {
  if (declaredSize > MAX_IMAGE_BYTES) return fail('too-large');
  if (matchesAt(bytes, 0, PNG_SIGNATURE)) return sniffPng(bytes, declaredSize, complete);
  if (matchesAt(bytes, 0, JPEG_SIGNATURE)) return sniffJpeg(bytes, declaredSize, complete);
  if (startsWithGif(bytes)) return sniffGif(bytes, declaredSize, complete);
  if (matchesVetoed(bytes)) return fail('unsupported-format');
  return fail('not-an-image');
}

/**
 * How many bytes a caller must read before `sniffImage` can decide, given a
 * 16-byte peek at the head of the file.
 *
 * GIF needs the whole file, but only up to its own cap: past that the verdict
 * is `too-large` regardless, so there is no reason to read further.
 */
export function sniffWindow(peek: Uint8Array, size: number): number {
  return startsWithGif(peek) ? Math.min(size, MAX_GIF_BYTES) : IMAGE_HEADER_WINDOW;
}
