/**
 * Highlighter tests: known languages produce hljs token spans, unknown
 * extensions fall back to plain ESCAPED text (no raw HTML injection),
 * line counts match the source, oversized lines skip hljs for the whole
 * file (freeze guard), CR/CRLF never reach the output, and the line
 * splitter keeps span markup balanced across multi-line tokens (block
 * comments).
 */

import { describe, test, expect, vi, afterEach } from 'vitest';
import hljs from 'highlight.js/lib/common';
import {
  escapeHtml,
  highlightContent,
  splitHighlightedHtml,
  MAX_HIGHLIGHT_LINE_LENGTH,
} from './highlight';

afterEach(() => {
  vi.restoreAllMocks();
});

/** Count occurrences of a substring. */
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('highlightContent', () => {
  test('a known language produces hljs token spans', () => {
    const { lines, language } = highlightContent(
      'const x = 42; // answer\n',
      'src/foo.ts'
    );
    expect(language).toBe('typescript');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('<span class="hljs-keyword">const</span>');
    expect(lines[0]).toContain('hljs-number');
    expect(lines[0]).toContain('hljs-comment');
  });

  test('an unknown extension renders plain escaped text — no crash, no injection', () => {
    const { lines, language } = highlightContent(
      '<script>alert("x")</script>\n& <b>bold</b>',
      'notes.xyz'
    );
    expect(language).toBe(null);
    expect(lines).toHaveLength(2);
    // Everything markup-ish is escaped; nothing injectable survives.
    expect(lines[0]).toBe('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    expect(lines[1]).toBe('&amp; &lt;b&gt;bold&lt;/b&gt;');
    expect(lines.join('')).not.toContain('<');
  });

  test('a plaintext mapping (e.g. .txt) also renders plain', () => {
    const { language } = highlightContent('hello', 'readme.txt');
    expect(language).toBe(null);
  });

  test('a language hljs does not bundle falls back to plain text', () => {
    // languageDetection maps .zig, but lib/common does not include zig.
    const { language, lines } = highlightContent('const x = 1;', 'main.zig');
    expect(language).toBe(null);
    expect(lines).toEqual(['const x = 1;']);
  });

  test('line count matches the source; a trailing newline adds no phantom line', () => {
    const src = 'line one\nline two\nline three\n';
    const highlighted = highlightContent(src, 'src/foo.ts');
    expect(highlighted.lines).toHaveLength(3);
    const plain = highlightContent(src, 'notes.xyz');
    expect(plain.lines).toHaveLength(3);
    // Without the trailing newline the count is identical.
    expect(highlightContent('a\nb', 'notes.xyz').lines).toHaveLength(2);
  });

  test('source text inside a highlighted file stays escaped', () => {
    const { lines } = highlightContent('const s = "<b>&</b>";', 'src/foo.ts');
    const joined = lines.join('');
    expect(joined).not.toContain('<b>');
    expect(joined).toContain('&lt;b&gt;');
  });

  test('a file with one huge line renders plain — hljs is never invoked (freeze guard)', () => {
    const spy = vi.spyOn(hljs, 'highlight');
    const huge = '<'.repeat(100_000);
    const { lines, language } = highlightContent(`const a = 1;\n${huge}\nconst b = 2;\n`, 'src/foo.ts');

    expect(spy).not.toHaveBeenCalled();
    expect(language).toBe(null);
    expect(lines).toHaveLength(3);
    // The escaping is the same plain path as unknown languages.
    expect(lines[0]).toBe('const a = 1;');
    expect(lines[1]).toBe('&lt;'.repeat(100_000));
    expect(lines.join('')).not.toContain('<');
  });

  test('a line exactly at the threshold still highlights; one char over does not', () => {
    const spy = vi.spyOn(hljs, 'highlight');
    const at = highlightContent('x'.repeat(MAX_HIGHLIGHT_LINE_LENGTH), 'src/foo.ts');
    expect(at.language).toBe('typescript');
    expect(spy).toHaveBeenCalledTimes(1);

    const over = highlightContent('x'.repeat(MAX_HIGHLIGHT_LINE_LENGTH + 1), 'src/foo.ts');
    expect(over.language).toBe(null);
    expect(spy).toHaveBeenCalledTimes(1); // no second call
  });

  test('CRLF line endings produce the right line count with no \\r in the output', () => {
    const plain = highlightContent('a\r\nb\r\n', 'notes.xyz');
    expect(plain.lines).toEqual(['a', 'b']);

    const highlighted = highlightContent('const a = 1;\r\nconst b = 2;\r\n', 'src/foo.ts');
    expect(highlighted.language).toBe('typescript');
    expect(highlighted.lines).toHaveLength(2);
    expect(highlighted.lines.join('')).not.toContain('\r');
  });

  test('a lone \\r counts as a line break — no hard break hides inside a numbered row', () => {
    const { lines } = highlightContent('a\rb\rc', 'notes.xyz');
    expect(lines).toEqual(['a', 'b', 'c']);
    expect(lines.join('')).not.toContain('\r');
  });

  test('a multi-line token (block comment) yields balanced spans on every line', () => {
    const src = '/*\n multi\n line\n*/\nconst x = 1;';
    const { lines } = highlightContent(src, 'src/foo.ts');
    expect(lines).toHaveLength(5);
    for (const line of lines) {
      expect(count(line, '<span')).toBe(count(line, '</span>'));
    }
    // The comment token color reaches the middle lines too.
    expect(lines[1]).toContain('hljs-comment');
  });
});

describe('splitHighlightedHtml', () => {
  test('splits plain text on newlines', () => {
    expect(splitHighlightedHtml('a\nb\nc')).toEqual(['a', 'b', 'c']);
  });

  test('reopens the span stack across lines', () => {
    const html = '<span class="hljs-comment">one\ntwo</span>after';
    expect(splitHighlightedHtml(html)).toEqual([
      '<span class="hljs-comment">one</span>',
      '<span class="hljs-comment">two</span>after',
    ]);
  });

  test('handles nested spans crossing a newline', () => {
    const html = '<span class="a">x<span class="b">y\nz</span></span>';
    expect(splitHighlightedHtml(html)).toEqual([
      '<span class="a">x<span class="b">y</span></span>',
      '<span class="a"><span class="b">z</span></span>',
    ]);
  });
});

describe('escapeHtml', () => {
  test('escapes the five significant characters', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#x27;');
  });
});
