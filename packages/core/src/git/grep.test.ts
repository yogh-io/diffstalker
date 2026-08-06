/**
 * grepRepo against real git and real repos.
 *
 * The two fixtures that matter most are the ones an earlier draft of this
 * design got wrong, both reproduced before they were fixed:
 *
 * - a filename containing a newline, which shreds any parser that splits on
 *   `\n` before NUL;
 * - `grep.column=true`, a documented user config that inserts a FOURTH
 *   NUL field and silently shifts content into the line-number slot.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  grepRepo,
  grepArgs,
  parseGrepOutput,
  GrepQueryTooShortError,
  GREP_MAX_LINE_CHARS,
  GREP_MAX_PER_FILE,
  GREP_MIN_QUERY,
} from './grep.js';

let repo: string;

function git(args: string[], cwd = repo): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
  });
}

function write(rel: string, content: string | Buffer): void {
  const target = path.join(repo, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function commit(): void {
  git(['add', '-A']);
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'x']);
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-grep-'));
  git(['init', '-q', '.']);
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('argv', () => {
  test('the query is never argv-positional, so a leading dash is data', () => {
    const args = grepArgs('-foo');
    expect(args[args.indexOf('-foo') - 1]).toBe('-e');
  });

  test('carries every load-bearing flag', () => {
    const args = grepArgs('abc');
    for (const flag of [
      '-F',
      '-I',
      '-z',
      '-n',
      '--no-textconv',
      '--no-color',
      '--no-column',
      '--full-name',
      '--no-recurse-submodules',
      '--untracked',
      '--literal-pathspecs',
    ]) {
      expect(args).toContain(flag);
    }
    expect(args.slice(-2)).toEqual(['--', '.']);
  });

  test('smart-case: lowercase gets -i, any uppercase does not', () => {
    expect(grepArgs('abc')).toContain('-i');
    expect(grepArgs('Abc')).not.toContain('-i');
  });

  test('caps matches per file', () => {
    const args = grepArgs('abc');
    expect(args[args.indexOf('-m') + 1]).toBe(String(GREP_MAX_PER_FILE));
  });
});

describe('searching', () => {
  test('finds a match in a tracked file, with path and line', async () => {
    write('src/a.ts', 'one\ntwo needle here\nthree\n');
    commit();

    const { matches } = await grepRepo(repo, 'needle');
    expect(matches.length).toBe(1);
    expect(matches[0].path).toBe('src/a.ts');
    expect(matches[0].line).toBe(2);
    expect(matches[0].text).toBe('two needle here');
  });

  test('finds a match in an untracked file (the finder corpus)', async () => {
    write('tracked.txt', 'nothing\n');
    commit();
    write('fresh.txt', 'a needle appears\n');

    const paths = (await grepRepo(repo, 'needle')).matches.map((m) => m.path);
    expect(paths).toContain('fresh.txt');
  });

  test('honors .gitignore even with --untracked', async () => {
    write('.gitignore', 'secret/\n');
    commit();
    write('secret/hidden.txt', 'a needle in here\n');

    expect((await grepRepo(repo, 'needle')).matches).toEqual([]);
  });

  test('no match returns empty rather than throwing (git exits 1)', async () => {
    write('a.txt', 'nothing to see\n');
    commit();

    const result = await grepRepo(repo, 'absent-string');
    expect(result.matches).toEqual([]);
    expect(result.incomplete).toBe(false);
  });

  test('a literal query is never a regex', async () => {
    write('a.txt', 'literal a.c here\nand abc too\n');
    commit();

    const matches = (await grepRepo(repo, 'a.c')).matches;
    expect(matches.length).toBe(1);
    expect(matches[0].text).toContain('literal a.c');
  });

  test('a regex metacharacter query cannot blow up', async () => {
    write('a.txt', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaa\n');
    commit();

    // Would be catastrophic backtracking if it were ever compiled as a regex.
    const result = await grepRepo(repo, '(a+)+$');
    expect(result.matches).toEqual([]);
  });

  test('rejects a query shorter than the minimum', async () => {
    expect(grepRepo(repo, 'ab')).rejects.toThrow(GrepQueryTooShortError);
    expect(GREP_MIN_QUERY).toBe(3);
  });

  test('skips binary files', async () => {
    write('bin.dat', Buffer.from([0x00, 0x01, 0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0x00]));
    write('text.txt', 'needle in text\n');
    commit();

    const paths = (await grepRepo(repo, 'needle')).matches.map((m) => m.path);
    expect(paths).toEqual(['text.txt']);
  });

  test('truncates a very long line but still reports it', async () => {
    write('min.js', `${'x'.repeat(5000)}needle${'y'.repeat(5000)}\n`);
    commit();

    const [match] = (await grepRepo(repo, 'needle')).matches;
    expect(match.text.length).toBe(GREP_MAX_LINE_CHARS);
    expect(match.truncated).toBe(true);
  });
});

/**
 * The blockers. Each of these was reproduced against real git before the
 * parser was written; they are the reason it reads NUL-first.
 */
describe('hostile output shapes', () => {
  test('a filename containing a newline does not forge a record', async () => {
    write('we\nird.txt', 'has needle here\n');
    commit();

    const { matches } = await grepRepo(repo, 'needle');
    expect(matches.length).toBe(1);
    expect(matches[0].path).toBe('we\nird.txt');
    expect(matches[0].line).toBe(1);
    expect(matches[0].text).toBe('has needle here');
  });

  test('grep.column=true does not shift content into the line number', async () => {
    write('a.txt', 'alpha needle beta\n');
    commit();
    // A documented user config, settable globally or per repo.
    git(['config', 'grep.column', 'true']);

    const { matches } = await grepRepo(repo, 'needle');
    expect(matches.length).toBe(1);
    expect(matches[0].line).toBe(1);
    expect(matches[0].text).toBe('alpha needle beta');
  });

  test('color.grep cannot inject escape sequences into the payload', async () => {
    write('a.txt', 'alpha needle beta\n');
    commit();
    git(['config', 'color.grep', 'always']);

    const [match] = (await grepRepo(repo, 'needle')).matches;
    expect(match.text).toBe('alpha needle beta');
    expect(match.text).not.toContain('');
  });

  test('a NUL in content is dropped as binary even when git called it text', () => {
    // git's binary sniff only reads the first 8000 bytes, and a committed
    // .gitattributes `-text` overrides it outright — so this shape does reach
    // the parser in the wild. Fed directly: the parse layer is the bound.
    const out = Buffer.concat([
      Buffer.from('good.txt\0'),
      Buffer.from('1\0'),
      Buffer.from('clean needle line\n'),
      Buffer.from('bad.bin\0'),
      Buffer.from('2\0'),
      Buffer.from([0x6e, 0x65, 0x65, 0x64, 0x00, 0x6c, 0x65]),
      Buffer.from('\n'),
    ]);

    const result = parseGrepOutput(out);
    expect(result.matches.map((m) => m.path)).toEqual(['good.txt']);
    expect(result.binarySkipped).toBe(1);
  });

  test('a truncated final record is discarded, not half-parsed', () => {
    const out = Buffer.concat([
      Buffer.from('a.txt\0'),
      Buffer.from('1\0'),
      Buffer.from('complete line\n'),
      Buffer.from('b.txt\0'), // cut off mid-record
    ]);

    expect(parseGrepOutput(out).matches.map((m) => m.path)).toEqual(['a.txt']);
  });

  test('a non-numeric line number is skipped rather than becoming NaN', () => {
    const out = Buffer.concat([
      Buffer.from('a.txt\0'),
      Buffer.from('notanumber\0'),
      Buffer.from('some line\n'),
      Buffer.from('b.txt\0'),
      Buffer.from('7\0'),
      Buffer.from('good line\n'),
    ]);

    const { matches } = parseGrepOutput(out);
    expect(matches.length).toBe(1);
    expect(matches[0].line).toBe(7);
  });
});

describe('caps', () => {
  test('stops at the result limit and says so', () => {
    const records: Buffer[] = [];
    for (let i = 1; i <= 10; i++) {
      records.push(Buffer.from(`f${i}.txt\0${i}\0line ${i}\n`));
    }

    const result = parseGrepOutput(Buffer.concat(records), 4);
    expect(result.matches.length).toBe(4);
    expect(result.capped).toBe(true);
  });

  test('does not claim capped when everything fit', () => {
    const out = Buffer.from('a.txt\x001\x00only line\n');
    expect(parseGrepOutput(out, 10).capped).toBe(false);
  });

  test('caps matches per file through git itself', async () => {
    const lines = Array.from({ length: GREP_MAX_PER_FILE + 25 }, () => 'needle').join('\n');
    write('many.txt', `${lines}\n`);
    commit();

    const matches = (await grepRepo(repo, 'needle')).matches;
    expect(matches.length).toBe(GREP_MAX_PER_FILE);
  });
});
