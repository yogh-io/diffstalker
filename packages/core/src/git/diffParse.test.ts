import { describe, it, expect } from 'vitest';
import {
  parseDiffLine,
  parseHunkHeader,
  parseDiffWithLineNumbers,
  countHunks,
  countHunksPerFile,
  extractHunkPatch,
  capLargeFileDiffs,
  isLargeFileDiff,
  isNoNewlineMarker,
  largeDiffNotice,
  LARGE_DIFF_NOTICE_PREFIX,
  MAX_FILE_DIFF_BYTES,
  MAX_FILE_DIFF_LINES,
  rawFromLines,
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

  it('parses mode-change headers', () => {
    expect(parseDiffLine('old mode 100644').type).toBe('header');
    expect(parseDiffLine('new mode 100755').type).toBe('header');
  });

  it('parses rename and copy headers', () => {
    // parseDiffLine shares one header list with parseDiffWithLineNumbers;
    // it used to carry a shorter copy that missed these.
    expect(parseDiffLine('similarity index 95%').type).toBe('header');
    expect(parseDiffLine('dissimilarity index 100%').type).toBe('header');
    expect(parseDiffLine('rename from old.ts').type).toBe('header');
    expect(parseDiffLine('rename to new.ts').type).toBe('header');
    expect(parseDiffLine('copy from f.txt').type).toBe('header');
    expect(parseDiffLine('copy to g.txt').type).toBe('header');
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
  it('parses an empty diff to NO lines', () => {
    // Not one phantom empty context line: lines are now the diff's only
    // representation, so an empty diff must round-trip back to ''.
    const result = parseDiffWithLineNumbers('');
    expect(result).toHaveLength(0);
    expect(rawFromLines(result)).toBe('');
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

  describe('"\\ No newline at end of file" marker', () => {
    it('takes no line number and advances neither counter', () => {
      const diff = `@@ -1,4 +1,4 @@
 one
-two
+TWO
 three
\\ No newline at end of file
 four`;
      const result = parseDiffWithLineNumbers(diff);

      const three = result[4];
      expect(three.content).toBe(' three');
      expect(three.oldLineNum).toBe(3);
      expect(three.newLineNum).toBe(3);

      // The marker annotates the line before it; it is not a line of
      // either file, so it carries no number at all.
      const marker = result[5];
      expect(marker.content).toBe('\\ No newline at end of file');
      expect(marker.oldLineNum).toBeUndefined();
      expect(marker.newLineNum).toBeUndefined();

      // 4, not 5: the marker must not have consumed a number on either side.
      const four = result[6];
      expect(four.content).toBe(' four');
      expect(four.oldLineNum).toBe(4);
      expect(four.newLineNum).toBe(4);
    });

    it('keeps the old and new gutters agreeing after a marker (split view)', () => {
      // Verbatim `git diff` of a file that had no trailing newline
      // ("one\ntwo") edited to "one\nTWO\nthree\n".
      const diff = `diff --git a/f.txt b/f.txt
index 9ed40b4..ddc897f 100644
--- a/f.txt
+++ b/f.txt
@@ -1,2 +1,3 @@
 one
-two
\\ No newline at end of file
+TWO
+three
`;
      const result = parseDiffWithLineNumbers(diff);
      const byContent = (content: string) => result.find((l) => l.content === content)!;

      // Split view puts "-two" and "+TWO" side by side; both are line 2
      // of their own file. Counting the marker pushed "+TWO" to 3 and the
      // two columns stopped lining up.
      expect(byContent('-two').oldLineNum).toBe(2);
      expect(byContent('+TWO').newLineNum).toBe(2);
      expect(byContent('+three').newLineNum).toBe(3);
      expect(byContent('\\ No newline at end of file').type).toBe('context');
    });

    it('isNoNewlineMarker is exported, and only matches the marker', () => {
      // The row builders import this rather than re-deriving the test —
      // a view that mistakes the marker for a context line loses the
      // del/add pairing around it.
      expect(isNoNewlineMarker('\\ No newline at end of file')).toBe(true);
      // Raw lines only: a context line keeps its leading space, so real
      // file content that starts with a backslash is not a marker.
      expect(isNoNewlineMarker(' \\ No newline at end of file')).toBe(false);
      expect(isNoNewlineMarker('-\\begin{document}')).toBe(false);
      expect(isNoNewlineMarker('\\begin{document}')).toBe(false);
    });

    it('handles a marker on both sides of a one-line rewrite', () => {
      const diff = `@@ -1 +1 @@
-old
\\ No newline at end of file
+new
\\ No newline at end of file`;
      const result = parseDiffWithLineNumbers(diff);

      expect(result[1].oldLineNum).toBe(1); // -old
      expect(result[3].newLineNum).toBe(1); // +new
      const markers = result.filter((l) => l.content.startsWith('\\ '));
      expect(markers).toHaveLength(2);
      for (const marker of markers) {
        expect(marker.oldLineNum).toBeUndefined();
        expect(marker.newLineNum).toBeUndefined();
      }
    });
  });

  describe('mode changes', () => {
    it('parses a mode-only diff as headers with no content lines', () => {
      // Verbatim `git diff` of a chmod +x — no index line, no hunk.
      const diff = `diff --git a/f.txt b/f.txt
old mode 100644
new mode 100755
`;
      const result = parseDiffWithLineNumbers(diff);

      expect(result.map((l) => l.type)).toEqual(['header', 'header', 'header']);
      // Nothing here is file content, so nothing carries a line number.
      // The old fall-through numbered "old mode 100644" as line 0.
      expect(result.every((l) => l.oldLineNum === undefined && l.newLineNum === undefined)).toBe(
        true
      );
    });

    it('parses mode lines alongside a content change without shifting the hunk', () => {
      const diff = `diff --git a/f.txt b/f.txt
old mode 100644
new mode 100755
index 4cb29ea..f04eb26
--- a/f.txt
+++ b/f.txt
@@ -1,3 +1,3 @@
 one
-two
+2
 three`;
      const result = parseDiffWithLineNumbers(diff);

      expect(result[1].type).toBe('header');
      expect(result[2].type).toBe('header');
      expect(result[6].type).toBe('hunk');
      expect(result[7].oldLineNum).toBe(1);
      expect(result[7].newLineNum).toBe(1);
    });

    it('types copy and dissimilarity headers, not file content', () => {
      const diff = `diff --git a/f.txt b/g.txt
similarity index 100%
copy from f.txt
copy to g.txt
diff --git a/h.txt b/h.txt
dissimilarity index 100%
index c827886..311db96 100644`;
      const result = parseDiffWithLineNumbers(diff);

      expect(result.every((l) => l.type === 'header')).toBe(true);
    });
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

  describe('multi-file diffs', () => {
    // File A (src/alpha.ts) has 2 hunks, file B (src/beta.ts) has 1.
    const TWO_FILE_DIFF = `diff --git a/src/alpha.ts b/src/alpha.ts
index 1111111..2222222 100644
--- a/src/alpha.ts
+++ b/src/alpha.ts
@@ -1,3 +1,3 @@
 a1
-a2
+A2
 a3
@@ -10,3 +10,3 @@
 a10
-a11
+A11
 a12
diff --git a/src/beta.ts b/src/beta.ts
index 3333333..4444444 100644
--- a/src/beta.ts
+++ b/src/beta.ts
@@ -5,3 +5,3 @@
 b5
-b6
+B6
 b7
`;

    it("hunk 0 returns file A's header plus A's first hunk", () => {
      const patch = extractHunkPatch(TWO_FILE_DIFF, 0);
      expect(patch).toBe(`diff --git a/src/alpha.ts b/src/alpha.ts
index 1111111..2222222 100644
--- a/src/alpha.ts
+++ b/src/alpha.ts
@@ -1,3 +1,3 @@
 a1
-a2
+A2
 a3
`);
    });

    it("hunk 1 returns file A's header plus A's second hunk", () => {
      const patch = extractHunkPatch(TWO_FILE_DIFF, 1);
      expect(patch).not.toBeNull();
      expect(patch).toContain('diff --git a/src/alpha.ts b/src/alpha.ts');
      expect(patch).toContain('--- a/src/alpha.ts');
      expect(patch).toContain('+++ b/src/alpha.ts');
      expect(patch).toContain('@@ -10,3 +10,3 @@');
      expect(patch).toContain('+A11');
      expect(patch).not.toContain('beta.ts');
      expect(patch).not.toContain('+A2');
    });

    it("hunk 2 (file B's only hunk) returns file B's header — NOT file A's", () => {
      const patch = extractHunkPatch(TWO_FILE_DIFF, 2);
      expect(patch).toBe(`diff --git a/src/beta.ts b/src/beta.ts
index 3333333..4444444 100644
--- a/src/beta.ts
+++ b/src/beta.ts
@@ -5,3 +5,3 @@
 b5
-b6
+B6
 b7
`);
      // The header names beta.ts and alpha.ts appears nowhere.
      expect(patch).toContain('diff --git a/src/beta.ts b/src/beta.ts');
      expect(patch).not.toContain('alpha.ts');
    });

    it('an out-of-range index across all files returns null', () => {
      expect(extractHunkPatch(TWO_FILE_DIFF, 3)).toBeNull();
    });

    it("a new-file second section keeps its mode lines in the extracted patch", () => {
      const withNewFile = `diff --git a/old.txt b/old.txt
index 1111111..2222222 100644
--- a/old.txt
+++ b/old.txt
@@ -1,1 +1,1 @@
-x
+y
diff --git a/fresh.txt b/fresh.txt
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/fresh.txt
@@ -0,0 +1,1 @@
+hello
`;
      const patch = extractHunkPatch(withNewFile, 1);
      expect(patch).toBe(`diff --git a/fresh.txt b/fresh.txt
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/fresh.txt
@@ -0,0 +1,1 @@
+hello
`);
    });
  });
});

describe('capLargeFileDiffs', () => {
  /** A one-file chunk with `lineCount` addition lines. */
  function chunk(path: string, lineCount: number, lineText = '+x'): string {
    const body = Array.from({ length: lineCount }, () => lineText).join('\n');
    return `diff --git a/${path} b/${path}\nindex 111..222 100644\n--- a/${path}\n+++ b/${path}\n@@ -0,0 +1,${lineCount} @@\n${body}\n`;
  }

  it('returns the input unchanged (same identity) when every file fits', () => {
    const raw = chunk('small.ts', 10);
    expect(capLargeFileDiffs(raw)).toBe(raw);
  });

  it('replaces a file over the line cap with its headers plus the notice', () => {
    const capped = capLargeFileDiffs(chunk('big.gml', MAX_FILE_DIFF_LINES + 1));

    expect(capped).toContain('diff --git a/big.gml b/big.gml');
    expect(capped).toContain('+++ b/big.gml');
    expect(capped).toContain(LARGE_DIFF_NOTICE_PREFIX);
    // The body is gone: no hunk header, no content lines.
    expect(capped).not.toContain('@@');
    expect(capped).not.toContain('+x');
  });

  it('replaces a file over the byte cap even when its line count is small', () => {
    const huge = chunk('one-liner.min.js', 2, '+' + 'x'.repeat(MAX_FILE_DIFF_BYTES));
    const capped = capLargeFileDiffs(huge);

    expect(capped).toContain(LARGE_DIFF_NOTICE_PREFIX);
    expect(capped.length).toBeLessThan(1000);
  });

  it('caps per file: an oversized file does not take its neighbours with it', () => {
    const capped = capLargeFileDiffs(
      chunk('small-a.ts', 3) + chunk('big.gml', MAX_FILE_DIFF_LINES + 1) + chunk('small-b.ts', 3)
    );

    expect(capped).toContain('@@ -0,0 +1,3 @@'); // both small files keep their bodies
    expect(capped.match(/@@ -0,0 \+1,3 @@/g)).toHaveLength(2);
    expect(capped).toContain(LARGE_DIFF_NOTICE_PREFIX);
    expect(capped).not.toContain(`@@ -0,0 +1,${MAX_FILE_DIFF_LINES + 1} @@`);
  });

  it('parses the notice as a header line, like git’s binary marker', () => {
    const lines = parseDiffWithLineNumbers(capLargeFileDiffs(chunk('big.gml', MAX_FILE_DIFF_LINES + 1)));
    const notice = lines.find((l) => l.content.startsWith(LARGE_DIFF_NOTICE_PREFIX));

    expect(notice?.type).toBe('header');
    expect(isLargeFileDiff({ raw: '', lines })).toBe(true);
  });

  it('reports the withheld size in the notice', () => {
    expect(largeDiffNotice(19_188_477, 121285)).toBe(
      'Large file — diff not shown (18.3 MB, 121,285 lines)'
    );
    // No line count when the content was never read (untracked, too big).
    expect(largeDiffNotice(2_097_152)).toBe('Large file — diff not shown (2.0 MB)');
  });

  it('leaves an empty diff alone', () => {
    expect(capLargeFileDiffs('')).toBe('');
  });
});
