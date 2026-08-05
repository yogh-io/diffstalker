/**
 * The funcname drivers, verified against real git.
 *
 * git ignores an unknown diff driver silently, so a typo in DIFF_DRIVERS
 * would be invisible — the header would just quietly stay wrong. These
 * tests build a real repo per language and assert the hunk header
 * actually names the inner function, which is the only evidence that a
 * driver both exists and got applied.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  DIFF_DRIVERS,
  attributesText,
  attributesFilePath,
  resetAttributesFileCache,
} from './diffAttributes.js';
import { createGit } from './gitClient.js';

let repo: string;
let attributesFile: string;

function git(args: string[]): string {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
  });
}

/** The `@@ … @@ <context>` text git produces for a one-line edit. */
function hunkContext(file: string, withDrivers: boolean): string {
  const args = withDrivers ? ['-c', `core.attributesFile=${attributesFile}`] : [];
  const diff = git([...args, 'diff', '-U1', '--', file]);
  const header = diff.split('\n').find((line) => line.startsWith('@@')) ?? '';
  return header.replace(/^@@[^@]*@@\s?/, '');
}

/** Commit `before`, then edit the marked line to make a one-line hunk. */
function fixture(file: string, before: string, from: string, to: string): void {
  fs.writeFileSync(path.join(repo, file), before);
  git(['add', '-A']);
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', `add ${file}`]);
  fs.writeFileSync(path.join(repo, file), before.replace(from, to));
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-attrs-'));
  git(['init', '-q', '.']);
  attributesFile = path.join(repo, 'attrs');
  fs.writeFileSync(attributesFile, attributesText());
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
  resetAttributesFileCache();
});

describe('the generated attributes file', () => {
  test('maps every glob to a driver, one per line', () => {
    const lines = attributesText()
      .split('\n')
      .filter((line) => line !== '' && !line.startsWith('#'));
    expect(lines.length).toBe(DIFF_DRIVERS.length);
    for (const line of lines) expect(line).toMatch(/^\S+ diff=[a-z]+$/);
  });

  test('names no driver twice for one glob', () => {
    const globs = DIFF_DRIVERS.map(([glob]) => glob);
    expect(new Set(globs).size).toBe(globs.length);
  });

  test('is written to the cache dir and reused', () => {
    const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-cache-'));
    const previous = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = cache;
    try {
      resetAttributesFileCache();
      const first = attributesFilePath();
      expect(first).not.toBeNull();
      expect(fs.readFileSync(first as string, 'utf8')).toBe(attributesText());
      expect(attributesFilePath()).toBe(first);
    } finally {
      if (previous === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = previous;
      resetAttributesFileCache();
      fs.rmSync(cache, { recursive: true, force: true });
    }
  });

  test('rewrites the file when the driver table changed', () => {
    const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-cache-'));
    const previous = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = cache;
    try {
      const target = path.join(cache, 'diffstalker', 'funcname.gitattributes');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, '# stale from an older version\n');
      resetAttributesFileCache();
      attributesFilePath();
      expect(fs.readFileSync(target, 'utf8')).toBe(attributesText());
    } finally {
      if (previous === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = previous;
      resetAttributesFileCache();
      fs.rmSync(cache, { recursive: true, force: true });
    }
  });
});

describe('drivers actually change git output', () => {
  test('python: the enclosing def, not the enclosing class', () => {
    fixture(
      'm.py',
      'class Widget:\n    def render(self):\n        a = 1\n        b = 2\n        c = 3\n        return a\n',
      '        b = 2',
      '        b = 99'
    );
    expect(hunkContext('m.py', false)).toBe('class Widget:');
    expect(hunkContext('m.py', true)).toBe('def render(self):');
  });

  test('java: the enclosing method, not the enclosing class', () => {
    fixture(
      'M.java',
      'public class Widget {\n  public void render() {\n    int a = 1;\n    int b = 2;\n    int c = 3;\n  }\n}\n',
      '    int b = 2;',
      '    int b = 99;'
    );
    expect(hunkContext('M.java', false)).toBe('public class Widget {');
    expect(hunkContext('M.java', true)).toBe('public void render() {');
  });

  test('ruby: the enclosing def', () => {
    fixture(
      'm.rb',
      'class Widget\n  def render\n    a = 1\n    b = 2\n    c = 3\n  end\nend\n',
      '    b = 2',
      '    b = 99'
    );
    expect(hunkContext('m.rb', true)).toBe('def render');
  });

  test('go: the enclosing func', () => {
    fixture(
      'm.go',
      'package main\n\nfunc render() int {\n\ta := 1\n\tb := 2\n\tc := 3\n\treturn a\n}\n',
      '\tb := 2',
      '\tb := 99'
    );
    expect(hunkContext('m.go', true)).toBe('func render() int {');
  });

  test('rust: the enclosing fn', () => {
    fixture(
      'm.rs',
      'impl Widget {\n    fn render(&self) -> i32 {\n        let a = 1;\n        let b = 2;\n        let c = 3;\n        a\n    }\n}\n',
      '        let b = 2;',
      '        let b = 99;'
    );
    expect(hunkContext('m.rs', true)).toBe('fn render(&self) -> i32 {');
  });
});

/**
 * The limitation, pinned as a test so it cannot be quietly forgotten and
 * so nobody re-attempts the borrowed-driver idea. git has no TypeScript
 * driver; this is what tree-sitter is for.
 */
describe('what this does NOT fix', () => {
  test('typescript is unchanged — git ships no driver for it', () => {
    fixture(
      't.ts',
      'export class Widget {\n  render(): number {\n    const a = 1;\n    const b = 2;\n    const c = 3;\n    return a;\n  }\n}\n',
      '    const b = 2;',
      '    const b = 99;'
    );
    expect(hunkContext('t.ts', true)).toBe(hunkContext('t.ts', false));
    expect(hunkContext('t.ts', true)).toBe('export class Widget {');
  });

  test('no glob in the table claims a .ts, .js, .vue or .tsx file', () => {
    const claimed = DIFF_DRIVERS.map(([glob]) => glob);
    for (const ext of ['*.ts', '*.tsx', '*.js', '*.jsx', '*.mjs', '*.vue']) {
      expect(claimed).not.toContain(ext);
    }
  });
});

/**
 * The wiring, not just the behaviour: everything above proves git does
 * the right thing GIVEN the config. This proves createGit actually passes
 * it — the step that could silently be dropped in a refactor and leave
 * every test above still green.
 */
describe('createGit passes the attributes file', () => {
  test('a diff through createGit gets the improved funcname', async () => {
    fixture(
      'm.py',
      'class Widget:\n    def render(self):\n        a = 1\n        b = 2\n        c = 3\n        return a\n',
      '        b = 2',
      '        b = 99'
    );

    const diff = await createGit(repo).diff(['-U1', '--', 'm.py']);
    const header = diff.split('\n').find((line) => line.startsWith('@@')) ?? '';
    expect(header).toContain('def render(self):');
  });
});

/**
 * The file is the LOWEST-priority attributes source. A repo that has its
 * own opinion must keep it — we are filling in a default, not overriding.
 */
describe('precedence', () => {
  test("a repo's own .gitattributes wins", () => {
    fixture(
      'm.py',
      'class Widget:\n    def render(self):\n        a = 1\n        b = 2\n        c = 3\n        return a\n',
      '        b = 2',
      '        b = 99'
    );
    fs.writeFileSync(path.join(repo, '.gitattributes'), '*.py diff=cpp\n');
    // cpp's regex does not match Python's `def`, so the header falls back
    // to the default guess — proving OUR python driver did not win.
    expect(hunkContext('m.py', true)).not.toBe('def render(self):');
  });
});
