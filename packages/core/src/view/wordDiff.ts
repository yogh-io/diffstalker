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
