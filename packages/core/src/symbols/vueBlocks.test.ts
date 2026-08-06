/**
 * The Vue `<script>` scanner.
 *
 * This is a hand-written scanner with no upstream, so its tests are the
 * only thing standing between it and silently wrong offsets. Two rules
 * under test throughout: it finds EVERY block (a component may carry
 * `<script setup>` beside a plain `<script>`, and this repo has three such
 * files), and an unrecognised shape yields nothing rather than a guess.
 */

import { describe, expect, test } from 'bun:test';
import { scanScriptBlocks } from './vueBlocks.js';

/** The text a range actually selects — the only assertion that matters. */
function body(content: string, index = 0): string {
  const range = scanScriptBlocks(content)[index];
  return content.slice(range.startIndex, range.endIndex);
}

describe('finding blocks', () => {
  test('finds a plain script block', () => {
    const sfc = '<template><p>hi</p></template>\n<script>\nconst a = 1;\n</script>\n';
    expect(scanScriptBlocks(sfc).length).toBe(1);
    expect(body(sfc).trim()).toBe('const a = 1;');
  });

  test('finds a script with attributes', () => {
    const sfc = '<script setup lang="ts">\nconst a = 1;\n</script>\n';
    expect(body(sfc).trim()).toBe('const a = 1;');
  });

  test('finds BOTH blocks when a component has two', () => {
    const sfc =
      '<script lang="ts">\nexport default { name: "X" };\n</script>\n' +
      '<script setup lang="ts">\nconst inner = 1;\n</script>\n';

    const ranges = scanScriptBlocks(sfc);
    expect(ranges.length).toBe(2);
    expect(body(sfc, 0)).toContain('export default');
    expect(body(sfc, 1)).toContain('const inner');
  });

  test('blocks are returned in document order and never overlap', () => {
    const sfc = '<script>\nconst a = 1;\n</script>\n<script setup>\nconst b = 2;\n</script>\n';
    const [first, second] = scanScriptBlocks(sfc);
    expect(first.endIndex).toBeLessThanOrEqual(second.startIndex);
  });

  test('lang="js" is still a block — the grammar choice is not made here', () => {
    expect(scanScriptBlocks('<script lang="js">\nconst a = 1;\n</script>').length).toBe(1);
  });
});

describe('positions are file-absolute', () => {
  test('a block after a template reports its real row', () => {
    const sfc = '<template>\n  <p>hi</p>\n</template>\n\n<script setup>\nconst a = 1;\n</script>\n';
    const [range] = scanScriptBlocks(sfc);
    // Line 5 (0-based row 4) is `<script setup>`; the body starts at its end.
    expect(range.startPosition.row).toBe(4);
  });

  test('the second block starts below the first', () => {
    const sfc = '<script>\nconst a = 1;\n</script>\n<script setup>\nconst b = 2;\n</script>\n';
    const [first, second] = scanScriptBlocks(sfc);
    expect(second.startPosition.row).toBeGreaterThan(first.startPosition.row);
  });

  test('CRLF does not shift rows', () => {
    const sfc = '<template>\r\n  <p>hi</p>\r\n</template>\r\n<script>\r\nconst a = 1;\r\n</script>\r\n';
    const [range] = scanScriptBlocks(sfc);
    expect(range.startPosition.row).toBe(3);
  });

  test('a non-ASCII prefix is counted in UTF-16 code units', () => {
    // An emoji is two code units; the index must agree with String.slice.
    const sfc = '<template>\n  <p>🎉 hi</p>\n</template>\n<script>\nconst a = 1;\n</script>\n';
    const [range] = scanScriptBlocks(sfc);
    expect(sfc.slice(range.startIndex, range.endIndex).trim()).toBe('const a = 1;');
  });
});

describe('failing toward nothing, never toward wrong', () => {
  test('a commented-out block is not a block', () => {
    const sfc = '<template><p>hi</p></template>\n<!--\n<script>\nconst a = 1;\n</script>\n-->\n';
    expect(scanScriptBlocks(sfc)).toEqual([]);
  });

  test('a real block beside a commented-out one finds only the real one', () => {
    const sfc =
      '<!-- <script>\nconst dead = 1;\n</script> -->\n<script setup>\nconst live = 2;\n</script>\n';
    const ranges = scanScriptBlocks(sfc);
    expect(ranges.length).toBe(1);
    expect(body(sfc)).toContain('const live');
  });

  test('an unterminated comment swallows what follows, as a browser would', () => {
    expect(scanScriptBlocks('<!--\n<script>\nconst a = 1;\n</script>\n')).toEqual([]);
  });

  test('a block with no closing tag is not a block', () => {
    expect(scanScriptBlocks('<script setup>\nconst a = 1;\n')).toEqual([]);
  });

  test('an empty body is not a block', () => {
    expect(scanScriptBlocks('<script setup>\n\n  \n</script>\n')).toEqual([]);
  });

  test('a template-only component yields nothing', () => {
    expect(scanScriptBlocks('<template><p>hi</p></template>\n<style>p{}</style>\n')).toEqual([]);
  });

  test('the word "script" in template text is not a block', () => {
    expect(scanScriptBlocks('<template><p>a script tag</p></template>\n')).toEqual([]);
  });

  test('an empty file yields nothing', () => {
    expect(scanScriptBlocks('')).toEqual([]);
  });
});
