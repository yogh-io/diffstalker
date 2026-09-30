/**
 * Pure diff/patch parsing — no simple-git, no chokidar, no filesystem.
 *
 * Kept dependency-free on purpose: the CLI imports `extractHunkPatch` (and
 * these types) for hunk staging, and pulling it from here instead of `diff.ts`
 * keeps the whole git-process layer (simple-git) out of the CLI bundle.
 * `diff.ts` re-exports these alongside the exec functions.
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
 * has to receive, parse, and lay out. The line cap is the file viewer's
 * MAX_DISPLAY_LINES (`git/explorerData`), the same "too big to display"
 * threshold applied to diffs; the byte cap is its own, lower one (256 KiB
 * against the viewer's 1 MiB).
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

/**
 * Git's extended-header vocabulary: the lines that describe a file
 * rather than hold its content (`git diff` docs, "Generating patch
 * text"), plus our own large-file notice, which rides the same path.
 *
 * ONE list for both parsers on purpose. They used to carry a copy each,
 * and the copies drifted: `old mode`/`new mode` were in neither, so a
 * `chmod +x` fell through to the context branch and rendered as two
 * lines of fake file content numbered from 0.
 */
function isDiffHeaderLine(line: string): boolean {
  return (
    line.startsWith('diff --git') ||
    line.startsWith('index ') ||
    line.startsWith('---') ||
    line.startsWith('+++') ||
    line.startsWith('old mode') ||
    line.startsWith('new mode') ||
    line.startsWith('new file') ||
    line.startsWith('deleted file') ||
    line.startsWith('similarity index') ||
    line.startsWith('dissimilarity index') ||
    line.startsWith('rename from') ||
    line.startsWith('rename to') ||
    line.startsWith('copy from') ||
    line.startsWith('copy to') ||
    line.startsWith('Binary files') ||
    line.startsWith(LARGE_DIFF_NOTICE_PREFIX)
  );
}

/**
 * `\ No newline at end of file` — git's annotation ABOUT the line before
 * it, not a line of either file. The unified format reserves a leading
 * backslash for exactly this, so the prefix is the whole test (a real
 * content line always starts with ' ', '+' or '-').
 *
 * Exported because the row builders need the same test: the marker is
 * parsed as a numberless context line, and a view that mistakes it for
 * one loses the del/add pairing around it. Feed it the RAW line, before
 * getLineContent strips a context line's leading space — after the
 * strip, a real ` \ foo` becomes `\ foo` and reads as a marker.
 */
export function isNoNewlineMarker(line: string): boolean {
  return line.startsWith('\\ ');
}

export function parseDiffLine(line: string): DiffLine {
  if (isDiffHeaderLine(line)) {
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
    if (isDiffHeaderLine(line)) {
      result.push({ type: 'header', content: line });
    } else if (isNoNewlineMarker(line)) {
      // No line number, and neither counter moves: the marker annotates
      // the preceding line instead of being one. Counting it drifted
      // everything after it in the hunk by one on BOTH sides, which in
      // split view made the old and new gutters disagree.
      //
      // Typed 'context' rather than a kind of its own: every view
      // already draws a context row with no gutter value as a dim,
      // numberless line, and this is the shape getDiffForUntracked
      // emits for the same marker, so both paths agree.
      result.push({ type: 'context', content: line });
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
      const filePath = pathFromDiffHeader(line);
      if (filePath !== null) {
        currentFile = filePath;
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

/**
 * How git spells a path that needs it in patch text: C-style quoting.
 *
 * A path with a tab, a double quote, a backslash, a control character or
 * (with core.quotepath, the default) any non-ASCII byte comes out as
 * `"..."` with those bytes escaped — `\t`, `\"`, `\\`, `\346\227\245`.
 * That quoting is in every `diff --git` header line, and there is no
 * option to turn it off there. The list outputs (`--numstat`,
 * `--name-status`) are read with `-z` instead, which prints raw paths
 * NUL-separated; only the patch headers need unquoting.
 */
const C_ESCAPES = new Map<string, number>([
  ['a', 7],
  ['b', 8],
  ['f', 12],
  ['n', 10],
  ['r', 13],
  ['t', 9],
  ['v', 11],
  ['\\', 92],
  ['"', 34],
]);

/** The escape letter git writes for a byte, when it has one. */
const C_ESCAPE_LETTERS = new Map<number, string>(
  [...C_ESCAPES].map(([letter, byte]) => [byte, letter])
);

/**
 * A byte git will not print as-is in a path: a control character, `"`,
 * `\`, or (under core.quotepath, the default) anything non-ASCII.
 */
function needsQuoting(byte: number): boolean {
  return byte < 0x20 || byte === 0x7f || byte >= 0x80 || byte === 0x22 || byte === 0x5c;
}

/**
 * Spell a path the way git does in patch text: as written when nothing in
 * it needs quoting, otherwise C-quoted (the inverse of unquoteGitPath).
 *
 * Every header this codebase writes itself — the new-file diffs it builds
 * for untracked files — goes through this, so it reads back through
 * pathFromDiffHeader exactly like a header git wrote. A raw name such as
 * `weird"` would otherwise end the header in `"` and be taken for a quoted
 * side.
 */
export function quoteGitPath(rawPath: string): string {
  const bytes = new TextEncoder().encode(rawPath);
  if (!bytes.some(needsQuoting)) return rawPath;
  let quoted = '"';
  for (const byte of bytes) {
    const letter = C_ESCAPE_LETTERS.get(byte);
    if (letter !== undefined) quoted += `\\${letter}`;
    else if (needsQuoting(byte)) quoted += `\\${byte.toString(8).padStart(3, '0')}`;
    else quoted += String.fromCharCode(byte);
  }
  return `${quoted}"`;
}

/** Undo git's C-style quoting of a path. A value without quotes is returned as-is. */
export function unquoteGitPath(raw: string): string {
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) return raw;
  const inner = raw.slice(1, -1);
  const encoder = new TextEncoder();
  // Octal escapes are single bytes of a UTF-8 sequence, so the whole
  // string is rebuilt as bytes and decoded once at the end.
  const bytes: number[] = [];
  let at = 0;
  while (at < inner.length) {
    const slash = inner.indexOf('\\', at);
    if (slash === -1) {
      bytes.push(...encoder.encode(inner.slice(at)));
      break;
    }
    bytes.push(...encoder.encode(inner.slice(at, slash)));
    const octal = /^[0-7]{1,3}/.exec(inner.slice(slash + 1, slash + 4));
    if (octal !== null) {
      bytes.push(parseInt(octal[0], 8));
      at = slash + 1 + octal[0].length;
      continue;
    }
    const escaped = C_ESCAPES.get(inner[slash + 1] ?? '');
    if (escaped !== undefined) {
      bytes.push(escaped);
      at = slash + 2;
      continue;
    }
    // Not an escape git writes: keep the backslash as it is.
    bytes.push(92);
    at = slash + 1;
  }
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

/**
 * Where the last quoted token of a header opens, or -1. Inside a quoted
 * token every `"` is escaped, so scanning back from the closing quote,
 * the first `"` behind an even run of backslashes is the opening one.
 */
function openingQuote(text: string): number {
  for (let i = text.length - 2; i >= 0; i--) {
    if (text[i] !== '"') continue;
    let slashes = 0;
    for (let j = i - 1; j >= 0 && text[j] === '\\'; j--) slashes++;
    if (slashes % 2 === 0) return i;
  }
  return -1;
}

/**
 * The new-side path of a `diff --git a/<old> b/<new>` header, unquoted,
 * or null for any other line. The ONE place the header is read: every
 * path parser (hunk counts, compare and history rows, edit-time stamps,
 * the per-file splitter) keys on the path exactly as `git status` spells
 * it, and this is what makes a `"tab\tname.txt"` header match.
 *
 * A quoted side ends in `"`; an unquoted one is everything after the last
 * ` b/` (a plain path may contain spaces, and git writes no better
 * separator in this line).
 */
export function pathFromDiffHeader(line: string): string | null {
  const prefix = 'diff --git ';
  if (!line.startsWith(prefix)) return null;
  const rest = line.slice(prefix.length);
  if (rest.endsWith('"')) {
    const open = openingQuote(rest);
    if (open === -1) return null;
    const unquoted = unquoteGitPath(rest.slice(open));
    return unquoted.startsWith('b/') ? unquoted.slice(2) : null;
  }
  const at = rest.lastIndexOf(' b/');
  return at === -1 ? null : rest.slice(at + 3);
}

/**
 * Parse `git diff --numstat -z` output into per-file addition/deletion
 * counts, keyed by the file's (new) path. Fields are NUL-separated, so a
 * path arrives raw — tabs, quotes and all. A binary file prints `-` for
 * both counts and is recorded as 0/0. A rename or copy prints an empty
 * path field followed by the old and the new path as two more fields.
 */
export function parseNumstat(raw: string): Map<string, { additions: number; deletions: number }> {
  const stats = new Map<string, { additions: number; deletions: number }>();
  const fields = raw.split('\0');
  for (let i = 0; i < fields.length; i++) {
    const record = fields[i];
    if (record === '') continue; // the trailing NUL, or a blank line
    const parts = record.split('\t');
    if (parts.length < 3) continue;
    const additions = parts[0] === '-' ? 0 : parseInt(parts[0], 10);
    const deletions = parts[1] === '-' ? 0 : parseInt(parts[1], 10);
    let filePath = parts.slice(2).join('\t');
    if (filePath === '') {
      // Rename/copy: `<add>\t<del>\t` then `<old>` and `<new>` fields.
      filePath = fields[i + 2] ?? '';
      i += 2;
    }
    if (filePath !== '') stats.set(filePath, { additions, deletions });
  }
  return stats;
}

/** One row of `git diff --name-status -z`: the status letter and the path(s). */
export interface NameStatusEntry {
  /** The first letter of git's status code: A, M, D, R, C, T, U, ... */
  code: string;
  /** The (new) path. */
  path: string;
  /** The old path of a rename or copy. */
  oldPath?: string;
}

/**
 * Parse `git diff --name-status -z` output. Fields are NUL-separated: a
 * status code then the path, and for a rename or copy (`R100`, `C75`) the
 * old path and then the new one.
 */
export function parseNameStatus(raw: string): NameStatusEntry[] {
  const entries: NameStatusEntry[] = [];
  const fields = raw.split('\0');
  for (let i = 0; i < fields.length; i++) {
    const status = fields[i];
    if (status === '') continue;
    const code = status[0];
    if (code === 'R' || code === 'C') {
      const oldPath = fields[i + 1];
      const path = fields[i + 2];
      if (oldPath !== undefined && path !== undefined) entries.push({ code, path, oldPath });
      i += 2;
    } else {
      const path = fields[i + 1];
      if (path !== undefined) entries.push({ code, path });
      i += 1;
    }
  }
  return entries;
}
