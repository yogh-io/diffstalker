/**
 * Journal classifier + manager table tests.
 *
 * The pure functions (extractRuns, extractFileHunks, classifyFileHunks,
 * rebaselineFile) are fed hand-written unified-diff fixtures — no real
 * git involved. The manager tests drive JournalManager.observe with
 * synthetic JournalObservations and assert the appended entries.
 */

import { describe, test, expect } from 'bun:test';
import { rawFromLines } from '../git/diffParse.js';
import { parseDiffWithLineNumbers } from '../git/diffParse.js';
import type { DiffLine, DiffResult } from '../git/diffParse.js';
import { hashHunkBody } from '../git/hunkTimes.js';
import type { FileStatus, GitStatus } from '../git/status.js';
import { OVERSIZE_UNTRACKED_MARKER } from '../types/journal.js';
import type {
  JournalBoundaryEntry,
  JournalEntry,
  JournalHunkEntry,
  JournalObservation,
  JournalStore,
  ObservedHunk,
} from '../types/journal.js';
import {
  JournalManager,
  classifyFileHunks,
  createJournalStore,
  extractFileHunks,
  extractRuns,
  rebaselineFile,
  spanOfRuns,
  MAX_JOURNAL_ENTRIES,
  MAX_JOURNAL_SNAPSHOT_BYTES,
  PSEUDO_RUN_HI,
} from './JournalManager.js';

// --- Fixture helpers -------------------------------------------------------

function bodyLines(lines: string[]): DiffLine[] {
  return lines.map((content) => {
    if (content.startsWith('+')) return { type: 'addition' as const, content };
    if (content.startsWith('-')) return { type: 'deletion' as const, content };
    return { type: 'context' as const, content };
  });
}

interface HunkFixture {
  header: string;
  body: string[];
}

/** A full "diff --git" section for one file, trailing newline included. */
function fileSection(path: string, hunks: HunkFixture[], extraHeaders: string[] = []): string {
  const lines = [
    `diff --git a/${path} b/${path}`,
    ...extraHeaders,
    `index 1111111..2222222 100644`,
    `--- a/${path}`,
    `+++ b/${path}`,
  ];
  for (const hunk of hunks) {
    lines.push(hunk.header, ...hunk.body);
  }
  return lines.join('\n') + '\n';
}

function toDiff(raw: string): DiffResult {
  return { raw, lines: parseDiffWithLineNumbers(raw) };
}

/** Parse a single-file raw section into ObservedHunks. */
function observedHunks(raw: string): ObservedHunk[] {
  return extractFileHunks(toDiff(raw)).hunks;
}

function mkStatus(files: { path: string; status: FileStatus }[], branch = 'main'): GitStatus {
  return {
    files: files.map((f) => ({ path: f.path, status: f.status, staged: false })),
    branch: { current: branch, ahead: 0, behind: 0 },
    isRepo: true,
  };
}

interface ObsSpec {
  diff?: string;
  files?: { path: string; status: FileStatus }[];
  branch?: string;
  headOid?: string;
  stashCount?: number;
  op?: JournalObservation['operationInProgress'];
  mtimes?: Record<string, number>;
  at?: number;
}

function mkObs(spec: ObsSpec = {}): JournalObservation {
  const raw = spec.diff ?? '';
  return {
    status: mkStatus(spec.files ?? [], spec.branch ?? 'main'),
    headDiff: toDiff(raw),
    headOid: spec.headOid ?? 'oid-1',
    stashCount: spec.stashCount ?? 0,
    operationInProgress: spec.op ?? null,
    mtimes: spec.mtimes ? new Map(Object.entries(spec.mtimes)) : new Map(),
    at: spec.at ?? 10_000,
  };
}

function hunkEntries(entries: readonly JournalEntry[]): JournalHunkEntry[] {
  return entries.filter((e): e is JournalHunkEntry => e.type === 'hunk');
}

function boundaries(entries: readonly JournalEntry[]): JournalBoundaryEntry[] {
  return entries.filter((e): e is JournalBoundaryEntry => e.type === 'boundary');
}

/** A manager over a fresh store, with every append batch captured. */
function mkManager(): { manager: JournalManager; batches: JournalEntry[][] } {
  const manager = new JournalManager(createJournalStore());
  const batches: JournalEntry[][] = [];
  manager.on('append', (batch) => batches.push(batch));
  return { manager, batches };
}

// --- Run extraction --------------------------------------------------------

describe('extractRuns', () => {
  test('top-of-file insertion (-0,0) anchors at A=0 -> [0,2]', () => {
    expect(extractRuns(bodyLines(['+a', '+b']), '@@ -0,0 +1,2 @@')).toEqual([[0, 2]]);
  });

  test('pure insertion after line N (-N,0) -> [2N, 2N+2]', () => {
    expect(extractRuns(bodyLines(['+x', '+y']), '@@ -5,0 +6,2 @@')).toEqual([[10, 12]]);
  });

  test('deletion of lines d1..d2 -> [2*d1, 2*d2]', () => {
    expect(extractRuns(bodyLines(['-x', '-y']), '@@ -3,2 +2,0 @@')).toEqual([[6, 8]]);
  });

  test('a mixed del+add group is one run with the deletion footprint', () => {
    expect(extractRuns(bodyLines(['-x', '-y', '+p', '+q']), '@@ -3,2 +3,2 @@')).toEqual([[6, 8]]);
  });

  test('a context-merged hunk yields the SET of runs, not their hull', () => {
    const body = bodyLines([' c1', '-b', '+B', ' c3', ' c4', ' c5', '-f', '+F', ' c7']);
    expect(extractRuns(body, '@@ -1,7 +1,7 @@')).toEqual([
      [4, 4],
      [12, 12],
    ]);
  });

  test('skips "\\ No newline" lines without drifting the old counter', () => {
    const body = bodyLines([
      ' a',
      ' b',
      '-c',
      '\\ No newline at end of file',
      '+c2',
      '\\ No newline at end of file',
    ]);
    // Deletion is HEAD line 3; the backslash lines must consume nothing.
    expect(extractRuns(body, '@@ -1,3 +1,3 @@')).toEqual([[6, 6]]);
  });

  test('re-derives counts from a count-omitted header (@@ -3 +3 @@)', () => {
    expect(extractRuns(bodyLines(['-x', '+y']), '@@ -3 +3 @@')).toEqual([[6, 6]]);
  });

  test('EOF trailing insertion after the last context line', () => {
    const body = bodyLines([' l8', ' l9', ' l10', '+tail']);
    expect(extractRuns(body, '@@ -8,3 +8,4 @@')).toEqual([[20, 22]]);
  });

  test('classifies by RAW FIRST CHAR, never DiffLine.type: ---/+++ shaped body lines', () => {
    // A deleted "--x" comment (raw "---x") and an added "++y" (raw
    // "+++y") are typed 'header' by parseDiffWithLineNumbers; a context
    // line keeps its leading space. The run accounting must be immune.
    const parsed = parseDiffWithLineNumbers(
      ['@@ -1,3 +1,3 @@', ' a', '---x', '+++y', ' -dashed ctx', ''].join('\n')
    );
    const body = parsed.slice(1);
    // The trap this guards against: the parser mistypes both mid-body.
    expect(body.map((l) => l.type)).toEqual(['context', 'header', 'header', 'context']);
    // Deletion of HEAD line 2 only; the context lines consume 1 and 3.
    expect(extractRuns(body, '@@ -1,3 +1,3 @@')).toEqual([[4, 4]]);
  });
});

describe('extractFileHunks', () => {
  test('mode-only section yields one pseudo-hunk over the whole old axis', () => {
    const raw = ['diff --git a/run.sh b/run.sh', 'old mode 100644', 'new mode 100755', ''].join(
      '\n'
    );
    const { hunks } = extractFileHunks(toDiff(raw));
    expect(hunks).toHaveLength(1);
    expect(hunks[0].runs).toEqual([[0, PSEUDO_RUN_HI]]);
    expect(hunks[0].span).toEqual({ start: 0, count: 0 });
  });

  test('bodyHash covers +/- lines only, excluding "\\ No newline" markers', () => {
    const raw = fileSection('f.txt', [
      {
        header: '@@ -1,3 +1,3 @@',
        body: [' a', ' b', '-c', '\\ No newline at end of file', '+c2'],
      },
    ]);
    const { hunks } = extractFileHunks(toDiff(raw));
    expect(hunks[0].bodyHash).toBe(hashHunkBody(['-c', '+c2']));
    expect(hunks[0].ins).toBe(1);
    expect(hunks[0].del).toBe(1);
  });

  test('per-hunk snapshot diff carries the file headers and the ONE @@ section', () => {
    const raw = fileSection('f.txt', [
      { header: '@@ -2 +2 @@', body: ['-x', '+y'] },
      { header: '@@ -9 +9 @@', body: ['-p', '+q'] },
    ]);
    const { hunks } = extractFileHunks(toDiff(raw));
    expect(hunks).toHaveLength(2);
    const first = hunks[0].diff!;
    expect(first.lines.filter((l) => l.type === 'hunk')).toHaveLength(1);
    expect(rawFromLines(first.lines)).toContain('diff --git a/f.txt b/f.txt');
    expect(rawFromLines(first.lines)).toContain('@@ -2 +2 @@');
    expect(rawFromLines(first.lines)).not.toContain('@@ -9 +9 @@');
  });

  test('ins/del/bodyHash classify body lines by raw first char, not DiffLine.type', () => {
    // Deleted "--comment" (raw "---comment") and added "++x" (raw
    // "+++x") parse as 'header'; " -dashed context" stays context via
    // its space prefix. Footprints, counts, and hash must all be right.
    const raw = fileSection('q.sql', [
      { header: '@@ -1,3 +1,3 @@', body: [' before', '---comment', '+++x', ' -dashed context'] },
    ]);
    const { hunks, hunkless } = extractFileHunks(toDiff(raw));
    expect(hunkless).toBe(false);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].runs).toEqual([[4, 4]]); // deletion of HEAD line 2 only
    expect(hunks[0].ins).toBe(1);
    expect(hunks[0].del).toBe(1);
    expect(hunks[0].bodyHash).toBe(hashHunkBody(['---comment', '+++x']));
  });

  test('detects a git-reported rename', () => {
    const raw = [
      'diff --git a/old.ts b/new.ts',
      'similarity index 95%',
      'rename from old.ts',
      'rename to new.ts',
      '--- a/old.ts',
      '+++ b/new.ts',
      '@@ -2 +2 @@',
      '-x',
      '+y',
      '',
    ].join('\n');
    const parsed = extractFileHunks(toDiff(raw));
    expect(parsed.renamedFrom).toBe('old.ts');
    expect(parsed.hunks).toHaveLength(1);
  });
});

describe('spanOfRuns', () => {
  test('deletion run maps back to its old lines', () => {
    expect(spanOfRuns([[6, 8]])).toEqual({ start: 3, count: 2 });
  });

  test('insertion run touches both neighboring lines', () => {
    expect(spanOfRuns([[10, 12]])).toEqual({ start: 5, count: 2 });
  });
});

// --- The pure classifier ---------------------------------------------------

const H = (header: string, body: string[]): HunkFixture => ({ header, body });

describe('classifyFileHunks', () => {
  test('0 prev, 1 next -> created with empty supersedes', () => {
    const next = observedHunks(fileSection('f.txt', [H('@@ -4,0 +5,1 @@', ['+X'])]));
    const { entries, nextLive } = classifyFileHunks([], next, 10);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ seq: 10, kind: 'created', supersedes: [], siblings: 1 });
    expect(nextLive).toHaveLength(1);
    expect(nextLive[0].seq).toBe(10);
  });

  test('1 prev, 0 next -> reverted tombstone with null diff', () => {
    const first = observedHunks(fileSection('f.txt', [H('@@ -4,0 +5,1 @@', ['+X'])]));
    const { nextLive: prev } = classifyFileHunks([], first, 10);
    const { entries, nextLive } = classifyFileHunks(prev, [], 11);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ seq: 11, kind: 'reverted', diff: null, supersedes: [10] });
    expect(nextLive).toHaveLength(0);
  });

  test('1<->1 same bodyHash is SILENT: seq carried, runs recomputed', () => {
    const first = observedHunks(
      fileSection('f.txt', [H('@@ -5,2 +5,2 @@', ['-x', '-y', '+a', '+b'])])
    );
    const { nextLive: prev } = classifyFileHunks([], first, 7);
    // Same old side, new side shifted by an edit above (only +newStart moves).
    const shifted = observedHunks(
      fileSection('f.txt', [H('@@ -5,2 +9,2 @@', ['-x', '-y', '+a', '+b'])])
    );
    const { entries, nextLive } = classifyFileHunks(prev, shifted, 8);
    expect(entries).toHaveLength(0);
    expect(nextLive).toHaveLength(1);
    expect(nextLive[0].seq).toBe(7);
    expect(nextLive[0].runs).toEqual(shifted[0].runs);
  });

  test('1<->1 hash differs -> expanded / shrunk / edited by size', () => {
    const base = observedHunks(fileSection('f.txt', [H('@@ -5,1 +5,1 @@', ['-x', '+a'])]));
    const { nextLive: prev } = classifyFileHunks([], base, 1); // size 2

    const bigger = observedHunks(fileSection('f.txt', [H('@@ -5,1 +5,2 @@', ['-x', '+a', '+b'])]));
    expect(classifyFileHunks(prev, bigger, 2).entries[0].kind).toBe('expanded');

    const edited = observedHunks(fileSection('f.txt', [H('@@ -5,1 +5,1 @@', ['-x', '+b'])]));
    const editedResult = classifyFileHunks(prev, edited, 2);
    expect(editedResult.entries[0].kind).toBe('edited');
    expect(editedResult.entries[0].supersedes).toEqual([1]);

    const three = observedHunks(fileSection('f.txt', [H('@@ -5,2 +5,1 @@', ['-x', '-y', '+a'])]));
    const { nextLive: prev3 } = classifyFileHunks([], three, 1); // size 3
    const smaller = observedHunks(fileSection('f.txt', [H('@@ -5,1 +5,1 @@', ['-x', '+a'])]));
    expect(classifyFileHunks(prev3, smaller, 2).entries[0].kind).toBe('shrunk');
  });

  test('a pure deletion never badges expanded: bigger gross churn still reads shrunk', () => {
    // Predecessor: a one-line insertion after HEAD line 4 (size 1).
    const ins = observedHunks(fileSection('f.txt', [H('@@ -4,0 +5,1 @@', ['+X'])]));
    const r1 = classifyFileHunks([], ins, 1);
    expect(r1.entries[0].kind).toBe('created');

    // The insertion goes away and HEAD lines 4-6 are deleted: ins 0,
    // del 3 — gross churn 3 > 1, but it is a pure deletion and must
    // read 'shrunk', never 'expanded'.
    const pureDel = observedHunks(
      fileSection('f.txt', [H('@@ -4,3 +4,0 @@', ['-l4', '-l5', '-l6'])])
    );
    const r2 = classifyFileHunks(r1.nextLive, pureDel, 2);
    expect(r2.entries).toHaveLength(1);
    expect(r2.entries[0].kind).toBe('shrunk');
    expect(r2.entries[0].supersedes).toEqual([1]);
    expect(r2.entries[0].stats).toEqual({ insertions: 0, deletions: 3 });
  });

  test('1 -> N split: each child supersedes the parent, siblings N', () => {
    const merged = observedHunks(
      fileSection('f.txt', [
        H('@@ -1,7 +1,7 @@', [' c1', '-b', '+B', ' c3', ' c4', ' c5', '-f', '+F', ' c7']),
      ])
    );
    const { nextLive: prev } = classifyFileHunks([], merged, 5);
    expect(prev).toHaveLength(1);

    const split = observedHunks(
      fileSection('f.txt', [H('@@ -2 +2 @@', ['-b', '+B2']), H('@@ -6 +6 @@', ['-f', '+F2'])])
    );
    const { entries, nextLive } = classifyFileHunks(prev, split, 6);
    expect(entries).toHaveLength(2);
    for (const e of entries) {
      expect(e.supersedes).toEqual([5]);
      expect(e.siblings).toBe(2);
    }
    expect(entries.map((e) => e.seq)).toEqual([6, 7]);
    expect(nextLive.map((l) => l.seq)).toEqual([6, 7]);
  });

  test('N -> 1 merge: one entry supersedes all parents', () => {
    const two = observedHunks(
      fileSection('f.txt', [H('@@ -2 +2 @@', ['-b', '+B']), H('@@ -6 +6 @@', ['-f', '+F'])])
    );
    const { nextLive: prev } = classifyFileHunks([], two, 1);
    expect(prev.map((l) => l.seq)).toEqual([1, 2]);

    const merged = observedHunks(
      fileSection('f.txt', [H('@@ -2,5 +2,1 @@', ['-b', '-c', '-d', '-e', '-f', '+ALL'])])
    );
    const { entries } = classifyFileHunks(prev, merged, 3);
    expect(entries).toHaveLength(1);
    expect(entries[0].supersedes).toEqual([1, 2]);
    expect(entries[0].siblings).toBe(1);
  });

  test('N <-> M: every next supersedes all prev in the component', () => {
    const prevHunks = observedHunks(
      fileSection('f.txt', [
        H('@@ -2,3 +2,3 @@', ['-a', '-b', '-c', '+A', '+B', '+C']),
        H('@@ -6,3 +6,3 @@', ['-p', '-q', '-r', '+P', '+Q', '+R']),
      ])
    );
    const { nextLive: prev } = classifyFileHunks([], prevHunks, 1);

    // One next hunk bridges both prevs; a second overlaps the tail only.
    const next = observedHunks(
      fileSection('f.txt', [
        H('@@ -3,4 +3,4 @@', ['-b', '-c', '-p', '-q', '+X']),
        H('@@ -8,1 +8,1 @@', ['-r', '+Y']),
      ])
    );
    const { entries } = classifyFileHunks(prev, next, 3);
    expect(entries).toHaveLength(2);
    for (const e of entries) {
      expect(e.supersedes).toEqual([1, 2]);
      expect(e.siblings).toBe(2);
    }
  });

  test("the judge's mixed-hunk sequence: created -> expanded -> shrunk, never tombstone+create", () => {
    // Step 1: insert X after HEAD line 4.
    const step1 = observedHunks(fileSection('f.txt', [H('@@ -4,0 +5,1 @@', ['+X'])]));
    const r1 = classifyFileHunks([], step1, 1);
    expect(r1.entries.map((e) => e.kind)).toEqual(['created']);

    // Step 2: also delete HEAD line 5 — git context-merges into ONE hunk
    // whose deletions-only span must not shadow the still-alive insertion.
    const step2 = observedHunks(
      fileSection('f.txt', [
        H('@@ -2,7 +2,7 @@', [' l2', ' l3', ' l4', '+X', '-l5', ' l6', ' l7', ' l8']),
      ])
    );
    const r2 = classifyFileHunks(r1.nextLive, step2, 2);
    expect(r2.entries).toHaveLength(1);
    expect(r2.entries[0].kind).toBe('expanded');
    expect(r2.entries[0].supersedes).toEqual([1]);

    // Step 3: revert the delete — back to the pure insertion.
    const step3 = observedHunks(fileSection('f.txt', [H('@@ -4,0 +5,1 @@', ['+X'])]));
    const r3 = classifyFileHunks(r2.nextLive, step3, 3);
    expect(r3.entries).toHaveLength(1);
    expect(r3.entries[0].kind).toBe('shrunk');
    expect(r3.entries[0].supersedes).toEqual([2]);
  });

  test('revert one of three: one tombstone, the siblings stay SILENT', () => {
    const three = observedHunks(
      fileSection('f.txt', [
        H('@@ -2 +2 @@', ['-a', '+A']),
        H('@@ -10 +10 @@', ['-b', '+B']),
        H('@@ -20 +20 @@', ['-c', '+C']),
      ])
    );
    const { nextLive: prev } = classifyFileHunks([], three, 1);

    const twoLeft = observedHunks(
      fileSection('f.txt', [H('@@ -2 +2 @@', ['-a', '+A']), H('@@ -20 +20 @@', ['-c', '+C'])])
    );
    const { entries, nextLive } = classifyFileHunks(prev, twoLeft, 4);
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe('reverted');
    expect(entries[0].supersedes).toEqual([2]);
    expect(nextLive.map((l) => l.seq)).toEqual([1, 3]); // carried, no re-append
  });

  test('the footprint is a SET of intervals, not their hull: a gap edit never matches', () => {
    // One context-merged hunk with edits at old lines 2 and 6 -> runs
    // [[4,4],[12,12]]. Both edits revert while a NEW edit lands only in
    // the untouched gap (old line 4). A hull [4,12] would false-match it
    // as a revision; the set must yield reverted + created instead.
    const merged = observedHunks(
      fileSection('f.txt', [
        H('@@ -1,7 +1,7 @@', [' c1', '-b', '+B', ' c3', ' c4', ' c5', '-f', '+F', ' c7']),
      ])
    );
    const { nextLive: prev } = classifyFileHunks([], merged, 5);
    expect(prev[0].runs).toEqual([
      [4, 4],
      [12, 12],
    ]);

    const gap = observedHunks(fileSection('f.txt', [H('@@ -4,1 +4,1 @@', ['-c4', '+C4'])]));
    expect(gap[0].runs).toEqual([[8, 8]]);

    const { entries, nextLive } = classifyFileHunks(prev, gap, 6);
    expect(entries).toHaveLength(2);
    const reverted = entries.find((e) => e.kind === 'reverted')!;
    const created = entries.find((e) => e.kind === 'created')!;
    expect(reverted.supersedes).toEqual([5]);
    expect(reverted.diff).toBeNull();
    expect(created.supersedes).toEqual([]);
    expect(created.siblings).toBe(1);
    expect(nextLive).toHaveLength(1);
    expect(nextLive[0].seq).toBe(created.seq);
  });

  test('silence under above-hunk line shifts (old side untouched)', () => {
    const below = observedHunks(fileSection('f.txt', [H('@@ -50,1 +50,1 @@', ['-m', '+M'])]));
    const { nextLive: prev } = classifyFileHunks([], below, 1);

    // An insertion far above shifted the new side by 5; old side identical.
    const shifted = observedHunks(fileSection('f.txt', [H('@@ -50,1 +55,1 @@', ['-m', '+M'])]));
    const { entries, nextLive } = classifyFileHunks(prev, shifted, 2);
    expect(entries).toHaveLength(0);
    expect(nextLive[0].seq).toBe(1);
  });
});

describe('rebaselineFile', () => {
  test('carries seqs by bodyHash, not footprints (coordinates may jump)', () => {
    const oldHunks = observedHunks(fileSection('f.txt', [H('@@ -100,1 +100,1 @@', ['-m', '+M'])]));
    const { nextLive: old } = classifyFileHunks([], oldHunks, 3);
    // After the commit above it, the same hunk sits at old line 5.
    const next = observedHunks(fileSection('f.txt', [H('@@ -5,1 +5,1 @@', ['-m', '+M'])]));
    const { carried, retired } = rebaselineFile(old, next);
    expect(carried).toHaveLength(1);
    expect(carried[0].seq).toBe(3);
    expect(carried[0].runs).toEqual(next[0].runs);
    expect(retired).toEqual([]);
  });

  test('retires seqs of hunks the boundary consumed', () => {
    const oldHunks = observedHunks(
      fileSection('f.txt', [H('@@ -2 +2 @@', ['-a', '+A']), H('@@ -10 +10 @@', ['-b', '+B'])])
    );
    const { nextLive: old } = classifyFileHunks([], oldHunks, 1);
    // Hunk A was committed; only B remains (shifted, same body).
    const next = observedHunks(fileSection('f.txt', [H('@@ -9 +9 @@', ['-b', '+B'])]));
    const { carried, retired } = rebaselineFile(old, next);
    expect(carried.map((l) => l.seq)).toEqual([2]);
    expect(retired).toEqual([1]);
  });
});

// --- The manager -----------------------------------------------------------

const A_SECTION = fileSection('a.ts', [H('@@ -2,1 +2,1 @@', ['-old a', '+new a'])]);
const B_SECTION = fileSection('b.ts', [H('@@ -7,1 +7,1 @@', ['-old b', '+new b'])]);

describe('JournalManager', () => {
  test('seeding: journal-start boundary, then one seeded entry per hunk in mtime order', () => {
    const { manager, batches } = mkManager();
    manager.observe(
      mkObs({
        diff: A_SECTION + B_SECTION,
        files: [
          { path: 'a.ts', status: 'modified' },
          { path: 'b.ts', status: 'modified' },
        ],
        mtimes: { 'a.ts': 2000, 'b.ts': 1000 },
        at: 5000,
      })
    );

    expect(batches).toHaveLength(1);
    const batch = batches[0];
    expect(batch[0]).toMatchObject({ type: 'boundary', kind: 'journal-start', seq: 1 });
    const hunks = hunkEntries(batch);
    expect(hunks.map((h) => h.path)).toEqual(['b.ts', 'a.ts']); // mtime order
    expect(hunks.every((h) => h.seeded)).toBe(true);
    expect(hunks.every((h) => h.kind === 'created')).toBe(true);
    expect(hunks.map((h) => h.ts)).toEqual([1000, 2000]); // min(mtime, at)
    expect(manager.journalStore.entries).toEqual(batch);
  });

  test('an unchanged observation is silent', () => {
    const { manager, batches } = mkManager();
    const obs = () => mkObs({ diff: A_SECTION, files: [{ path: 'a.ts', status: 'modified' }] });
    manager.observe(obs());
    manager.observe(obs());
    expect(batches).toHaveLength(1); // only the seed
  });

  test('two files, two blurbs: editing one file appends for that file only', () => {
    const { manager, batches } = mkManager();
    manager.observe(
      mkObs({
        diff: A_SECTION + B_SECTION,
        files: [
          { path: 'a.ts', status: 'modified' },
          { path: 'b.ts', status: 'modified' },
        ],
      })
    );
    const editedA = fileSection('a.ts', [H('@@ -2,1 +2,2 @@', ['-old a', '+new a', '+more a'])]);
    manager.observe(
      mkObs({
        diff: editedA + B_SECTION,
        files: [
          { path: 'a.ts', status: 'modified' },
          { path: 'b.ts', status: 'modified' },
        ],
      })
    );

    expect(batches).toHaveLength(2);
    const second = hunkEntries(batches[1]);
    expect(second).toHaveLength(1);
    expect(second[0].path).toBe('a.ts');
    expect(second[0].kind).toBe('expanded');
    expect(second[0].seeded).toBe(false);
  });

  test('untracked defer guard: status lists the path, diff has no section -> nothing this tick', () => {
    const { manager, batches } = mkManager();
    manager.observe(mkObs({ diff: A_SECTION, files: [{ path: 'a.ts', status: 'modified' }] }));

    // u.txt is untracked but its synthetic section is missing (read failed).
    manager.observe(
      mkObs({
        diff: A_SECTION,
        files: [
          { path: 'a.ts', status: 'modified' },
          { path: 'u.txt', status: 'untracked' },
        ],
      })
    );
    expect(batches).toHaveLength(1); // no phantom revert, no create

    // Next tick the section is present -> created.
    const uSection = fileSection('u.txt', [H('@@ -0,0 +1,2 @@', ['+one', '+two'])]);
    manager.observe(
      mkObs({
        diff: A_SECTION + uSection,
        files: [
          { path: 'a.ts', status: 'modified' },
          { path: 'u.txt', status: 'untracked' },
        ],
      })
    );
    expect(batches).toHaveLength(2);
    const created = hunkEntries(batches[1]);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ path: 'u.txt', kind: 'created', status: 'untracked' });
  });

  test('whole-file revert: ONE entry superseding all the live seqs', () => {
    const { manager, batches } = mkManager();
    const twoHunks = fileSection('a.ts', [
      H('@@ -2 +2 @@', ['-a', '+A']),
      H('@@ -9 +9 @@', ['-b', '+B']),
    ]);
    manager.observe(mkObs({ diff: twoHunks, files: [{ path: 'a.ts', status: 'modified' }] }));
    const seededSeqs = hunkEntries(batches[0]).map((h) => h.seq);
    expect(seededSeqs).toHaveLength(2);

    manager.observe(mkObs({ diff: '', files: [] }));
    expect(batches).toHaveLength(2);
    const reverts = hunkEntries(batches[1]);
    expect(reverts).toHaveLength(1);
    expect(reverts[0].kind).toBe('reverted');
    expect(reverts[0].diff).toBeNull();
    expect(reverts[0].supersedes).toEqual(seededSeqs);
    expect(manager.journalStore.live.size).toBe(0);
  });

  test('commit boundary: one divider, survivors rebaseline silently across coordinate jumps', () => {
    const { manager, batches } = mkManager();
    const bFar = fileSection('b.ts', [H('@@ -100,1 +100,1 @@', ['-old b', '+new b'])]);
    manager.observe(
      mkObs({
        diff: A_SECTION + bFar,
        files: [
          { path: 'a.ts', status: 'modified' },
          { path: 'b.ts', status: 'modified' },
        ],
        headOid: 'oid-1',
      })
    );
    const aSeqs = hunkEntries(batches[0])
      .filter((h) => h.path === 'a.ts')
      .map((h) => h.seq);
    const bSeq = hunkEntries(batches[0]).find((h) => h.path === 'b.ts')!.seq;

    // Commit a.ts. HEAD moves; b.ts survives with the same body at a
    // completely different old coordinate (footprints MUST not be compared).
    const bNear = fileSection('b.ts', [H('@@ -3,1 +3,1 @@', ['-old b', '+new b'])]);
    manager.observe(
      mkObs({
        diff: bNear,
        files: [{ path: 'b.ts', status: 'modified' }],
        headOid: 'oid-2',
      })
    );

    expect(batches).toHaveLength(2);
    expect(batches[1]).toHaveLength(1);
    const boundary = boundaries(batches[1])[0];
    expect(boundary.kind).toBe('commit');
    expect(boundary.label).toBe('oid-2'.slice(0, 7));
    expect(boundary.resolves).toEqual(aSeqs);
    expect(manager.journalStore.live.get('b.ts')![0].seq).toBe(bSeq); // same seq, fresh runs
  });

  test('checkout boundary when the branch changed', () => {
    const { manager, batches } = mkManager();
    manager.observe(
      mkObs({ diff: A_SECTION, files: [{ path: 'a.ts', status: 'modified' }], branch: 'main' })
    );
    manager.observe(mkObs({ diff: '', files: [], branch: 'feat-x', headOid: 'oid-2' }));

    const boundary = boundaries(batches[1])[0];
    expect(boundary.kind).toBe('checkout');
    expect(boundary.label).toBe('feat-x');
  });

  test('a file newly in the diff at a boundary tick classifies as created after the divider', () => {
    const { manager, batches } = mkManager();
    manager.observe(mkObs({ diff: A_SECTION, files: [{ path: 'a.ts', status: 'modified' }] }));
    manager.observe(
      mkObs({
        diff: B_SECTION,
        files: [{ path: 'b.ts', status: 'modified' }],
        headOid: 'oid-2',
      })
    );

    const batch = batches[1];
    expect(batch[0].type).toBe('boundary');
    const created = hunkEntries(batch);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ path: 'b.ts', kind: 'created' });
  });

  test('no observation classifies across a boundary: post-commit edit journals fresh, not vs stale footprints', () => {
    const { manager, batches } = mkManager();
    manager.observe(mkObs({ diff: A_SECTION, files: [{ path: 'a.ts', status: 'modified' }] }));

    // Commit everything: file leaves the diff.
    manager.observe(mkObs({ diff: '', files: [], headOid: 'oid-2' }));
    expect(hunkEntries(batches[1])).toHaveLength(0); // divider only, no tombstone

    // Byte-identical re-edit after the commit appends fresh (B3).
    manager.observe(
      mkObs({ diff: A_SECTION, files: [{ path: 'a.ts', status: 'modified' }], headOid: 'oid-2' })
    );
    const fresh = hunkEntries(batches[2]);
    expect(fresh).toHaveLength(1);
    expect(fresh[0].kind).toBe('created');
    expect(fresh[0].supersedes).toEqual([]);
  });

  test('operation suspension: op-start divider, silence during, op-end divider then classification', () => {
    const { manager, batches } = mkManager();
    manager.observe(mkObs({ diff: A_SECTION, files: [{ path: 'a.ts', status: 'modified' }] }));

    manager.observe(
      mkObs({ diff: A_SECTION, files: [{ path: 'a.ts', status: 'modified' }], op: 'rebase' })
    );
    expect(batches).toHaveLength(2);
    expect(boundaries(batches[1])[0]).toMatchObject({ kind: 'op-start', label: 'rebase' });

    // Garbage mid-operation diffs are suspended.
    const garbage = fileSection('a.ts', [H('@@ -1,5 +1,9 @@', ['-x', '+<<<<<<< HEAD', '+y'])]);
    manager.observe(
      mkObs({ diff: garbage, files: [{ path: 'a.ts', status: 'modified' }], op: 'rebase' })
    );
    expect(batches).toHaveLength(2);

    // Operation ends; HEAD moved during it -> op-end + commit boundary.
    manager.observe(mkObs({ diff: '', files: [], headOid: 'oid-2' }));
    const finalBatch = batches[2];
    expect(boundaries(finalBatch).map((b) => b.kind)).toEqual(['op-end', 'commit']);
  });

  test('stash heuristic: disappearance with a rising stash count folds into one stash boundary', () => {
    const { manager, batches } = mkManager();
    manager.observe(
      mkObs({
        diff: A_SECTION + B_SECTION,
        files: [
          { path: 'a.ts', status: 'modified' },
          { path: 'b.ts', status: 'modified' },
        ],
        stashCount: 0,
      })
    );
    const allSeqs = hunkEntries(batches[0]).map((h) => h.seq);

    manager.observe(mkObs({ diff: '', files: [], stashCount: 1 }));
    const batch = batches[1];
    expect(batch).toHaveLength(1);
    const boundary = boundaries(batch)[0];
    expect(boundary.kind).toBe('stash');
    expect([...boundary.resolves].sort((a, b) => a - b)).toEqual(allSeqs);
    expect(hunkEntries(batch)).toHaveLength(0); // no reverted entries
  });

  test('rename: live hunks re-key, one renamed marker, content stays silent', () => {
    const { manager, batches } = mkManager();
    const aHunk = H('@@ -2,1 +2,1 @@', ['-old a', '+new a']);
    manager.observe(
      mkObs({ diff: fileSection('a.ts', [aHunk]), files: [{ path: 'a.ts', status: 'modified' }] })
    );
    const seedSeq = hunkEntries(batches[0])[0].seq;

    const renamed = [
      'diff --git a/a.ts b/c.ts',
      'similarity index 90%',
      'rename from a.ts',
      'rename to c.ts',
      '--- a/a.ts',
      '+++ b/c.ts',
      '@@ -2,1 +2,1 @@',
      '-old a',
      '+new a',
      '',
    ].join('\n');
    manager.observe(mkObs({ diff: renamed, files: [{ path: 'c.ts', status: 'renamed' }] }));

    const batch = batches[1];
    const hunks = hunkEntries(batch);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toMatchObject({ kind: 'renamed', path: 'c.ts' });
    expect(manager.journalStore.live.has('a.ts')).toBe(false);
    expect(manager.journalStore.live.get('c.ts')![0].seq).toBe(seedSeq);
  });

  test('branch rename with HEAD stable updates lastBranch: the next HEAD move is a commit, not a checkout', () => {
    const { manager, batches } = mkManager();
    manager.observe(
      mkObs({ diff: A_SECTION, files: [{ path: 'a.ts', status: 'modified' }], branch: 'main' })
    );

    // git branch -m: name changes, HEAD oid does not -> a classify tick
    // (content-silent) that must still track the new branch name.
    manager.observe(
      mkObs({ diff: A_SECTION, files: [{ path: 'a.ts', status: 'modified' }], branch: 'renamed' })
    );
    expect(batches).toHaveLength(1); // silent

    // Commit on the renamed branch: HEAD moves, branch holds -> 'commit'.
    manager.observe(mkObs({ diff: '', files: [], branch: 'renamed', headOid: 'oid-2' }));
    expect(batches).toHaveLength(2);
    expect(boundaries(batches[1])[0].kind).toBe('commit');
  });

  test('rename onto a path with live hunks: the displaced seqs retire via the marker', () => {
    const { manager, batches } = mkManager();
    manager.observe(
      mkObs({
        diff: A_SECTION + B_SECTION,
        files: [
          { path: 'a.ts', status: 'modified' },
          { path: 'b.ts', status: 'modified' },
        ],
      })
    );
    const aSeq = hunkEntries(batches[0]).find((h) => h.path === 'a.ts')!.seq;
    const bSeqs = hunkEntries(batches[0])
      .filter((h) => h.path === 'b.ts')
      .map((h) => h.seq);
    expect(bSeqs.length).toBeGreaterThan(0);

    // Delete b.ts and rename a.ts -> b.ts in ONE observation: b.ts's old
    // live seqs must retire through the marker, never dangle live.
    const renamedOntoB = [
      'diff --git a/a.ts b/b.ts',
      'similarity index 90%',
      'rename from a.ts',
      'rename to b.ts',
      '--- a/a.ts',
      '+++ b/b.ts',
      '@@ -2,1 +2,1 @@',
      '-old a',
      '+new a',
      '',
    ].join('\n');
    manager.observe(mkObs({ diff: renamedOntoB, files: [{ path: 'b.ts', status: 'renamed' }] }));

    const batch = batches[1];
    const marker = hunkEntries(batch).find((h) => h.kind === 'renamed')!;
    expect(marker.path).toBe('b.ts');
    expect(marker.supersedes).toEqual(bSeqs);
    expect(manager.journalStore.live.has('a.ts')).toBe(false);
    expect(manager.journalStore.live.get('b.ts')![0].seq).toBe(aSeq); // content silent
  });

  test('hunkless 100%-similarity rename with content reverted the same tick: marker only, no pseudo-hunk misfire', () => {
    const { manager, batches } = mkManager();
    manager.observe(mkObs({ diff: A_SECTION, files: [{ path: 'a.ts', status: 'modified' }] }));
    const seedSeq = hunkEntries(batches[0])[0].seq;

    // The edit reverts AND the file is renamed in one observation: git
    // reports a pure rename section with no hunks at all.
    const pureRename = [
      'diff --git a/a.ts b/c.ts',
      'similarity index 100%',
      'rename from a.ts',
      'rename to c.ts',
      '',
    ].join('\n');
    manager.observe(mkObs({ diff: pureRename, files: [{ path: 'c.ts', status: 'renamed' }] }));

    const batch = batches[1];
    expect(batch).toHaveLength(1);
    expect(hunkEntries(batch)[0]).toMatchObject({ kind: 'renamed', path: 'c.ts' });
    // The re-keyed live hunks are deferred untouched — no edited/shrunk
    // entry classified against the [[0, PSEUDO_RUN_HI]] pseudo-hunk.
    expect(manager.journalStore.live.get('c.ts')![0].seq).toBe(seedSeq);
  });

  test('one append event per observation, entries batched, seqs strictly monotonic', () => {
    const { manager, batches } = mkManager();
    manager.observe(
      mkObs({
        diff: A_SECTION + B_SECTION,
        files: [
          { path: 'a.ts', status: 'modified' },
          { path: 'b.ts', status: 'modified' },
        ],
      })
    );
    const editedBoth =
      fileSection('a.ts', [H('@@ -2,1 +2,1 @@', ['-old a', '+other a'])]) +
      fileSection('b.ts', [H('@@ -7,1 +7,1 @@', ['-old b', '+other b'])]);
    manager.observe(
      mkObs({
        diff: editedBoth,
        files: [
          { path: 'a.ts', status: 'modified' },
          { path: 'b.ts', status: 'modified' },
        ],
      })
    );

    expect(batches).toHaveLength(2);
    expect(hunkEntries(batches[1])).toHaveLength(2);

    const seqs = manager.journalStore.entries.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(manager.journalStore.nextSeq).toBe(seqs[seqs.length - 1] + 1);
  });

  test('an unseeded store waits out an in-progress operation before seeding', () => {
    const { manager, batches } = mkManager();
    manager.observe(
      mkObs({ diff: A_SECTION, files: [{ path: 'a.ts', status: 'modified' }], op: 'merge' })
    );
    expect(batches).toHaveLength(0);
    manager.observe(mkObs({ diff: A_SECTION, files: [{ path: 'a.ts', status: 'modified' }] }));
    expect(batches).toHaveLength(1);
    expect(boundaries(batches[0])[0].kind).toBe('journal-start');
  });

  test('binary section: pseudo-hunk creates once, changed raw appends, unchanged raw is silent', () => {
    const { manager, batches } = mkManager();
    const binary = (idx: string) =>
      [
        'diff --git a/img.png b/img.png',
        `index 1111111..${idx} 100644`,
        'Binary files a/img.png and b/img.png differ',
        '',
      ].join('\n');
    manager.observe(
      mkObs({ diff: binary('2222222'), files: [{ path: 'img.png', status: 'modified' }] })
    );
    expect(hunkEntries(batches[0])).toHaveLength(1);

    manager.observe(
      mkObs({ diff: binary('2222222'), files: [{ path: 'img.png', status: 'modified' }] })
    );
    expect(batches).toHaveLength(1); // silent

    manager.observe(
      mkObs({ diff: binary('3333333'), files: [{ path: 'img.png', status: 'modified' }] })
    );
    expect(batches).toHaveLength(2);
    expect(hunkEntries(batches[1])[0].kind).toBe('edited');
  });

  test('oversize untracked marker section: created with diff null, silent when unchanged, edited (still null) when it moves', () => {
    const oversizeSection = (size: number, mtime: number): string =>
      [
        'diff --git a/big.bin b/big.bin',
        'new file mode 100644',
        `${OVERSIZE_UNTRACKED_MARKER} size=${size} mtime=${mtime}`,
      ].join('\n') + '\n';
    const files: { path: string; status: FileStatus }[] = [
      { path: 'big.bin', status: 'untracked' },
    ];
    const { manager, batches } = mkManager();

    manager.observe(mkObs({ diff: oversizeSection(300_000, 111), files }));
    const created = hunkEntries(batches[0]);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      path: 'big.bin',
      kind: 'created',
      status: 'untracked',
      diff: null,
    });

    // Unchanged marker (same size/mtime suffix) -> silent, not re-appended.
    manager.observe(mkObs({ diff: oversizeSection(300_000, 111), files }));
    expect(batches).toHaveLength(1);

    // The file changed (suffix moved) -> an edited entry, still bodyless.
    manager.observe(mkObs({ diff: oversizeSection(300_500, 222), files }));
    expect(batches).toHaveLength(2);
    expect(hunkEntries(batches[1])[0]).toMatchObject({ kind: 'edited', diff: null });
  });
});

// --- Pruning (design decision 8) --------------------------------------------

/** Push synthetic non-live hunk entries straight into the store. */
function pushOutdated(store: JournalStore, count: number, bodySize = 1): number[] {
  const seqs: number[] = [];
  for (let i = 0; i < count; i++) {
    const seq = store.nextSeq++;
    seqs.push(seq);
    store.entries.push({
      type: 'hunk',
      seq,
      ts: 0,
      path: `noise-${seq}.ts`,
      status: 'modified',
      kind: 'edited',
      span: { start: 1, count: 1 },
      stats: { insertions: 1, deletions: 0 },
      // Body size is measured from the LINES (the diff's only
      // representation), so the filler has to live there.
      diff: { lines: [{ type: 'context', content: 'x'.repeat(bodySize - 1) }] },
      supersedes: [],
      siblings: 1,
      seeded: false,
    });
  }
  return seqs;
}

describe('JournalManager pruning', () => {
  const EDITED_A = fileSection('a.ts', [H('@@ -2,1 +2,1 @@', ['-old a', '+edited a'])]);

  test('count cap: a contiguous oldest prefix is evicted, the derived prunedBefore advances, the live tail survives', () => {
    const { manager } = mkManager();
    manager.observe(mkObs({ diff: A_SECTION, files: [{ path: 'a.ts', status: 'modified' }] }));
    const store = manager.journalStore;
    pushOutdated(store, 600);

    // The edit supersedes the seeded a.ts entry; the append triggers pruning.
    manager.observe(mkObs({ diff: EDITED_A, files: [{ path: 'a.ts', status: 'modified' }] }));

    expect(store.entries).toHaveLength(MAX_JOURNAL_ENTRIES);
    const last = store.entries[store.entries.length - 1] as JournalHunkEntry;
    expect(last.path).toBe('a.ts');
    expect(last.kind).toBe('edited');
    // Contiguous prefix eviction keeps entries[0].seq - 1 (the daemon's
    // derived prunedBefore) equal to the highest evicted seq.
    expect(store.entries[0].seq).toBe(last.seq - MAX_JOURNAL_ENTRIES + 1);
    // The live map still points at a retained entry.
    expect(store.live.get('a.ts')![0].seq).toBe(last.seq);
  });

  test('a live identity is never evicted: eviction stops at the oldest live entry', () => {
    const { manager } = mkManager();
    manager.observe(mkObs({ diff: A_SECTION, files: [{ path: 'a.ts', status: 'modified' }] }));
    const store = manager.journalStore;
    const liveSeq = store.live.get('a.ts')![0].seq; // sits right behind the journal-start boundary
    pushOutdated(store, 600);

    // An unrelated new file appends; a.ts stays live and unchanged.
    manager.observe(
      mkObs({
        diff: A_SECTION + B_SECTION,
        files: [
          { path: 'a.ts', status: 'modified' },
          { path: 'b.ts', status: 'modified' },
        ],
      })
    );

    // Only the boundary ahead of the live entry could go; the store stays
    // over the cap rather than losing a live identity.
    expect(store.entries[0].seq).toBe(liveSeq);
    expect(store.entries.length).toBeGreaterThan(MAX_JOURNAL_ENTRIES);
    expect(store.live.get('a.ts')![0].seq).toBe(liveSeq);
  });

  test('byte budget: the oldest OUTDATED bodies are nulled first; live bodies and the newest outdated survive', () => {
    const { manager } = mkManager();
    manager.observe(mkObs({ diff: A_SECTION, files: [{ path: 'a.ts', status: 'modified' }] }));
    const store = manager.journalStore;
    const MB = 1024 * 1024;
    const fatSeqs = pushOutdated(store, 19, MB); // 19MB of outdated snapshot bodies

    // Pin the OLDEST fat entry live; its path defers (status lists it,
    // no diff section), so the observe leaves its live hunks untouched.
    store.live.set('fat.bin', [
      { seq: fatSeqs[0], runs: [[0, 2]], bodyHash: 'fat', ins: 1, del: 0 },
    ]);

    manager.observe(
      mkObs({
        diff: EDITED_A,
        files: [
          { path: 'a.ts', status: 'modified' },
          { path: 'fat.bin', status: 'untracked' },
        ],
      })
    );

    const bodyOf = new Map(
      store.entries
        .filter((e): e is JournalHunkEntry => e.type === 'hunk')
        .map((e) => [e.seq, e.diff])
    );
    expect(bodyOf.get(fatSeqs[0])).not.toBeNull(); // live: skipped by the byte pass
    expect(bodyOf.get(fatSeqs[1])).toBeNull(); // oldest outdated: nulled first
    expect(bodyOf.get(fatSeqs[2])).toBeNull();
    expect(bodyOf.get(fatSeqs[fatSeqs.length - 1])).not.toBeNull(); // newest outdated retained

    // The budget holds for everything the pass was allowed to touch
    // (the one pinned live body is the only possible excess).
    let retained = 0;
    for (const e of store.entries) {
      if (e.type === 'hunk' && e.diff !== null) retained += rawFromLines(e.diff.lines).length;
    }
    expect(retained).toBeLessThanOrEqual(MAX_JOURNAL_SNAPSHOT_BYTES + MB);
    // No identity was evicted: well under the count cap.
    expect(store.entries[0].seq).toBe(1);
  });
});
