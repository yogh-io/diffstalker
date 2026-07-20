import { describe, it, expect } from 'vitest';
import {
  parseDiffLine,
  parseHunkHeader,
  parseDiffWithLineNumbers,
  countHunks,
  countHunksPerFile,
  extractHunkPatch,
} from './diffParse.js';

describe('parseDiffLine', () => {
  it('parses diff --git header', () => {
    const result = parseDiffLine('diff --git a/file.ts b/file.ts');
    expect(result.type).toBe('header');
    expect(result.content).toBe('diff --git a/file.ts b/file.ts');
  });

  it('parses index header', () => {
    const result = parseDiffLine('index abc123..def456 100644');
    expect(result.type).toBe('header');
  });

  it('parses --- header', () => {
    const result = parseDiffLine('--- a/file.ts');
    expect(result.type).toBe('header');
  });

  it('parses +++ header', () => {
    const result = parseDiffLine('+++ b/file.ts');
    expect(result.type).toBe('header');
  });

  it('parses new file header', () => {
    const result = parseDiffLine('new file mode 100644');
    expect(result.type).toBe('header');
  });

  it('parses deleted file header', () => {
    const result = parseDiffLine('deleted file mode 100644');
    expect(result.type).toBe('header');
  });

  it('parses hunk header', () => {
    const result = parseDiffLine('@@ -1,5 +1,7 @@');
    expect(result.type).toBe('hunk');
    expect(result.content).toBe('@@ -1,5 +1,7 @@');
  });

  it('parses addition line', () => {
    const result = parseDiffLine('+const x = 1;');
    expect(result.type).toBe('addition');
    expect(result.content).toBe('+const x = 1;');
  });

  it('parses deletion line', () => {
    const result = parseDiffLine('-const x = 1;');
    expect(result.type).toBe('deletion');
    expect(result.content).toBe('-const x = 1;');
  });

  it('parses context line', () => {
    const result = parseDiffLine(' const y = 2;');
    expect(result.type).toBe('context');
    expect(result.content).toBe(' const y = 2;');
  });

  it('parses empty line as context', () => {
    const result = parseDiffLine('');
    expect(result.type).toBe('context');
  });
});

describe('parseHunkHeader', () => {
  it('parses standard hunk header with counts', () => {
    const result = parseHunkHeader('@@ -1,5 +1,7 @@');
    expect(result).toEqual({ oldStart: 1, newStart: 1 });
  });

  it('parses hunk header with different line numbers', () => {
    const result = parseHunkHeader('@@ -10,3 +15,8 @@');
    expect(result).toEqual({ oldStart: 10, newStart: 15 });
  });

  it('parses hunk header without counts', () => {
    const result = parseHunkHeader('@@ -10 +10 @@');
    expect(result).toEqual({ oldStart: 10, newStart: 10 });
  });

  it('parses hunk header with function context', () => {
    const result = parseHunkHeader('@@ -1,5 +1,7 @@ function test() {');
    expect(result).toEqual({ oldStart: 1, newStart: 1 });
  });

  it('returns null for non-hunk lines', () => {
    expect(parseHunkHeader('+const x = 1;')).toBeNull();
    expect(parseHunkHeader('diff --git a/file.ts b/file.ts')).toBeNull();
    expect(parseHunkHeader(' context')).toBeNull();
  });

  it('parses hunk header with only old count', () => {
    const result = parseHunkHeader('@@ -1,5 +1 @@');
    expect(result).toEqual({ oldStart: 1, newStart: 1 });
  });
});

describe('parseDiffWithLineNumbers', () => {
  it('parses empty diff', () => {
    const result = parseDiffWithLineNumbers('');
    expect(result).toHaveLength(1); // Single empty context line
  });

  it('parses simple diff with line numbers', () => {
    const diff = `diff --git a/file.ts b/file.ts
index abc..def 100644
--- a/file.ts
+++ b/file.ts
@@ -1,3 +1,4 @@
 line1
+added
 line2
 line3`;
    const result = parseDiffWithLineNumbers(diff);

    // Check headers
    expect(result[0].type).toBe('header');
    expect(result[1].type).toBe('header');
    expect(result[2].type).toBe('header');
    expect(result[3].type).toBe('header');

    // Check hunk
    expect(result[4].type).toBe('hunk');

    // Check context line (line1)
    expect(result[5].type).toBe('context');
    expect(result[5].oldLineNum).toBe(1);
    expect(result[5].newLineNum).toBe(1);

    // Check addition
    expect(result[6].type).toBe('addition');
    expect(result[6].newLineNum).toBe(2);
    expect(result[6].oldLineNum).toBeUndefined();

    // Check context (line2)
    expect(result[7].type).toBe('context');
    expect(result[7].oldLineNum).toBe(2);
    expect(result[7].newLineNum).toBe(3);
  });

  it('parses deletion with correct line numbers', () => {
    const diff = `@@ -5,3 +5,2 @@
 context
-deleted
 more`;
    const result = parseDiffWithLineNumbers(diff);

    // Hunk starts at line 5
    expect(result[1].type).toBe('context');
    expect(result[1].oldLineNum).toBe(5);
    expect(result[1].newLineNum).toBe(5);

    expect(result[2].type).toBe('deletion');
    expect(result[2].oldLineNum).toBe(6);
    expect(result[2].newLineNum).toBeUndefined();

    expect(result[3].type).toBe('context');
    expect(result[3].oldLineNum).toBe(7);
    expect(result[3].newLineNum).toBe(6);
  });

  it('parses binary file header', () => {
    const diff = `diff --git a/image.png b/image.png
Binary files a/image.png and b/image.png differ`;
    const result = parseDiffWithLineNumbers(diff);

    expect(result[0].type).toBe('header');
    expect(result[1].type).toBe('header');
    expect(result[1].content).toContain('Binary files');
  });

  it('parses rename headers', () => {
    const diff = `diff --git a/old.ts b/new.ts
similarity index 95%
rename from old.ts
rename to new.ts`;
    const result = parseDiffWithLineNumbers(diff);

    expect(result.filter((l) => l.type === 'header')).toHaveLength(4);
    expect(result.some((l) => l.content.includes('rename from'))).toBe(true);
    expect(result.some((l) => l.content.includes('rename to'))).toBe(true);
  });

  it('handles multiple hunks', () => {
    const diff = `@@ -1,2 +1,2 @@
 a
-b
+c
@@ -10,2 +10,2 @@
 x
-y
+z`;
    const result = parseDiffWithLineNumbers(diff);

    const hunks = result.filter((l) => l.type === 'hunk');
    expect(hunks).toHaveLength(2);

    // Second hunk should start at line 10
    const secondHunkIdx = result.findIndex((l) => l.content === '@@ -10,2 +10,2 @@');
    expect(result[secondHunkIdx + 1].oldLineNum).toBe(10);
    expect(result[secondHunkIdx + 1].newLineNum).toBe(10);
  });
});

describe('countHunks / countHunksPerFile', () => {
  it('counts hunks in a raw diff', () => {
    const diff = `@@ -1,2 +1,2 @@
 a
-b
+c
@@ -10,2 +10,2 @@
 x
-y
+z`;
    expect(countHunks(diff)).toBe(2);
  });

  it('returns 0 for empty input', () => {
    expect(countHunks('')).toBe(0);
  });

  it('counts hunks per file across a multi-file diff', () => {
    const diff = `diff --git a/one.txt b/one.txt
index 111..222 100644
--- a/one.txt
+++ b/one.txt
@@ -1,2 +1,2 @@
 a
-b
+c
@@ -10,2 +10,2 @@
 x
-y
+z
diff --git a/two.txt b/two.txt
index 333..444 100644
--- a/two.txt
+++ b/two.txt
@@ -1,1 +1,1 @@
-old
+new`;
    const counts = countHunksPerFile(diff);
    expect(counts.get('one.txt')).toBe(2);
    expect(counts.get('two.txt')).toBe(1);
  });
});

describe('extractHunkPatch', () => {
  const SINGLE_HUNK_DIFF = `diff --git a/file.txt b/file.txt
index 0000000..1111111 100644
--- a/file.txt
+++ b/file.txt
@@ -1,3 +1,3 @@
 line1
-line2
+changed
 line3
`;

  const MULTI_HUNK_DIFF = `diff --git a/multi.txt b/multi.txt
index abc1234..def5678 100644
--- a/multi.txt
+++ b/multi.txt
@@ -1,3 +1,3 @@
 a
-b
+B
 c
@@ -10,3 +10,3 @@
 j
-k
+K
 l
@@ -20,2 +20,3 @@
 t
+u
 v
`;

  it('extracts the only hunk of a single-hunk diff unchanged', () => {
    const patch = extractHunkPatch(SINGLE_HUNK_DIFF, 0);
    expect(patch).toBe(SINGLE_HUNK_DIFF);
  });

  it('extracts the first hunk of a multi-hunk diff with all file headers', () => {
    const patch = extractHunkPatch(MULTI_HUNK_DIFF, 0);
    expect(patch).not.toBeNull();
    expect(patch).toContain('diff --git a/multi.txt b/multi.txt');
    expect(patch).toContain('index abc1234..def5678 100644');
    expect(patch).toContain('--- a/multi.txt');
    expect(patch).toContain('+++ b/multi.txt');
    expect(patch).toContain('@@ -1,3 +1,3 @@');
    expect(patch).toContain('+B');
    expect(patch).not.toContain('@@ -10,3 +10,3 @@');
    expect(patch).not.toContain('@@ -20,2 +20,3 @@');
    expect(patch).not.toContain('+K');
    expect(patch).not.toContain('+u');
  });

  it('extracts a middle hunk without neighboring hunks', () => {
    const patch = extractHunkPatch(MULTI_HUNK_DIFF, 1);
    expect(patch).not.toBeNull();
    expect(patch).toContain('@@ -10,3 +10,3 @@');
    expect(patch).toContain('+K');
    expect(patch).not.toContain('+B');
    expect(patch).not.toContain('+u');
  });

  it('extracts the last hunk and terminates with a single newline', () => {
    const patch = extractHunkPatch(MULTI_HUNK_DIFF, 2);
    expect(patch).not.toBeNull();
    expect(patch).toContain('@@ -20,2 +20,3 @@');
    expect(patch).toContain('+u');
    expect(patch).not.toContain('+B');
    expect(patch).not.toContain('+K');
    expect(patch!.endsWith(' v\n')).toBe(true);
    expect(patch!.endsWith('\n\n')).toBe(false);
  });

  it('returns null for an out-of-range hunk index', () => {
    expect(extractHunkPatch(MULTI_HUNK_DIFF, 3)).toBeNull();
    expect(extractHunkPatch(MULTI_HUNK_DIFF, 99)).toBeNull();
    expect(extractHunkPatch(MULTI_HUNK_DIFF, -1)).toBeNull();
    expect(extractHunkPatch(SINGLE_HUNK_DIFF, 1)).toBeNull();
  });

  it('returns null for an empty diff', () => {
    expect(extractHunkPatch('', 0)).toBeNull();
  });

  it('returns null for a diff with headers but no hunks', () => {
    const headersOnly = `diff --git a/image.png b/image.png
Binary files a/image.png and b/image.png differ
`;
    expect(extractHunkPatch(headersOnly, 0)).toBeNull();
  });

  it('keeps "No newline at end of file" markers with the hunk', () => {
    const noNewlineDiff = `diff --git a/nonl.txt b/nonl.txt
index 1234567..89abcde 100644
--- a/nonl.txt
+++ b/nonl.txt
@@ -1 +1 @@
-old
\\ No newline at end of file
+new
\\ No newline at end of file
`;
    const patch = extractHunkPatch(noNewlineDiff, 0);
    expect(patch).not.toBeNull();
    const markers = patch!.split('\n').filter((l) => l === '\\ No newline at end of file');
    expect(markers).toHaveLength(2);
    expect(patch).toBe(noNewlineDiff);
  });

  it('preserves section context after the @@ in hunk headers', () => {
    const contextDiff = `diff --git a/code.ts b/code.ts
index 1111111..2222222 100644
--- a/code.ts
+++ b/code.ts
@@ -5,3 +5,4 @@ export function test() {
 const a = 1;
+const b = 2;
 const c = 3;
 }
`;
    const patch = extractHunkPatch(contextDiff, 0);
    expect(patch).not.toBeNull();
    expect(patch).toContain('@@ -5,3 +5,4 @@ export function test() {');
    expect(patch).toBe(contextDiff);
  });

  it('preserves multi-line content and line order exactly', () => {
    const patch = extractHunkPatch(MULTI_HUNK_DIFF, 0);
    const lines = patch!.split('\n');
    expect(lines[4]).toBe('@@ -1,3 +1,3 @@');
    expect(lines.slice(5, 9)).toEqual([' a', '-b', '+B', ' c']);
  });
});
