/**
 * Pure diff/patch parsing — no simple-git, no chokidar, no filesystem.
 *
 * Kept dependency-free on purpose: the CLI imports `extractHunkPatch` (and
 * these types) for hunk staging, and pulling it from here instead of `diff.ts`
 * keeps the whole git-process layer (simple-git) out of the CLI bundle. The
 * daemon re-exports these through `diff.ts` alongside the exec functions.
 */

export interface DiffLine {
  type: 'header' | 'hunk' | 'addition' | 'deletion' | 'context';
  /** For hunk lines: when this hunk's content was last observed to change (ms). */
  editedAt?: number;
  content: string;
  /** Line number in the old file (for deletions and context) */
  oldLineNum?: number;
  /** Line number in the new file (for additions and context) */
  newLineNum?: number;
}

export interface DiffResult {
  raw: string;
  lines: DiffLine[];
}

export function parseDiffLine(line: string): DiffLine {
  if (
    line.startsWith('diff --git') ||
    line.startsWith('index ') ||
    line.startsWith('---') ||
    line.startsWith('+++') ||
    line.startsWith('new file') ||
    line.startsWith('deleted file')
  ) {
    return { type: 'header', content: line };
  }
  if (line.startsWith('@@')) {
    return { type: 'hunk', content: line };
  }
  if (line.startsWith('+')) {
    return { type: 'addition', content: line };
  }
  if (line.startsWith('-')) {
    return { type: 'deletion', content: line };
  }
  return { type: 'context', content: line };
}

/**
 * Parse a hunk header to extract line numbers.
 * Format: @@ -oldStart,oldCount +newStart,newCount @@
 * Example: @@ -1,5 +1,7 @@ or @@ -10 +10,2 @@
 */
export function parseHunkHeader(line: string): { oldStart: number; newStart: number } | null {
  const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
  if (match) {
    return {
      oldStart: parseInt(match[1], 10),
      newStart: parseInt(match[2], 10),
    };
  }
  return null;
}

/**
 * Parse diff output with line numbers.
 * Tracks line numbers through hunks for proper display.
 */
export function parseDiffWithLineNumbers(raw: string): DiffLine[] {
  const lines = raw.split('\n');
  // Remove trailing empty string from the final newline in git output,
  // otherwise it gets parsed as a phantom context line on the last hunk
  if (lines.length > 1 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  const result: DiffLine[] = [];

  let oldLineNum = 0;
  let newLineNum = 0;

  for (const line of lines) {
    if (
      line.startsWith('diff --git') ||
      line.startsWith('index ') ||
      line.startsWith('---') ||
      line.startsWith('+++') ||
      line.startsWith('new file') ||
      line.startsWith('deleted file') ||
      line.startsWith('Binary files') ||
      line.startsWith('similarity index') ||
      line.startsWith('rename from') ||
      line.startsWith('rename to')
    ) {
      result.push({ type: 'header', content: line });
    } else if (line.startsWith('@@')) {
      const hunkInfo = parseHunkHeader(line);
      if (hunkInfo) {
        oldLineNum = hunkInfo.oldStart;
        newLineNum = hunkInfo.newStart;
      }
      result.push({ type: 'hunk', content: line });
    } else if (line.startsWith('+')) {
      result.push({
        type: 'addition',
        content: line,
        newLineNum: newLineNum++,
      });
    } else if (line.startsWith('-')) {
      result.push({
        type: 'deletion',
        content: line,
        oldLineNum: oldLineNum++,
      });
    } else {
      // Context line (starts with space) or empty line
      result.push({
        type: 'context',
        content: line,
        oldLineNum: oldLineNum++,
        newLineNum: newLineNum++,
      });
    }
  }

  return result;
}

/**
 * Count the number of hunks in a raw diff string.
 * A hunk starts with a line beginning with '@@'.
 */
export function countHunks(rawDiff: string): number {
  if (!rawDiff) return 0;
  let count = 0;
  for (const line of rawDiff.split('\n')) {
    if (line.startsWith('@@')) count++;
  }
  return count;
}

/**
 * Extract a valid single-hunk patch from a raw diff.
 * Includes the file headers of the FILE SECTION that contains the
 * Nth hunk (diff --git, index, new file mode, rename from/to, ---,
 * +++) plus that @@ hunk and its lines (including '\ No newline at
 * end of file' markers). The hunk index is 0-based across the WHOLE
 * diff (all file sections, raw order), so a multi-file diff returns
 * each hunk wrapped in its own file's header — never another file's.
 * Returns null if hunkIndex is out of range.
 */
export function extractHunkPatch(rawDiff: string, hunkIndex: number): string | null {
  if (!rawDiff) return null;

  const lines = rawDiff.split('\n');

  // Walk the diff tracking the header block of the CURRENT file
  // section; when the Nth @@ is found, that section's header is the
  // one the patch needs.
  let sectionHeader: string[] = [];
  let inHunkBody = false;
  let hunkCount = -1;
  let hunkStart = -1;
  let hunkHeader: string[] | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('diff --git')) {
      sectionHeader = [lines[i]];
      inHunkBody = false;
    } else if (lines[i].startsWith('@@')) {
      inHunkBody = true;
      hunkCount++;
      if (hunkCount === hunkIndex) {
        hunkStart = i;
        hunkHeader = sectionHeader;
        break;
      }
    } else if (!inHunkBody) {
      sectionHeader.push(lines[i]);
    }
  }

  if (hunkStart === -1 || hunkHeader === null) return null;

  // Collect from that @@ until the next @@ or end-of-content
  const hunkLines: string[] = [lines[hunkStart]];
  for (let i = hunkStart + 1; i < lines.length; i++) {
    if (lines[i].startsWith('@@') || lines[i].startsWith('diff --git')) break;
    hunkLines.push(lines[i]);
  }

  // Remove trailing empty line if present (artifact of split)
  while (hunkLines.length > 1 && hunkLines[hunkLines.length - 1] === '') {
    hunkLines.pop();
  }

  const patch = [...hunkHeader, ...hunkLines].join('\n') + '\n';
  return patch;
}

/**
 * Count the number of hunks per file in a multi-file raw diff string.
 * Returns a map of file path -> hunk count.
 */
export function countHunksPerFile(rawDiff: string): Map<string, number> {
  const result = new Map<string, number>();
  if (!rawDiff) return result;

  let currentFile: string | null = null;
  for (const line of rawDiff.split('\n')) {
    if (line.startsWith('diff --git')) {
      const match = line.match(/^diff --git a\/.+ b\/(.+)$/);
      if (match) {
        currentFile = match[1];
        if (!result.has(currentFile)) {
          result.set(currentFile, 0);
        }
      }
    } else if (line.startsWith('@@') && currentFile) {
      result.set(currentFile, (result.get(currentFile) ?? 0) + 1);
    }
  }
  return result;
}
