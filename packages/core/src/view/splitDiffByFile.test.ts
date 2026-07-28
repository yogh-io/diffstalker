/**
 * splitDiffByFile tests: multi-file splitting, single-file passthrough,
 * empty input, binary-file headers, round-trip fidelity (the per-file
 * sections re-concatenate to the whole-tree text), and preservation of
 * the already-parsed line objects (editedAt stamps, object identity).
 */

import { describe, test, expect } from 'vitest';
import { splitDiffByFile } from './splitDiffByFile.js';
import { parseDiffWithLineNumbers, rawFromLines } from '../git/diffParse.js';
import type { DiffResult } from '../git/diffParse.js';

function fileDiffRaw(path: string, marker: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    `index 1111111..2222222 100644`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,2 +1,2 @@`,
    ` context ${marker}`,
    `-old ${marker}`,
    `+new ${marker}`,
    '',
  ].join('\n');
}

function toDiffResult(raw: string): DiffResult {
  return { raw, lines: parseDiffWithLineNumbers(raw) };
}

describe('splitDiffByFile', () => {
  test('splits a multi-file diff into per-file DiffResults keyed by path', () => {
    const rawA = fileDiffRaw('src/a.ts', 'A');
    const rawB = fileDiffRaw('src/b.ts', 'B');
    const split = splitDiffByFile(toDiffResult(rawA + rawB));

    expect([...split.keys()]).toEqual(['src/a.ts', 'src/b.ts']);
    expect(rawFromLines(split.get('src/a.ts')!.lines ?? [])).toBe(rawA);
    expect(rawFromLines(split.get('src/b.ts')!.lines ?? [])).toBe(rawB);

    // Each per-file lines set is exactly that file's slice of the whole.
    const aLines = split.get('src/a.ts')!.lines;
    expect(aLines[0].content).toBe('diff --git a/src/a.ts b/src/a.ts');
    expect(aLines.some((l) => l.content.includes('B'))).toBe(false);
    expect(aLines.filter((l) => l.type === 'hunk')).toHaveLength(1);
  });

  test('per-file raws re-concatenate to the whole-tree raw (round trip)', () => {
    const whole = fileDiffRaw('a.ts', 'A') + fileDiffRaw('b.ts', 'B') + fileDiffRaw('c.ts', 'C');
    const split = splitDiffByFile(toDiffResult(whole));
    expect([...split.values()].map((d) => rawFromLines(d.lines)).join('')).toBe(whole);
  });

  test('a single-file diff yields one entry with the input raw', () => {
    const raw = fileDiffRaw('only.ts', 'X');
    const split = splitDiffByFile(toDiffResult(raw));
    expect(split.size).toBe(1);
    expect(rawFromLines(split.get('only.ts')!.lines ?? [])).toBe(raw);
    expect(split.get('only.ts')!.lines).toHaveLength(8);
  });

  test('an empty diff yields an empty map', () => {
    expect(splitDiffByFile({ lines: [] }).size).toBe(0);
  });

  test('a binary-file section keeps its Binary files header, no hunks', () => {
    const binary = [
      'diff --git a/img.png b/img.png',
      'index 1111111..2222222 100644',
      'Binary files a/img.png and b/img.png differ',
      '',
    ].join('\n');
    const raw = binary + fileDiffRaw('a.ts', 'A');
    const split = splitDiffByFile(toDiffResult(raw));

    expect([...split.keys()]).toEqual(['img.png', 'a.ts']);
    const img = split.get('img.png')!;
    expect(rawFromLines(img.lines)).toBe(binary);
    expect(img.lines.some((l) => l.content.startsWith('Binary files'))).toBe(true);
    expect(img.lines.every((l) => l.type === 'header')).toBe(true);
  });

  test('keeps the SAME parsed line objects — editedAt stamps survive unsplit', () => {
    const whole = toDiffResult(fileDiffRaw('a.ts', 'A') + fileDiffRaw('b.ts', 'B'));
    const hunkLine = whole.lines.find((l) => l.type === 'hunk')!;
    hunkLine.editedAt = 1721480000000; // daemon-side stamp on the whole-tree parse

    const split = splitDiffByFile(whole);
    const aLines = split.get('a.ts')!.lines;
    expect(aLines.find((l) => l.type === 'hunk')).toBe(hunkLine); // identity, not a copy
    expect(aLines.find((l) => l.type === 'hunk')!.editedAt).toBe(1721480000000);
  });

  test('content before the first diff --git header is dropped', () => {
    const raw = 'warning: something\n' + fileDiffRaw('a.ts', 'A');
    const split = splitDiffByFile(toDiffResult(raw));
    expect([...split.keys()]).toEqual(['a.ts']);
    expect(rawFromLines(split.get('a.ts')!.lines ?? [])).toBe(fileDiffRaw('a.ts', 'A'));
  });
});
