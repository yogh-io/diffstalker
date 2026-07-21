/**
 * Diff line content extraction shared by the CLI and web row builders.
 */

import type { DiffLine } from '../git/diff.js';

/**
 * Get the content of a diff line without the leading +/-/space character.
 */
export function getLineContent(line: DiffLine): string {
  if (line.type === 'addition' || line.type === 'deletion') {
    return line.content.slice(1);
  }
  if (line.type === 'context' && line.content.startsWith(' ')) {
    return line.content.slice(1);
  }
  return line.content;
}
