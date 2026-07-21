/**
 * Pure row model for the web DiffView: groups a DiffResult's lines into
 * file sections and hunks, pairs adjacent deletion/addition runs for
 * word-level diffs, and parses @@ headers into readable ranges.
 *
 * The pairing semantics match the CLI's displayRows builder
 * (packages/cli/src/utils/displayRows.ts): within a hunk, a run of
 * consecutive deletions followed by a run of consecutive additions is
 * paired by position; similar pairs get word-level segments. The
 * pairing is shared code — pairChangeRuns from
 * core/view/diffPrimitives — not reimplemented.
 *
 * Grouping into per-hunk sections (instead of a flat row list) is what
 * lets the view give each hunk a sticky header that the next hunk's
 * header pushes away, plus a hairline between hunks.
 *
 * Keys are CONTENT-STABLE (docs/web-diff-stream-architecture.md, section
 * 2): a rebuild from the same content yields the same keys, so Vue
 * patches in place instead of tearing the DOM down. Section key comes
 * from staged-ness + path, hunk key from a hash of (section key, header
 * context, oldStart) with ordinal disambiguation, row key from the
 * hunk key + the row's line number.
 */

import type { DiffResult, DiffLine } from '@diffstalker/core/git/diff';
import { isDisplayableDiffLine } from '@diffstalker/core/view/diffFilters';
import { getLineContent } from '@diffstalker/core/view/diffRowCalculations';
import {
  extractDiffFilePath,
  getLineNumColumnWidth,
  pairChangeRuns,
  parseHunkHeader,
} from '@diffstalker/core/view/diffPrimitives';
import type { WordDiffSegment } from '@diffstalker/core/view/wordDiff';

export type { WordDiffSegment } from '@diffstalker/core/view/wordDiff';

export interface DiffContentRow {
  /** Content-stable: `${hunkKey}:${oldLineNum ?? '+' + newLineNum}`. */
  key: string;
  kind: 'add' | 'del' | 'context';
  oldLineNum?: number;
  newLineNum?: number;
  content: string;
  /** Word-level segments when this row is half of a similar del/add pair. */
  segments?: WordDiffSegment[];
}

export interface DiffHunkGroup {
  /**
   * Content-stable: section key + a hash of the @@ header's context and
   * oldStart, with an ordinal suffix when two hunks in a file collide.
   */
  key: string;
  /**
   * 0-based ordinal of this hunk across the WHOLE diff (all file
   * sections, raw order) — exactly the index extractHunkPatch(raw, i)
   * expects. Valid because grouping never drops @@ lines: the
   * isDisplayableDiffLine filter only removes header lines.
   */
  index: number;
  /** Pretty old-side range ("10-20") parsed from the @@ header. */
  oldRange: string;
  /** Pretty new-side range ("15-25"). */
  newRange: string;
  /** Trailing @@ context (usually the enclosing function). */
  context: string;
  /** The raw @@ line, kept as a fallback for unparseable headers. */
  raw: string;
  /** When this hunk's content was last observed to change (epoch ms). */
  editedAt?: number;
  rows: DiffContentRow[];
}

export interface DiffFileSection {
  /** Content-stable: `${staged ? 's' : 'u'}:${filePath}`. */
  key: string;
  /** Path from the diff --git header; null for a headerless fragment. */
  filePath: string | null;
  /** Informational headers (new file mode, rename from/to, Binary files…). */
  notes: string[];
  hunks: DiffHunkGroup[];
}

export interface DiffModel {
  sections: DiffFileSection[];
  /** ch width of each line-number gutter (digits of the max line number, min 3). */
  lineNumWidth: number;
  /** Total add/del/context rows across all hunks. */
  rowCount: number;
  /** True when a "Binary files … differ" header is present. */
  isBinary: boolean;
  /** Latest editedAt across hunks; drives the relative-time ticker. */
  latestEditedAt?: number;
}

/** Strip C0 control chars except tab (CSS tab-size renders tabs). */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

function cleanContent(line: DiffLine): string {
  return getLineContent(line).replace(CONTROL_CHARS_RE, '');
}

function parseHunkRanges(content: string): { oldRange: string; newRange: string; context: string } {
  const header = parseHunkHeader(content);
  if (!header) return { oldRange: '', newRange: '', context: '' };
  const range = (start: number, count: number): string =>
    count === 1 ? `${start}` : `${start}-${start + count - 1}`;
  return {
    oldRange: range(header.oldStart, header.oldCount),
    newRange: range(header.newStart, header.newCount),
    context: header.context,
  };
}

// --- Pass 1: group displayable lines into raw sections and hunks ---

interface RawHunk {
  header: DiffLine;
  lines: DiffLine[];
}

interface RawSection {
  filePath: string | null;
  notes: string[];
  hunks: RawHunk[];
}

function groupSections(lines: DiffLine[]): { sections: RawSection[]; isBinary: boolean } {
  const sections: RawSection[] = [];
  let isBinary = false;
  let section: RawSection | null = null;
  let hunk: RawHunk | null = null;

  const ensureSection = (): RawSection => {
    if (!section) {
      section = { filePath: null, notes: [], hunks: [] };
      sections.push(section);
    }
    return section;
  };

  for (const line of lines) {
    if (line.type === 'header') {
      hunk = null;
      const filePath = extractDiffFilePath(line.content);
      if (filePath !== null) {
        section = { filePath, notes: [], hunks: [] };
        sections.push(section);
      } else {
        ensureSection().notes.push(line.content);
        if (line.content.startsWith('Binary files')) isBinary = true;
      }
    } else if (line.type === 'hunk') {
      hunk = { header: line, lines: [] };
      ensureSection().hunks.push(hunk);
    } else if (hunk) {
      // Content line: belongs to the open hunk (lines before any @@ are
      // not valid unified-diff content; ignore them rather than misfile).
      hunk.lines.push(line);
    }
  }
  return { sections, isBinary };
}

// --- Content-stable keys ---

/** FNV-1a 32-bit hash, base36 — short, deterministic, dependency-free. */
function hashKey(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/** `${staged ? 's' : 'u'}:${filePath}` (empty path for headerless fragments). */
function sectionKeyFor(staged: boolean, filePath: string | null): string {
  return `${staged ? 's' : 'u'}:${filePath ?? ''}`;
}

/**
 * Hunk key: hash of (section key, @@ context, oldStart). Two hunks in a
 * file can legitimately collide on that (same enclosing function, same
 * oldStart after an unparseable header); the caller disambiguates with
 * an ordinal suffix via `seen`.
 */
function hunkKeyFor(sectionKey: string, headerContent: string, seen: Map<string, number>): string {
  const header = parseHunkHeader(headerContent);
  const identity = header ? `${header.context} ${header.oldStart}` : headerContent;
  const hash = hashKey(`${sectionKey} ${identity}`);
  let key = `${sectionKey}#${hash}`;
  const count = seen.get(key) ?? 0;
  seen.set(key, count + 1);
  if (count > 0) key = `${key}~${count}`;
  return key;
}

/** `${hunkKey}:${oldLineNum ?? '+' + newLineNum}` — old side wins for context/del rows. */
function rowKeyFor(hunkKey: string, row: Omit<DiffContentRow, 'key'>, ordinal: number): string {
  if (row.oldLineNum !== undefined) return `${hunkKey}:${row.oldLineNum}`;
  if (row.newLineNum !== undefined) return `${hunkKey}:+${row.newLineNum}`;
  return `${hunkKey}:r${ordinal}`; // Defensive: content lines always carry a line number.
}

// --- Pass 2: content rows with word-diff pairing ---

function toContentRow(
  line: DiffLine,
  kind: DiffContentRow['kind'],
  hunkKey: string,
  ordinal: number,
  segments?: WordDiffSegment[]
): DiffContentRow {
  const row: Omit<DiffContentRow, 'key'> = {
    kind,
    ...(line.oldLineNum !== undefined && kind !== 'add' && { oldLineNum: line.oldLineNum }),
    ...(line.newLineNum !== undefined && kind !== 'del' && { newLineNum: line.newLineNum }),
    content: cleanContent(line),
    ...(segments && { segments }),
  };
  return { key: rowKeyFor(hunkKey, row, ordinal), ...row };
}

/** Convert one hunk's body lines into content rows, pairing change runs. */
function buildHunkRows(lines: DiffLine[], hunkKey: string): DiffContentRow[] {
  const rows: DiffContentRow[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].type === 'context') {
      rows.push(toContentRow(lines[i], 'context', hunkKey, rows.length));
      i++;
      continue;
    }

    // A change run: consecutive deletions, then consecutive additions.
    const deletions: DiffLine[] = [];
    while (i < lines.length && lines[i].type === 'deletion') deletions.push(lines[i++]);
    const additions: DiffLine[] = [];
    while (i < lines.length && lines[i].type === 'addition') additions.push(lines[i++]);
    if (deletions.length === 0 && additions.length === 0) {
      // Not a content line (defensive; hunk bodies only hold content lines).
      i++;
      continue;
    }

    const segments = pairChangeRuns(deletions, additions, cleanContent);
    deletions.forEach((line, j) => {
      rows.push(toContentRow(line, 'del', hunkKey, rows.length, segments.delSegments.get(j)));
    });
    additions.forEach((line, j) => {
      rows.push(toContentRow(line, 'add', hunkKey, rows.length, segments.addSegments.get(j)));
    });
  }
  return rows;
}

/** The hunk's own stamp, or the freshest of its lines. */
function resolveEditedAt(header: DiffLine, lines: DiffLine[]): number | undefined {
  let editedAt = header.editedAt;
  for (const line of lines) {
    if (line.editedAt !== undefined && (editedAt === undefined || line.editedAt > editedAt)) {
      editedAt = line.editedAt;
    }
  }
  return editedAt;
}

function maxLineNumber(sections: DiffFileSection[]): number {
  let max = 0;
  for (const section of sections) {
    for (const hunk of section.hunks) {
      for (const row of hunk.rows) {
        max = Math.max(max, row.oldLineNum ?? 0, row.newLineNum ?? 0);
      }
    }
  }
  return max;
}

function buildSection(
  raw: RawSection,
  staged: boolean,
  nextHunkIndex: () => number
): DiffFileSection {
  const sectionKey = sectionKeyFor(staged, raw.filePath);
  const section: DiffFileSection = {
    key: sectionKey,
    filePath: raw.filePath,
    notes: raw.notes,
    hunks: [],
  };
  const seenHunkKeys = new Map<string, number>();
  for (const rawHunk of raw.hunks) {
    const hunkKey = hunkKeyFor(sectionKey, rawHunk.header.content, seenHunkKeys);
    section.hunks.push({
      key: hunkKey,
      index: nextHunkIndex(),
      ...parseHunkRanges(rawHunk.header.content),
      raw: rawHunk.header.content,
      editedAt: resolveEditedAt(rawHunk.header, rawHunk.lines),
      rows: buildHunkRows(rawHunk.lines, hunkKey),
    });
  }
  return section;
}

/**
 * `staged` feeds the section keys (`s:` vs `u:` prefix) so the same
 * path staged AND unstaged yields two distinct sections. Callers where
 * staged-ness has no meaning (History, Compare) omit it.
 */
export function buildDiffModel(diff: DiffResult | null, staged = false): DiffModel {
  const model: DiffModel = { sections: [], lineNumWidth: 3, rowCount: 0, isBinary: false };
  if (!diff) return model;

  let hunkIndex = 0;
  const nextHunkIndex = (): number => hunkIndex++;

  const grouped = groupSections(diff.lines.filter(isDisplayableDiffLine));
  model.isBinary = grouped.isBinary;
  model.sections = grouped.sections.map((raw) => buildSection(raw, staged, nextHunkIndex));

  for (const section of model.sections) {
    for (const hunk of section.hunks) {
      model.rowCount += hunk.rows.length;
      if (
        hunk.editedAt !== undefined &&
        (model.latestEditedAt === undefined || hunk.editedAt > model.latestEditedAt)
      ) {
        model.latestEditedAt = hunk.editedAt;
      }
    }
  }

  model.lineNumWidth = getLineNumColumnWidth(maxLineNumber(model.sections));
  return model;
}
