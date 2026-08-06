/**
 * Repo-wide content search, over `git grep`.
 *
 * **Spawned directly, never through simple-git.** `createGit` decodes stdout
 * as UTF-8, which replaces every invalid byte with U+FFFD — it cannot carry
 * repo bytes intact. The pattern here is `blob.ts`'s: execFile with
 * `encoding: 'buffer'`, an explicit timeout, an explicit byte budget, and the
 * same hardening prefix (no fsmonitor, no pager, no repo hooks).
 *
 * **Fixed strings only (`-F`).** No regex reaches git, ever. That is the whole
 * answer to ReDoS, and it is why there is no query syntax to grow.
 *
 * **The record parser reads NUL-first, and that order is load-bearing.**
 * Output is `path\0lineno\0content\n`, but neither delimiter is safe on its
 * own:
 *
 * - A path may contain a raw newline (`we\nird.txt` is a legal filename), so
 *   splitting the buffer on `\n` first shreds that record into garbage. Never
 *   "split the output into lines" — that is the obvious refactor, and it is
 *   the bug.
 * - `content` may contain a raw NUL, so `split('\0')` is wrong too. git's `-I`
 *   binary sniff only inspects the first 8000 bytes, and a committed
 *   `.gitattributes` saying `foo.bin -text diff` overrides it outright. There
 *   is no flag that disables in-tree attributes.
 *
 * So: from the cursor, take bytes to the next NUL as the path, bytes to the
 * next NUL as the line number, bytes to the next `\n` as the content — then
 * decode. `-I` is advisory; THIS layer is the real binary bound, and a record
 * whose content still contains a NUL is dropped as binary.
 *
 * `blob.ts:200-209` already compares NUL-delimited records as bytes for the
 * same reason.
 *
 * **Consumers must treat `text` as untrusted bytes.** It is arbitrary repo
 * content — C0 controls and ESC sequences included. `GREP_MAX_LINE_CHARS` is a
 * length cap, not a sanitizer. A terminal renderer must escape it (a blessed
 * `tags: true` box is corrupted by literal `{bold}`); a browser must not
 * render it as HTML.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gitEnv } from './gitClient.js';

const execFileAsync = promisify(execFile);

/** Shortest query we will run. One character scans the tree per keystroke. */
export const GREP_MIN_QUERY = 3;
/**
 * Matches kept per file, so one generated file cannot own the results.
 *
 * Enforced HERE, not with `git grep -m`: `--max-count` only landed in git
 * 2.38 (2022), and an older git answers "unknown switch" with exit 129,
 * which is neither "no matches" nor a kill — every search would surface as
 * a 500 on, say, Ubuntu 22.04. Counting in the parser works everywhere.
 */
export const GREP_MAX_PER_FILE = 20;

/**
 * Longest query we will run. Not a security bound (the query is never
 * argv-positional) — an argument list has an OS limit, and a megabyte of
 * pasted text should fail as a clear 400, not as E2BIG from execFile.
 */
export const GREP_MAX_QUERY = 500;
/** Total matches returned. */
export const GREP_MAX_RESULTS = 500;
/** Output budget. The child is killed at the cap. */
export const GREP_MAX_BYTES = 4 * 1024 * 1024;
/** A wedged git must not hold a request open. */
export const GREP_TIMEOUT_MS = 5000;
/** Longest line handed to a UI; a minified bundle line is not readable anyway. */
export const GREP_MAX_LINE_CHARS = 400;

/** Prefix on every git invocation. Same reasons as blob.ts. */
const GIT_PREFIX = [
  '-c',
  'core.fsmonitor=',
  '-c',
  'core.pager=cat',
  '-c',
  'core.hooksPath=/dev/null',
  '--literal-pathspecs',
];

export interface GrepMatch {
  /** Repo-relative path, as git reports it (`--full-name`). */
  path: string;
  /** 1-based line number. */
  line: number;
  /** The matched line. Untrusted repo bytes — see the module comment. */
  text: string;
  /** True when `text` was cut at GREP_MAX_LINE_CHARS. */
  truncated: boolean;
}

export interface GrepResult {
  matches: GrepMatch[];
  /** True when the result set hit GREP_MAX_RESULTS and more exist. */
  capped: boolean;
  /** True when git was killed at the byte or time budget. */
  incomplete: boolean;
  /** Records dropped because their content held a NUL (binary git missed). */
  binarySkipped: number;
}

export class GrepQueryTooShortError extends Error {
  constructor() {
    super(`Query must be at least ${GREP_MIN_QUERY} characters`);
    this.name = 'GrepQueryTooShortError';
  }
}

/**
 * A query git cannot take literally, or cannot take at all.
 *
 * NUL cannot cross an argv boundary — execFile throws a TypeError, which
 * would surface as a 500. A newline is worse than that: `git grep -F`
 * treats it as a PATTERN SEPARATOR, so "a\nb" quietly becomes "match a or
 * match b" and the endpoint's literal-text contract stops being true.
 * Both are refusals, not silent repairs.
 */
export class GrepQueryInvalidError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'GrepQueryInvalidError';
  }
}

const EMPTY: GrepResult = { matches: [], capped: false, incomplete: false, binarySkipped: 0 };

/**
 * Smart-case, implemented here because git grep has no such mode: a query
 * with no uppercase letter is case-insensitive. Same rule the file finder
 * uses, so the two feel alike.
 */
function isCaseInsensitive(query: string): boolean {
  return query === query.toLowerCase();
}

function decode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('utf8');
}

/**
 * Parse `path\0lineno\0content\n` records. See the module comment for why
 * this walks NUL-first instead of splitting.
 */
/** One `path\0lineno\0content\n` record, as raw byte slices. */
interface RawRecord {
  pathBytes: Uint8Array;
  lineBytes: Uint8Array;
  contentBytes: Uint8Array;
  /** Where the next record starts. */
  next: number;
}

/**
 * Read one record from `cursor`, NUL-first. Returns null when the tail is
 * truncated — a half record is discarded, never half-parsed.
 */
function readRecord(out: Buffer, cursor: number): RawRecord | null {
  const pathEnd = out.indexOf(0, cursor);
  if (pathEnd === -1) return null;
  const lineEnd = out.indexOf(0, pathEnd + 1);
  if (lineEnd === -1) return null;
  let contentEnd = out.indexOf(0x0a, lineEnd + 1);
  if (contentEnd === -1) contentEnd = out.length;

  return {
    pathBytes: out.subarray(cursor, pathEnd),
    lineBytes: out.subarray(pathEnd + 1, lineEnd),
    contentBytes: out.subarray(lineEnd + 1, contentEnd),
    next: contentEnd + 1,
  };
}

/**
 * Parse `path\0lineno\0content\n` records. See the module comment for why
 * this walks NUL-first instead of splitting.
 */
export function parseGrepOutput(out: Buffer, limit = GREP_MAX_RESULTS): GrepResult {
  const matches: GrepMatch[] = [];
  const perFile = new Map<string, number>();
  let binarySkipped = 0;
  let capped = false;
  let cursor = 0;

  while (cursor < out.length) {
    const record = readRecord(out, cursor);
    if (record === null) break;
    cursor = record.next;

    // git was wrong about this file being text. -I is advisory; this is the
    // real binary bound.
    if (record.contentBytes.includes(0)) {
      binarySkipped += 1;
      continue;
    }

    const line = Number.parseInt(decode(record.lineBytes), 10);
    if (!Number.isSafeInteger(line) || line < 1) continue;

    if (matches.length >= limit) {
      capped = true;
      break;
    }

    const filePath = decode(record.pathBytes);
    const seen = perFile.get(filePath) ?? 0;
    if (seen >= GREP_MAX_PER_FILE) {
      capped = true;
      continue;
    }
    perFile.set(filePath, seen + 1);

    const full = decode(record.contentBytes);
    const truncated = full.length > GREP_MAX_LINE_CHARS;
    matches.push({
      path: filePath,
      line,
      text: truncated ? full.slice(0, GREP_MAX_LINE_CHARS) : full,
      truncated,
    });
  }

  return { matches, capped, incomplete: false, binarySkipped };
}

/** Build the argv. Exported so a test can assert every load-bearing flag. */
export function grepArgs(query: string): string[] {
  return [
    ...GIT_PREFIX,
    'grep',
    '--no-textconv', // no repo-committed textconv program runs
    '--no-recurse-submodules',
    '--full-name',
    '--no-color', // a repo-local color.grep cannot inject SGR into the payload
    '--no-column', // grep.column=true would add a 4th NUL field and shift content
    '-I', // skip binaries (advisory — the parser is the real bound)
    '-n',
    '-z',
    '-F', // fixed strings only: no regex ever reaches git
    ...(isCaseInsensitive(query) ? ['-i'] : []),
    '-e',
    query, // never argv-positional, so a leading "-" is data
    '--untracked', // same corpus as the finder; still honors .gitignore
    '--',
    '.',
  ];
}

/**
 * Search `repoPath` for the literal `query`.
 *
 * Never throws for a search that simply found nothing (git grep exits 1),
 * and never throws for a killed child — a timeout or byte-budget kill comes
 * back as `incomplete` with whatever was already parsed.
 */
export async function grepRepo(repoPath: string, query: string): Promise<GrepResult> {
  if (query.length < GREP_MIN_QUERY) throw new GrepQueryTooShortError();
  if (query.length > GREP_MAX_QUERY) {
    throw new GrepQueryInvalidError(`Query must be at most ${GREP_MAX_QUERY} characters`);
  }
  if (query.includes('\0')) throw new GrepQueryInvalidError('Query cannot contain a NUL byte');
  if (query.includes('\n')) {
    throw new GrepQueryInvalidError('Query cannot span lines — this searches for literal text');
  }

  try {
    const { stdout } = await execFileAsync('git', grepArgs(query), {
      cwd: repoPath,
      env: gitEnv(),
      // The only setting that keeps repo bytes intact; utf8 would replace
      // every invalid byte with U+FFFD.
      encoding: 'buffer',
      maxBuffer: GREP_MAX_BYTES,
      timeout: GREP_TIMEOUT_MS,
      windowsHide: true,
    });
    return parseGrepOutput(stdout as unknown as Buffer);
  } catch (err) {
    const e = err as { code?: number | string; killed?: boolean; stdout?: Buffer };
    // Exit 1 is "no matches", which is not an error.
    if (e.code === 1) return EMPTY;
    // Killed at the time or byte budget: keep what we got, say it is
    // partial. The maxBuffer overflow does NOT set `killed` and reports its
    // own code — checking only `killed` let a single multi-MB minified line
    // turn every query matching it into a 500.
    if (e.killed === true || e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      const partial = e.stdout ? parseGrepOutput(e.stdout) : EMPTY;
      return { ...partial, incomplete: true };
    }
    throw err;
  }
}
