/**
 * The watcher's ignore rules against what git itself says: precedence
 * between nested and root .gitignore files, directory-only rules,
 * info/exclude and the global excludes file.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadIgnoreRules, type IgnoreRules } from './ignoreRules.js';
import { createFixtureRepo, removeFixtureRepo, writeFixtureFile, gitExec } from './test-helpers.js';

const REPO_NAME = 'ignore-rules-test';

describe('loadIgnoreRules', () => {
  let repoPath: string;
  let rules: IgnoreRules;

  /** git's own verdict, for the cases a test checks against it. */
  function gitIgnores(rel: string): boolean {
    try {
      gitExec(repoPath, `check-ignore -q --no-index ${rel}`);
      return true;
    } catch {
      return false; // exit 1: not ignored
    }
  }

  beforeAll(async () => {
    removeFixtureRepo(REPO_NAME);
    repoPath = createFixtureRepo(REPO_NAME);
    writeFixtureFile(repoPath, '.gitignore', '*.log\nbuild/\nout\n');
    writeFixtureFile(repoPath, 'keep/.gitignore', '!important.log\n');
    writeFixtureFile(repoPath, 'deep/.gitignore', '*.tmp\n');
    writeFixtureFile(repoPath, 'pkg/.gitignore', '!build/\n');
    fs.appendFileSync(path.join(repoPath, '.git', 'info', 'exclude'), 'scratch/\n');
    const globalIgnore = path.join(repoPath, '.git', 'test-global-ignore');
    fs.writeFileSync(globalIgnore, 'worktrees/\n*.swp\n');
    gitExec(repoPath, `config core.excludesFile ${globalIgnore}`);
    gitExec(repoPath, 'add -A');
    gitExec(repoPath, 'commit -m "rules"');
    rules = await loadIgnoreRules(repoPath, path.join(repoPath, '.git'));
  });

  afterAll(() => {
    removeFixtureRepo(REPO_NAME);
  });

  test('a directory-only rule ignores the directory and not a file of that name', () => {
    expect(rules.ignores('build', true)).toBe(true);
    expect(rules.ignores('build', false)).toBe(false);
    expect(rules.ignores('build/x.txt', false)).toBe(true);
  });

  test('a rule without a slash ignores a file and a directory alike', () => {
    expect(rules.ignores('out', false)).toBe(true);
    expect(rules.ignores('out', true)).toBe(true);
  });

  test('a nested negation overrides the root rule below its directory only', () => {
    expect(rules.ignores('keep/important.log', false)).toBe(false);
    expect(rules.ignores('important.log', false)).toBe(true);
    expect(rules.ignores('keep/other.log', false)).toBe(true);
    expect(gitIgnores('keep/important.log')).toBe(false);
  });

  test('a nested negation re-includes an ignored directory and what is in it', () => {
    expect(rules.ignores('pkg/build', true)).toBe(false);
    expect(rules.ignores('pkg/build/out.js', false)).toBe(false);
    expect(gitIgnores('pkg/build/out.js')).toBe(false);
    expect(rules.ignores('build/out.js', false)).toBe(true);
  });

  test('a nested rule does not reach above its directory', () => {
    expect(rules.ignores('deep/a.tmp', false)).toBe(true);
    expect(rules.ignores('a.tmp', false)).toBe(false);
  });

  test('info/exclude and the global excludes file apply', () => {
    expect(rules.ignores('scratch', true)).toBe(true);
    expect(rules.ignores('worktrees', true)).toBe(true);
    expect(rules.ignores('notes.swp', false)).toBe(true);
    expect(gitIgnores('worktrees/feat-x')).toBe(true);
  });

  test('every verdict matches git check-ignore', () => {
    const cases: [string, boolean][] = [
      ['build', true],
      ['build', false],
      ['build/x.txt', false],
      ['src/build', true],
      ['pkg/build', true],
      ['pkg/build/out.js', false],
      ['keep/important.log', false],
      ['keep/other.log', false],
      ['deep/a.tmp', false],
      ['deep/sub/b.tmp', false],
      ['a.tmp', false],
      ['out', false],
      ['src/out', true],
      ['src/out/x.js', false],
      ['scratch', true],
      ['scratch/notes.md', false],
      ['worktrees/feat-x/a.txt', false],
      ['notes.swp', false],
      ['src/index.ts', false],
    ];
    for (const [rel, isDir] of cases) {
      expect([rel, isDir, rules.ignores(rel, isDir)]).toEqual([
        rel,
        isDir,
        gitIgnores(isDir ? `${rel}/` : rel),
      ]);
    }
  });

  test('inside a re-included directory the one known deviation errs toward watching', () => {
    // git ignores it (`*.log`); the rules miss that behind `build/`, the
    // later rule in the root file, which matches the parent. See ignores().
    expect(gitIgnores('pkg/build/deeper/a.log')).toBe(true);
    expect(rules.ignores('pkg/build/deeper/a.log', false)).toBe(false);
  });

  test('plain paths are not ignored', () => {
    expect(rules.ignores('src', true)).toBe(false);
    expect(rules.ignores('src/index.ts', false)).toBe(false);
  });
});
