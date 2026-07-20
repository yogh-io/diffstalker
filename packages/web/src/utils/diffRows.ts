/**
 * Pure row model for the web DiffView: groups a DiffResult's lines into
 * file sections and hunks, pairs adjacent deletion/addition runs for
 * word-level diffs, and parses @@ headers into readable ranges.
 *
 * The pairing semantics mirror the CLI's displayRows builder
 * (packages/cli/src/utils/displayRows.ts): within a hunk, a run of
 * consecutive deletions followed by a run of consecutive additions is
 * paired by position; each pair that passes areSimilarEnough gets
 * word-level segments from computeWordDiff. Both come from
 * core/view/wordDiff — shared with the CLI, not reimplemented.
 *
 * Grouping into per-hunk sections (instead of a flat row list) is what
 * lets the view give each hunk a sticky header that the next hunk's
 * header pushes away, plus a hairline between hunks.
 */

import type { DiffResult, DiffLine } from '@diffstalker/core/git/diff';
import { isDisplayableDiffLine } from '@diffstalker/core/view/diffFilters';
import { getLineContent } from '@diffstalker/core/view/diffRowCalculations';
import { computeWordDiff, areSimilarEnough } from '@diffstalker/core/view/wordDiff';
import type { WordDiffSegment } from '@diffstalker/core/view/wordDiff';

export type { WordDiffSegment } from '@diffstalker/core/view/wordDiff';

export interface DiffContentRow {
  key: number;
  kind: 'add' | 'del' | 'context';
  oldLineNum?: number;
  newLineNum?: number;
  content: string;
  /** Word-level segments when this row is half of a similar del/add pair. */
  segments?: WordDiffSegment[];
}

export interface DiffHunkGroup {
  key: number;
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
  key: number;
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

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
const GIT_HEADER_RE = /^diff --git a\/.+ b\/(.+)$/;

/** Strip C0 control chars except tab (CSS tab-size renders tabs). */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

function cleanContent(line: DiffLine): string {
  return getLineContent(line).replace(CONTROL_CHARS_RE, '');
}

function parseHunkRanges(content: string): { oldRange: string; newRange: string; context: string } {
  const match = HUNK_HEADER_RE.exec(content);
  if (!match) return { oldRange: '', newRange: '', context: '' };
  const oldStart = parseInt(match[1], 10);
  const oldCount = match[2] !== undefined ? parseInt(match[2], 10) : 1;
  const newStart = parseInt(match[3], 10);
  const newCount = match[4] !== undefined ? parseInt(match[4], 10) : 1;
  const range = (start: number, count: number): string =>
    count === 1 ? `${start}` : `${start}-${start + count - 1}`;
  return {
    oldRange: range(oldStart, oldCount),
    newRange: range(newStart, newCount),
    context: match[5].trim(),
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
      const filePath = GIT_HEADER_RE.exec(line.content)?.[1] ?? null;
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

// --- Pass 2: content rows with word-diff pairing ---

interface RunSegments {
  del: Map<number, WordDiffSegment[]>;
  add: Map<number, WordDiffSegment[]>;
}

/**
 * Pair a run of consecutive deletions with the additions that follow it,
 * by position; similar pairs get word-diff segments (CLI semantics).
 */
function pairRuns(deletions: DiffLine[], additions: DiffLine[]): RunSegments {
  const segments: RunSegments = { del: new Map(), add: new Map() };
  const pairCount = Math.min(deletions.length, additions.length);
  for (let j = 0; j < pairCount; j++) {
    const delContent = cleanContent(deletions[j]);
    const addContent = cleanContent(additions[j]);
    if (areSimilarEnough(delContent, addContent)) {
      const { oldSegments, newSegments } = computeWordDiff(delContent, addContent);
      segments.del.set(j, oldSegments);
      segments.add.set(j, newSegments);
    }
  }
  return segments;
}

type NextKey = () => number;

function toContentRow(
  line: DiffLine,
  kind: DiffContentRow['kind'],
  key: number,
  segments?: WordDiffSegment[]
): DiffContentRow {
  return {
    key,
    kind,
    ...(line.oldLineNum !== undefined && kind !== 'add' && { oldLineNum: line.oldLineNum }),
    ...(line.newLineNum !== undefined && kind !== 'del' && { newLineNum: line.newLineNum }),
    content: cleanContent(line),
    ...(segments && { segments }),
  };
}

/** Convert one hunk's body lines into content rows, pairing change runs. */
function buildHunkRows(lines: DiffLine[], nextKey: NextKey): DiffContentRow[] {
  const rows: DiffContentRow[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].type === 'context') {
      rows.push(toContentRow(lines[i], 'context', nextKey()));
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

    const segments = pairRuns(deletions, additions);
    deletions.forEach((line, j) => {
      rows.push(toContentRow(line, 'del', nextKey(), segments.del.get(j)));
    });
    additions.forEach((line, j) => {
      rows.push(toContentRow(line, 'add', nextKey(), segments.add.get(j)));
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

function buildSection(raw: RawSection, nextKey: NextKey): DiffFileSection {
  const section: DiffFileSection = {
    key: nextKey(),
    filePath: raw.filePath,
    notes: raw.notes,
    hunks: [],
  };
  for (const rawHunk of raw.hunks) {
    section.hunks.push({
      key: nextKey(),
      ...parseHunkRanges(rawHunk.header.content),
      raw: rawHunk.header.content,
      editedAt: resolveEditedAt(rawHunk.header, rawHunk.lines),
      rows: buildHunkRows(rawHunk.lines, nextKey),
    });
  }
  return section;
}

export function buildDiffModel(diff: DiffResult | null): DiffModel {
  const model: DiffModel = { sections: [], lineNumWidth: 3, rowCount: 0, isBinary: false };
  if (!diff) return model;

  let key = 0;
  const nextKey: NextKey = () => key++;

  const grouped = groupSections(diff.lines.filter(isDisplayableDiffLine));
  model.isBinary = grouped.isBinary;
  model.sections = grouped.sections.map((raw) => buildSection(raw, nextKey));

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

  model.lineNumWidth = Math.max(3, String(maxLineNumber(model.sections)).length);
  return model;
}
