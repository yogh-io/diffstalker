/**
 * Utilities for manually breaking long lines at exact character boundaries.
 * This gives us full control over line wrapping behavior in the diff view.
 */

export interface LineSegment {
  text: string;
  isContinuation: boolean;
}

/**
 * Break a string into segments that fit within the given width.
 * Breaks at exact character boundaries for predictable, consistent output.
 *
 * @param content - The string to break
 * @param maxWidth - Maximum width for each segment
 * @param validate - If true, validates the result and throws on errors (default: true)
 * @returns Array of line segments
 */
export function breakLine(
  content: string,
  maxWidth: number,
  validate: boolean = true
): LineSegment[] {
  if (maxWidth <= 0) {
    return [{ text: content, isContinuation: false }];
  }

  if (content.length <= maxWidth) {
    return [{ text: content, isContinuation: false }];
  }

  const segments: LineSegment[] = [];
  let remaining = content;
  let isFirst = true;

  while (remaining.length > 0) {
    if (remaining.length <= maxWidth) {
      segments.push({ text: remaining, isContinuation: !isFirst });
      break;
    }

    segments.push({
      text: remaining.slice(0, maxWidth),
      isContinuation: !isFirst,
    });

    remaining = remaining.slice(maxWidth);
    isFirst = false;
  }

  // Validate the result
  if (validate) {
    validateBreakResult(content, maxWidth, segments);
  }

  return segments;
}

/**
 * Validate that line breaking produced correct results.
 * Throws an error if validation fails, making issues visible during development.
 */
function validateBreakResult(original: string, maxWidth: number, segments: LineSegment[]): void {
  // Check 1: Segments should join to equal original
  const joined = segments.map((s) => s.text).join('');
  if (joined !== original) {
    throw new Error(
      `[LineBreaking] Content was lost during breaking!\n` +
        `Original (${original.length} chars): "${original.slice(0, 50)}${original.length > 50 ? '...' : ''}"\n` +
        `Joined (${joined.length} chars): "${joined.slice(0, 50)}${joined.length > 50 ? '...' : ''}"`
    );
  }

  // Check 2: No segment should exceed maxWidth (except if maxWidth is too small)
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (segment.text.length > maxWidth && maxWidth >= 1) {
      throw new Error(
        `[LineBreaking] Segment ${i} exceeds maxWidth!\n` +
          `Segment length: ${segment.text.length}, maxWidth: ${maxWidth}\n` +
          `Segment: "${segment.text.slice(0, 50)}${segment.text.length > 50 ? '...' : ''}"`
      );
    }
  }

  // Check 3: First segment should not be marked as continuation
  if (segments.length > 0 && segments[0].isContinuation) {
    throw new Error(`[LineBreaking] First segment incorrectly marked as continuation!`);
  }

  // Check 4: Subsequent segments should be marked as continuation
  for (let i = 1; i < segments.length; i++) {
    if (!segments[i].isContinuation) {
      throw new Error(`[LineBreaking] Segment ${i} should be marked as continuation but isn't!`);
    }
  }
}

/**
 * Calculate how many visual rows a content string will take when broken.
 *
 * @param content - The string content
 * @param maxWidth - Maximum width per row
 * @returns Number of rows needed
 */
export function getLineRowCount(content: string, maxWidth: number): number {
  if (maxWidth <= 0) return 1;
  if (content.length <= maxWidth) return 1;

  // Simple math since we break at exact boundaries
  return Math.ceil(content.length / maxWidth);
}
