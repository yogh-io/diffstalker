import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DiffResult, DiffLine } from './diff.js';

const FILE_HEADER = /^diff --git a\/.+ b\/(.+)$/;

/**
 * Hash a hunk's added/removed lines. Context lines and the @@ header are
 * excluded so the identity survives line-number shifts caused by edits
 * elsewhere in the file. Exported: the journal's silence test uses the
 * same convention (djb2 over +/- lines only).
 */
export function hashHunkBody(parts: string[]): string {
  let h = 5381;
  for (const part of parts) {
    for (let i = 0; i < part.length; i++) {
      h = ((h << 5) + h + part.charCodeAt(i)) | 0;
    }
    h = ((h << 5) + h + 10) | 0; // line separator
  }
  return (h >>> 0).toString(36);
}

interface HunkRef {
  file: string;
  key: string;
  headerLine: DiffLine;
}

function collectHunks(diff: DiffResult): HunkRef[] {
  const refs: HunkRef[] = [];
  let currentFile = '';
  let current: { headerLine: DiffLine; body: string[] } | null = null;

  const flush = (): void => {
    if (current && currentFile) {
      refs.push({
        file: currentFile,
        key: `${currentFile}\0${hashHunkBody(current.body)}`,
        headerLine: current.headerLine,
      });
    }
    current = null;
  };

  for (const line of diff.lines) {
    if (line.type === 'header') {
      flush();
      const match = line.content.match(FILE_HEADER);
      if (match) currentFile = match[1];
    } else if (line.type === 'hunk') {
      flush();
      current = { headerLine: line, body: [] };
    } else if (current && (line.type === 'addition' || line.type === 'deletion')) {
      current.body.push(line.content);
    }
  }
  flush();

  return refs;
}

/**
 * Tracks when each hunk's content was last observed to change, so the diff
 * view can show "5 minutes ago" per hunk.
 *
 * Git has no per-region history for uncommitted changes, so this works by
 * observation: a hunk key (file + content hash) seen for the first time is
 * stamped with the file's mtime - for a fresh edit that IS just now, and for
 * changes that predate this process it is the honest last-write time. A hunk
 * whose content changes gets a new key, and therefore a new stamp; hunks
 * whose content merely moves keep their stamp.
 */
export class HunkTimeTracker {
  private stamps = new Map<string, number>();

  constructor(private repoPath: string) {}

  /**
   * Record first-seen times for unknown hunks and annotate the hunk header
   * lines with `editedAt` in place.
   */
  stamp(diff: DiffResult | null | undefined): void {
    if (!diff) return;

    const mtimes = new Map<string, number>();
    for (const ref of collectHunks(diff)) {
      let at = this.stamps.get(ref.key);
      if (at === undefined) {
        let mtime = mtimes.get(ref.file);
        if (mtime === undefined) {
          mtime = this.mtimeOf(ref.file);
          mtimes.set(ref.file, mtime);
        }
        at = mtime;
        this.stamps.set(ref.key, at);
      }
      ref.headerLine.editedAt = at;
    }
  }

  /** Drop stamps for files that no longer have changes. */
  prune(activeFiles: ReadonlySet<string>): void {
    for (const key of this.stamps.keys()) {
      const file = key.slice(0, key.indexOf('\0'));
      if (!activeFiles.has(file)) {
        this.stamps.delete(key);
      }
    }
  }

  private mtimeOf(file: string): number {
    try {
      return fs.statSync(path.join(this.repoPath, file)).mtimeMs;
    } catch {
      return Date.now();
    }
  }
}
