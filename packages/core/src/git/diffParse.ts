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

/**
 * A parsed diff. `lines` is the ONLY representation: the raw text is
 * exactly `rawFromLines(lines)`, so carrying both would duplicate every
 * diff on the wire and in memory (it was ~a third of every diff response,
 * and doubled what the journal retains). Anything that needs patch text —
 * hunk staging, hunk counting, per-file splitting — rebuilds it.
 */
export interface DiffResult {
  lines: DiffLine[];
}

/**
 * The raw diff text these lines came from: line contents joined, with
 * git's trailing newline. Lossless — the parser keeps every line verbatim
 * and only drops the trailing empty string that the final newline
 * produces, which this puts back.
 */
export function rawFromLines(lines: readonly DiffLine[]): string {
  if (lines.length === 0) return '';
  return lines.map((line) => line.content).join('\n') + '\n';
}

/**
 * Byte size of the raw text these lines represent, without building it —
 * the measure size budgets used to take from `raw.length`.
 */
export function diffByteSize(lines: readonly DiffLine[]): number {
  let bytes = 0;
  for (const line of lines) bytes += line.content.length + 1; // + newline
  return bytes;
}

/**
 * Per-file diff caps.
 *
 * A single file's diff over EITHER limit is not sent at all: its body is
 * replaced by a one-line notice, keeping the file's own `diff --git`
 * header lines. This is deliberately the shape git already uses for
 * binary files ("Binary files a/x and b/y differ"), so the notice rides
 * every existing path — parser, wire format, splitters, renderers —
 * without a new wire field or a special case per caller.
 *
 * Without this cap one generated fixture (a 121k-line .gml, a
 * package-lock.json) can be tens of MB on its own, which the browser then
 * has to receive, parse, and lay out. The limits match the file-viewer
 * caps in `git/explorerData` (MAX_FILE_SIZE / MAX_DISPLAY_LINES) — the
 * same "too big to display" threshold, applied to diffs.
 *
 * The line cap matters independently of the byte cap: 30k short lines
 * cost little to transfer but still build 30k row objects in the client.
 */
export const MAX_FILE_DIFF_LINES = 5000;
/**
 * The byte-equivalent of the line cap (~5000 lines of ordinary source at
 * ~50 bytes a line). Sized this way on purpose: what it catches that the
 * line cap does not is the LONG-LINE file — a minified bundle, a
 * single-line exported SVG — which is few lines but megabytes wide, and
 * is the worst thing to hand a renderer.
 */
export const MAX_FILE_DIFF_BYTES = 256 * 1024;

/** Prefix of the replacement line; renderers match on it. */
export const LARGE_DIFF_NOTICE_PREFIX = 'Large file — diff not shown';

/** Group digits so a line count reads at a glance (121285 -> 121,285). */
function groupDigits(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

/**
 * The line that replaces an over-cap file diff. `lines` is omitted when
 * the content was never read (an untracked file refused on its size), so
 * the notice never claims a line count it does not have.
 */
export function largeDiffNotice(bytes: number, lines?: number): string {
  const size = formatBytes(bytes);
  const detail = lines === undefined ? size : `${size}, ${groupDigits(lines)} lines`;
  return `${LARGE_DIFF_NOTICE_PREFIX} (${detail})`;
}

/** True when this diff was withheld for being too large. */
export function isLargeFileDiff(diff: DiffResult): boolean {
  return diff.lines.some(
    (line) => line.type === 'header' && line.content.startsWith(LARGE_DIFF_NOTICE_PREFIX)
  );
}

/** Count lines without materializing an array (these strings can be huge). */
function countLines(text: string): number {
  if (text.length === 0) return 0;
  let count = 1;
  let index = -1;
  while ((index = text.indexOf('\n', index + 1)) !== -1) count++;
  return count;
}

/** Replace one file chunk's body with the notice, keeping its headers. */
function capChunk(chunk: string, bytes: number, lines: number): string {
  const chunkLines = chunk.split('\n');
  const firstHunk = chunkLines.findIndex((line) => line.startsWith('@@'));
  // No hunk header at all would mean a pathological all-header chunk;
  // keep only git's standard four so the slice can never be unbounded.
  const header = chunkLines.slice(0, firstHunk === -1 ? 4 : firstHunk);
  return `${[...header, largeDiffNotice(bytes, lines)].join('\n')}\n`;
}

/**
 * Apply the per-file cap across a raw diff covering one or more files.
 *
 * Returns the input unchanged (same string identity) when every file is
 * within the caps — the common case, and one the client's identity
 * checks benefit from.
 */
export function capLargeFileDiffs(raw: string): string {
  if (raw.length === 0) return raw;
  // Every file's chunk starts at its `diff --git` line.
  const chunks = raw.split(/(?=^diff --git )/m);
  let capped = false;
  const result = chunks.map((chunk) => {
    const bytes = chunk.length;
    if (bytes <= MAX_FILE_DIFF_BYTES) {
      const lines = countLines(chunk);
      if (lines <= MAX_FILE_DIFF_LINES) return chunk;
      capped = true;
      return capChunk(chunk, bytes, lines);
    }
    capped = true;
    return capChunk(chunk, bytes, countLines(chunk));
  });
  return capped ? result.join('') : raw;
}

export function parseDiffLine(line: string): DiffLine {
  if (
    line.startsWith('diff --git') ||
    line.startsWith('index ') ||
    line.startsWith('---') ||
    line.startsWith('+++') ||
    line.startsWith('new file') ||
    line.startsWith('deleted file') ||
    line.startsWith('Binary files') ||
    line.startsWith(LARGE_DIFF_NOTICE_PREFIX)
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
  // An empty diff has NO lines. Splitting '' yields [''], which used to
  // become a phantom empty context line; harmless while the raw text was
  // carried alongside, but now that lines are the only representation it
  // would make rawFromLines([]) and the empty diff disagree ('\n' vs '').
  if (raw === '') return [];
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
      line.startsWith(LARGE_DIFF_NOTICE_PREFIX) ||
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
