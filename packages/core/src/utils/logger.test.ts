/**
 * The logger's line shape: what a person reading the journal or the log
 * file gets for each level, and how an error and its cause chain print.
 */

import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { debug, warn, error, setDebug, describeError } from './logger.js';

let lines: string[];
let stderrSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  lines = [];
  stderrSpy = spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
  setDebug(false);
});

afterEach(() => {
  stderrSpy.mockRestore();
  setDebug(false);
});

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /;

describe('logger lines', () => {
  test('every level starts with an ISO timestamp and the level name', () => {
    warn('something odd');
    error('something broke');
    setDebug(true);
    debug('a detail');

    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(ISO);
    expect(lines[0]).toEndWith(' warn  something odd\n');
    expect(lines[1]).toEndWith(' error something broke\n');
    expect(lines[2]).toEndWith(' debug a detail\n');
  });

  test('debug is silent unless enabled', () => {
    debug('hidden', new Error('also hidden'));
    expect(lines).toHaveLength(0);
  });

  test('debug prints an error like warn does: summarized, under the line', () => {
    setDebug(true);
    debug('HEAD unreadable', new Error('fatal: not a git repository\nsecond line'), { repo: '/r' });
    expect(lines[0]).toEndWith(
      ' debug HEAD unreadable repo=/r\n  Error: fatal: not a git repository\n  second line\n'
    );
  });

  test('context is appended as key=value pairs, quoted when it has spaces', () => {
    warn('Refresh failed', undefined, {
      repo: '/home/me/my proj',
      op: 'status',
      skipped: undefined,
      count: 3,
    });
    expect(lines[0]).toEndWith(' warn  Refresh failed repo="/home/me/my proj" op=status count=3\n');
  });

  test('error() prints the stack and the cause chain, indented', () => {
    const cause = new Error('spawn git ENOENT');
    const err = new Error('status failed', { cause });
    error('GET /repos/abc/status -> 500', err);

    const [head, ...rest] = lines[0].split('\n');
    expect(head).toEndWith(' error GET /repos/abc/status -> 500');
    expect(rest[0]).toBe('  Error: status failed');
    expect(rest.some((line) => /^\s+at /.test(line))).toBe(true);
    expect(rest).toContain('  caused by: Error: spawn git ENOENT');
  });

  test('warn() prints the error and its causes as one summary line each, no stack', () => {
    const err = new Error('push failed', { cause: new Error('rejected: non-fast-forward') });
    warn('POST /repos/abc/push -> 409 Push failed', err, { repo: '/r' });

    expect(lines[0]).toBe(
      lines[0].slice(0, 24) +
        ' warn  POST /repos/abc/push -> 409 Push failed repo=/r\n' +
        '  Error: push failed\n' +
        '  caused by: Error: rejected: non-fast-forward\n'
    );
  });

  test('a non-Error value is printed as is', () => {
    error('rejected with a string', 'plain string');
    expect(lines[0]).toEndWith(' error rejected with a string\n  plain string\n');
  });

  test('control characters in the message and context cannot forge a second line', () => {
    warn('Failed to stage evil\n2026-01-01T00:00:00.000Z error forged', undefined, {
      file: 'a\r\nb\tc\x1b[31m',
    });
    expect(lines).toHaveLength(1);
    expect(lines[0].split('\n')).toHaveLength(2); // the line and its trailing newline
    expect(lines[0]).toContain('Failed to stage evil\\n2026-01-01T00:00:00.000Z error forged');
    // Escaped before the quoting decision: nothing left to quote.
    expect(lines[0]).toEndWith(' file=a\\r\\nb\\tc\\x1b[31m\n');
  });

  test('credentials in URLs are scrubbed from the line and the error detail', () => {
    error('git push failed', new Error('fatal: unable to access https://user:s3cret@example.com/r.git'), {
      remote: 'ssh://deploy:pw@host/repo',
    });
    expect(lines[0]).toContain('remote=ssh://***@host/repo');
    expect(lines[0]).toContain('https://***@example.com/r.git');
    expect(lines[0]).not.toContain('s3cret');
    expect(lines[0]).not.toContain('deploy:pw');
  });

  test('describeError stops on a cause cycle', () => {
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    a.cause = b;
    const text = describeError(a, { stacks: false });
    expect(text.split('\n')).toHaveLength(10);
  });
});
