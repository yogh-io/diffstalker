/** Small pure formatting helpers for the shell. */

import type { FileStatus } from '@diffstalker/core/git/status';

/** Last path segment ('/home/u/repo' → 'repo'). */
export function basename(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** Human-readable byte size ('482 B', '1.2 KB', '3.4 MB'). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
