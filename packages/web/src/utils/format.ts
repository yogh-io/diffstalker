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
    // git's own porcelain letter for an unmerged path.
    case 'conflicted':
      return 'U';
  }
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * A frozen wall-clock stamp: 'HH:MM' for today, 'Jul 20 14:32' for any
 * other day (with the year too when it is not this year).
 *
 * The day is not optional detail. The journal holds whatever the daemon
 * has kept — it is capped by count and bytes, not by age, and the daemon
 * never idles out — so a laptop that slept puts multi-day entries in the
 * same scroller, where a bare HH:MM silently claims today.
 */
export function formatClock(ts: number, nowMs: number): string {
  const d = new Date(ts);
  const now = new Date(nowMs);
  const hhmm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const sameYear = d.getFullYear() === now.getFullYear();
  if (sameYear && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) return hhmm;
  const dayOpts: Intl.DateTimeFormatOptions = sameYear
    ? { month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', year: 'numeric' };
  return `${d.toLocaleDateString('en-US', dayOpts)} ${hhmm}`;
}

/**
 * Split a path just before its last segment: 'a/b/c.ts' → head 'a/b',
 * tail '/c.ts'. Rendered as two spans, this gives a middle ellipsis — the
 * head ellipsises while the filename stays whole — which plain
 * `text-overflow` cannot do (it always eats the end, the part that names
 * the file). A bare filename is all tail.
 */
export function splitBasename(path: string): { head: string; tail: string } {
  const cut = path.lastIndexOf('/');
  if (cut === -1) return { head: '', tail: path };
  return { head: path.slice(0, cut), tail: path.slice(cut) };
}
