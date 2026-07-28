/** Small pure formatting helpers for the shell. */

import type { FileStatus } from '@diffstalker/core/git/status';

/** Last path segment ('/home/u/repo' → 'repo'). */
export function basename(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** Drop trailing slashes without a regex (avoids a ReDoS lint flag). */
function stripTrailingSlashes(path: string): string {
  let end = path.length;
  while (end > 1 && path[end - 1] === '/') end--;
  return path.slice(0, end);
}

/** Containing directory ('/a/b/c' → '/a/b'); '/' stays '/'. */
export function parentDir(path: string): string {
  const trimmed = stripTrailingSlashes(path);
  const cut = trimmed.lastIndexOf('/');
  if (cut <= 0) return '/';
  return trimmed.slice(0, cut);
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
