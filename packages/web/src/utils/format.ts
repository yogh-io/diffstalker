/** Small pure formatting helpers for the shell. */

import type { FileStatus } from '@diffstalker/core/git/status';

/** Last path segment ('/home/u/repo' → 'repo'). */
export function basename(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** One-letter status glyph, same letters the CLI uses. */
export function statusLetter(status: FileStatus): string {
  switch (status) {
    case 'modified':
      return 'M';
    case 'added':
      return 'A';
    case 'deleted':
      return 'D';
    case 'untracked':
      return '?';
    case 'renamed':
      return 'R';
    case 'copied':
      return 'C';
  }
}
