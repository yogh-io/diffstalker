import { describe, it, expect } from 'bun:test';
import { isBinaryContent } from './binaryDetect.js';

const enc = new TextEncoder();

/** `size` bytes of 'a' with a NUL planted at `nulAt` (nowhere when negative). */
function bytesWithNul(size: number, nulAt: number): Uint8Array {
  const bytes = new Uint8Array(size).fill(0x61);
  if (nulAt >= 0) bytes[nulAt] = 0;
  return bytes;
}

describe('isBinaryContent', () => {
  it('is true for a NUL at the very start', () => {
    expect(isBinaryContent(bytesWithNul(16, 0))).toBe(true);
  });

  it('is true for a NUL on the last byte of the 8 KiB window', () => {
    expect(isBinaryContent(bytesWithNul(16384, 8191))).toBe(true);
  });

  it('is false for a NUL just past the 8 KiB window', () => {
    // The heuristic is deliberately bounded: a NUL at 8192 is not looked at.
    expect(isBinaryContent(bytesWithNul(16384, 8192))).toBe(false);
  });

  it('is false for a NUL far past the window', () => {
    expect(isBinaryContent(bytesWithNul(100000, 99999))).toBe(false);
  });

  it('is false for plain text', () => {
    expect(isBinaryContent(enc.encode('const x = 1;\nconst y = 2;\n'))).toBe(false);
  });

  it('is false for empty input', () => {
    expect(isBinaryContent(new Uint8Array(0))).toBe(false);
  });

  it('is false for UTF-8 multibyte text', () => {
    expect(isBinaryContent(enc.encode('héllo 日本語 — ünïcode 🎉\n'))).toBe(false);
  });

  it('is true for a real binary header', () => {
    // PNG signature: the 0x00 in the IHDR length is inside the window.
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    ]);
    expect(isBinaryContent(png)).toBe(true);
  });

  it('accepts a Buffer, which is what the fs callers hand it', () => {
    expect(isBinaryContent(Buffer.from('text only'))).toBe(false);
    expect(isBinaryContent(Buffer.from([0x61, 0x00, 0x62]))).toBe(true);
  });
});
