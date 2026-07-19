/**
 * ANSI-aware string truncation utility.
 *
 * Truncates strings containing ANSI escape codes at a visual character limit
 * while preserving formatting up to the truncation point.
 */

import { ANSI_PATTERN, ANSI_RESET } from './ansi.js';

/**
 * Calculate the visual length of a string (excluding ANSI codes).
 */
export function visualLength(str: string): number {
  return str.replace(ANSI_PATTERN, '').length;
}

/**
 * Truncate a string with ANSI codes at a visual character limit.
 *
 * @param str - String potentially containing ANSI escape codes
 * @param maxVisualLength - Maximum visual characters (not counting ANSI codes)
 * @param suffix - Suffix to append when truncated (default: '…')
 * @returns Truncated string with ANSI reset if needed
 */
export function truncateAnsi(str: string, maxVisualLength: number, suffix: string = '…'): string {
  if (maxVisualLength <= 0) {
    return suffix;
  }

  // Quick check: if no ANSI codes and short enough, return as-is
  if (!str.includes('\x1b') && str.length <= maxVisualLength) {
    return str;
  }

  // If no ANSI codes, simple truncation
  if (!str.includes('\x1b')) {
    if (str.length <= maxVisualLength) {
      return str;
    }
    return str.slice(0, maxVisualLength - suffix.length) + suffix;
  }

  // Parse string into segments: either ANSI codes or visible text
  const segments: Array<{ type: 'ansi' | 'text'; content: string }> = [];
  let lastIndex = 0;

  // Reset the regex state
  ANSI_PATTERN.lastIndex = 0;

  let match;
  while ((match = ANSI_PATTERN.exec(str)) !== null) {
    // Add text before this ANSI code
    if (match.index > lastIndex) {
      segments.push({ type: 'text', content: str.slice(lastIndex, match.index) });
    }
    // Add the ANSI code
    segments.push({ type: 'ansi', content: match[0] });
    lastIndex = match.index + match[0].length;
  }

  // Add remaining text after last ANSI code
  if (lastIndex < str.length) {
    segments.push({ type: 'text', content: str.slice(lastIndex) });
  }

  // Build result, tracking visual length
  let result = '';
  let currentVisualLength = 0;
  const targetLength = maxVisualLength - suffix.length;
  let hasAnsiCodes = false;
  let truncated = false;

  for (const segment of segments) {
    if (segment.type === 'ansi') {
      // Always include ANSI codes (they don't take visual space)
      result += segment.content;
      hasAnsiCodes = true;
    } else {
      // Text segment - check if it fits
      const remainingSpace = targetLength - currentVisualLength;

      if (remainingSpace <= 0) {
        // No more space
        truncated = true;
        break;
      }

      if (segment.content.length <= remainingSpace) {
        // Entire segment fits
        result += segment.content;
        currentVisualLength += segment.content.length;
      } else {
        // Partial fit - truncate this segment
        result += segment.content.slice(0, remainingSpace);
        truncated = true;
        break;
      }
    }
  }

  if (truncated) {
    // Reset formatting before suffix to ensure clean state
    if (hasAnsiCodes) {
      result += ANSI_RESET;
    }
    result += suffix;
  }

  return result;
}

/**
 * Check if a string needs truncation at the given visual length.
 */
export function needsTruncation(str: string, maxVisualLength: number): boolean {
  return visualLength(str) > maxVisualLength;
}
