/**
 * Binary sniffing by NUL scan.
 *
 * This lived module-private inside git/explorerData.ts. It sits in utils/ now
 * because git/diff.ts needs it too (untracked binaries must not be emitted as
 * text) and git/ -> git/ would be a cycle waiting to happen, while git/ ->
 * utils/ is the direction dependency-cruiser already allows.
 *
 * The rule is git's own heuristic: a NUL byte near the start means "not text".
 * It is cheap, has no false positives worth caring about on real source trees,
 * and deliberately does not try to be a format detector — that is imageSniff's
 * job, on magic bytes.
 */

/** How far in we look for a NUL. Matches git's own buffer size. */
const SCAN_BYTES = 8192;

/**
 * True when the bytes look binary: a NUL anywhere in the first 8 KiB.
 *
 * A file whose only NUL sits past 8 KiB reads as text, exactly as before the
 * move — this is a display heuristic, not a guarantee.
 */
export function isBinaryContent(bytes: Uint8Array): boolean {
  const checkLength = Math.min(bytes.length, SCAN_BYTES);
  for (let i = 0; i < checkLength; i++) {
    if (bytes[i] === 0) return true;
  }
  return false;
}
