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
  userHasAttributesFile,
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

/**
 * The injection is skipped when the USER has per-user gitattributes, so
 * every test here has to pin that answer — otherwise the suite passes or
 * fails depending on whose machine it runs on.
 */
let configHome: string;
let savedConfigHome: string | undefined;
let savedGlobalConfig: string | undefined;

function pinNoUserAttributes(): void {
  savedConfigHome = process.env.XDG_CONFIG_HOME;
  savedGlobalConfig = process.env.GIT_CONFIG_GLOBAL;
  configHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-cfg-'));
  process.env.XDG_CONFIG_HOME = configHome;
  process.env.GIT_CONFIG_GLOBAL = path.join(configHome, 'gitconfig');
  fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, '');
  resetAttributesFileCache();
}

function restoreUserAttributes(): void {
  if (savedConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedConfigHome;
  if (savedGlobalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = savedGlobalConfig;
  fs.rmSync(configHome, { recursive: true, force: true });
  resetAttributesFileCache();
}

beforeEach(() => {
  pinNoUserAttributes();
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-attrs-'));
  git(['init', '-q', '.']);
  attributesFile = path.join(repo, 'attrs');
  fs.writeFileSync(attributesFile, attributesText());
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
  restoreUserAttributes();
});

/**
 * `-c core.attributesFile` has the HIGHEST config priority, so injecting it
 * replaces the user's own per-user attributes rather than sitting under
 * them — dropping their textconv, merge and `-text` rules along with their
 * funcname ones. So we only inject when they have none.
 */
describe('never evicting the user\'s own attributes', () => {
  test('injects when the user has no per-user attributes', () => {
    expect(userHasAttributesFile()).toBe(false);
    expect(attributesFilePath()).not.toBeNull();
  });

  test('backs off when the XDG default attributes file exists', () => {
    fs.mkdirSync(path.join(configHome, 'git'), { recursive: true });
    fs.writeFileSync(path.join(configHome, 'git', 'attributes'), '*.zz diff=python\n');
    resetAttributesFileCache();

    expect(userHasAttributesFile()).toBe(true);
    expect(attributesFilePath()).toBeNull();
  });

  test('backs off when core.attributesFile is configured', () => {
    const theirs = path.join(configHome, 'mine.attributes');
    fs.writeFileSync(theirs, '*.zz diff=python\n');
    fs.writeFileSync(
      process.env.GIT_CONFIG_GLOBAL as string,
      `[core]\n\tattributesFile = ${theirs}\n`
    );
    resetAttributesFileCache();

    expect(userHasAttributesFile()).toBe(true);
    expect(attributesFilePath()).toBeNull();
  });

  test('a user driver assignment still applies through createGit', async () => {
    // The regression this guards: our file used to displace theirs, so
    // their rule stopped working the moment diffstalker ran the diff.
    const theirs = path.join(configHome, 'mine.attributes');
    fs.writeFileSync(theirs, '*.py diff=python\n');
    fs.writeFileSync(
      process.env.GIT_CONFIG_GLOBAL as string,
      `[core]\n\tattributesFile = ${theirs}\n`
    );
    resetAttributesFileCache();

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

/**
 * The idle timeout, and why it is not one number.
 *
 * `timeout: { block }` measures silence, and git is silent for as long as
 * a pre-commit hook runs or a pack is negotiated — it only writes progress
 * to a TTY, and simple-git spawns with pipes. A single short budget killed
 * commits mid-hook; this repo's own pre-commit takes about 24 seconds.
 */
describe('git idle timeout', () => {
  test('a commit survives a hook that is silent past the short budget', async () => {
    fs.writeFileSync(path.join(repo, 'a.txt'), 'x\n');
    git(['add', '-A']);

    const hooks = path.join(repo, '.git', 'hooks');
    fs.mkdirSync(hooks, { recursive: true });
    const hook = path.join(hooks, 'pre-commit');
    // Comfortably past the 10s plumbing budget, well under the long one.
    fs.writeFileSync(hook, '#!/bin/sh\nsleep 12\nexit 0\n');
    // Owner-only: the hook just has to be executable by this test.
    fs.chmodSync(hook, 0o700);

    await createGit(repo, { longRunning: true }).raw([
      '-c',
      'user.email=t@t',
      '-c',
      'user.name=t',
      'commit',
      '-m',
      'slow hook',
    ]);

    expect(git(['log', '--oneline']).trim()).toContain('slow hook');
  }, 30_000);
});
