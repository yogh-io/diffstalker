import { describe, it, expect } from 'vitest';
import { parseDiffLine, parseHunkHeader, parseDiffWithLineNumbers } from './diff.js';

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
