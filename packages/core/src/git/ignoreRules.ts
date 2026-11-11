/**
 * The ignore rules a repo watcher applies, so it does not watch or refresh
 * for what git ignores: every .gitignore in the tree, the repo's
 * info/exclude and the user's core.excludesFile, in git's precedence.
 * Deciding what to watch is all they are for; `git status` stays the judge
 * of what is ignored.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ignore, { type Ignore } from 'ignore';
import { gitEnv } from './gitClient.js';
import { configHome } from '../utils/xdg.js';
import * as logger from '../utils/logger.js';

const execFileAsync = promisify(execFile);

const SLASH = '/'.charCodeAt(0);

/** A path relative to a directory below the root, or null when it is not below it. */
function relativeToDir(rel: string, dir: string): string | null {
  if (dir === '') return rel;
  if (rel.startsWith(dir) && rel.charCodeAt(dir.length) === SLASH) {
    return rel.slice(dir.length + 1);
  }
  return null;
}

interface RuleSource {
  /** Repo-relative directory the patterns are relative to; '' for the root. */
  dir: string;
  rules: Ignore;
}

export class IgnoreRules {
  /** Highest precedence first: the first source with a verdict decides. */
  constructor(private sources: RuleSource[]) {}

  /**
   * Whether git ignores a repo-relative path. isDir matters: a `build/`
   * rule ignores a directory named build and not a file of that name.
   * Like git, it judges each directory on the way down, so a deeper
   * `!build/` that re-includes a directory also re-includes what is in it.
   *
   * One edge errs the safe way: inside such a re-included directory, a
   * file a shallower rule matches by name (`*.log`) counts as not ignored
   * when a later rule in the same file matches its parent (`build/`), as
   * `ignore` reports only the last matching rule. That costs a refresh at
   * most, never a missed one.
   */
  ignores(rel: string, isDir: boolean): boolean {
    if (rel === '') return false;
    let slash = rel.indexOf('/');
    while (slash !== -1) {
      if (this.verdict(rel.slice(0, slash), true)) return true;
      slash = rel.indexOf('/', slash + 1);
    }
    return this.verdict(rel, isDir);
  }

  /** One path's own verdict, its parents aside: the first source with an opinion. */
  private verdict(rel: string, isDir: boolean): boolean {
    const slash = rel.lastIndexOf('/');
    const parent = slash === -1 ? '' : rel.slice(0, slash);
    for (const { dir, rules } of this.sources) {
      const sub = relativeToDir(rel, dir);
      if (sub === null) continue;
      const verdict = rules.checkIgnore(isDir ? `${sub}/` : sub);
      if (!verdict.ignored && !verdict.unignored) continue;
      // A rule matches what is inside a directory it matches. The parent's
      // own level already weighed it, so here it is no opinion.
      const parentSub = relativeToDir(parent, dir);
      if (parentSub && rules.checkIgnore(`${parentSub}/`).rule === verdict.rule) continue;
      return verdict.ignored;
    }
    return false;
  }
}

/** A rules file's text, or null when there is none. */
function readRulesFile(file: string, repoPath: string): string | null {
  try {
    return fs.readFileSync(file, 'utf-8');
  } catch (err) {
    // Most of these files are optional, so a missing one is the normal case.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn(`Failed to read ${file}`, err, { repo: repoPath });
    }
    return null;
  }
}

async function git(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd: repoPath,
    env: gitEnv(),
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

/** The user's global ignore file: core.excludesFile, else git's XDG default. */
async function excludesFilePath(repoPath: string): Promise<string | null> {
  try {
    const configured = (await git(repoPath, ['config', '--path', '--get', 'core.excludesFile'])).trim();
    if (configured) return path.resolve(repoPath, configured);
  } catch (err) {
    // `git config --get` exits 1 when the key is unset: git then uses its default.
    if ((err as { code?: unknown }).code !== 1) {
      logger.warn('git config core.excludesFile failed; global ignore rules are not applied', err, {
        repo: repoPath,
      });
      return null;
    }
  }
  return path.join(configHome(), 'git', 'ignore');
}

/** Every .gitignore below the root, by repo-relative directory. */
async function nestedGitignores(repoPath: string): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  let output: string;
  try {
    // --exclude-standard skips ignored directories (git reads no
    // .gitignore there). It also skips an untracked .gitignore that a rule
    // ignores; missing its rules only costs extra watches.
    output = await git(repoPath, [
      'ls-files',
      '-z',
      '--cached',
      '--others',
      '--exclude-standard',
      '**/.gitignore',
    ]);
  } catch (err) {
    logger.warn('git ls-files failed; nested .gitignore files are not applied', err, {
      repo: repoPath,
    });
    return found;
  }
  for (const entry of output.split('\0')) {
    if (!entry.endsWith('/.gitignore')) continue;
    const text = readRulesFile(path.join(repoPath, entry), repoPath);
    if (text !== null) found.set(path.posix.dirname(entry), text);
  }
  return found;
}

/**
 * Load a repo's ignore rules. commonDir is where info/exclude lives: the
 * repo's .git, or for a linked worktree the shared git dir.
 */
export async function loadIgnoreRules(repoPath: string, commonDir: string): Promise<IgnoreRules> {
  const [nested, excludesFile] = await Promise.all([
    nestedGitignores(repoPath),
    excludesFilePath(repoPath),
  ]);

  const sources: RuleSource[] = [...nested]
    .sort(([a], [b]) => b.split('/').length - a.split('/').length)
    .map(([dir, text]) => ({ dir, rules: ignore().add(text) }));

  const rootFiles = [
    path.join(repoPath, '.gitignore'),
    path.join(commonDir, 'info', 'exclude'),
    ...(excludesFile === null ? [] : [excludesFile]),
  ];
  for (const file of rootFiles) {
    const text = readRulesFile(file, repoPath);
    if (text !== null) sources.push({ dir: '', rules: ignore().add(text) });
  }
  return new IgnoreRules(sources);
}
