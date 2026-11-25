/**
 * PR drafts on disk: `<common git dir>/diffstalker/pr/<branch>/`.
 * See docs/work-page.md §3.
 *
 * The daemon writes only `top.md` and `adopted`. Agents write
 * `top.suggested.md` and `ai.md`; this module never writes or removes
 * those two. Every file is opened without following a symlink, must be a
 * regular file and at most MAX_DRAFT_BYTES: agents write here, so a link
 * or a FIFO must not be followed or block.
 *
 * A write runs as one synchronous block after its path check. The daemon
 * is one thread, so no other request can land between the version check
 * and the rename.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { READ_FLAGS } from '../utils/fdRead.js';
import * as logger from '../utils/logger.js';
import {
  DRAFT_ADOPTED_FILE,
  DRAFT_AI_FILE,
  DRAFT_DIR_SEGMENTS,
  DRAFT_FILE_NAMES,
  DRAFT_SUGGESTED_FILE,
  DRAFT_TOP_FILE,
  DRAFT_VERSION_ABSENT,
  MAX_DRAFT_BYTES,
  type DraftChangeEvent,
  type DraftFacts,
  type PrDraft,
} from '../types/work.js';

/** The branch name cannot have a draft. */
export class DraftBranchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DraftBranchError';
  }
}

/** A draft file is not a regular file, or is too large. */
export class DraftFileError extends Error {
  constructor(
    readonly file: string,
    message: string
  ) {
    super(message);
    this.name = 'DraftFileError';
  }
}

/** The draft changed since the caller read it, or adopt is not possible. */
export class DraftConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DraftConflictError';
  }
}

const MAX_BRANCH_LENGTH = 255;
const MAX_LIST_DIRS = 500;
const MAX_LIST_DEPTH = 8;

const READ_NOFOLLOW = READ_FLAGS | fs.constants.O_NOFOLLOW;

/** Why the name cannot have a draft, or null. Pure. */
export function checkDraftBranch(branch: string): string | null {
  if (branch.length === 0) return 'Branch name is empty';
  if (branch.length > MAX_BRANCH_LENGTH) return 'Branch name is too long';
  if (branch.startsWith('-')) return 'Branch name must not start with "-"';
  if (/[\x00-\x1f\x7f]/.test(branch)) return 'Branch name contains a control character';
  if (branch.includes('\\')) return 'Branch name contains a backslash';
  if (branch.startsWith('/') || branch.endsWith('/')) {
    return 'Branch name must not start or end with "/"';
  }
  for (const part of branch.split('/')) {
    if (part === '') return 'Branch name has an empty path component';
    if (part.startsWith('.')) return 'Branch name has a path component that starts with "."';
    if (part.endsWith('.lock')) return 'Branch name has a path component that ends in ".lock"';
    // Lowercased: on a case-insensitive disk `TOP.MD/` collides with `top.md`.
    if (DRAFT_FILE_NAMES.includes(part.toLowerCase())) {
      return `Branch name has a path component named like a draft file (${part})`;
    }
  }
  return null;
}

/** `<commonDir>/diffstalker/pr`. */
export function draftsRoot(commonDir: string): string {
  return path.join(commonDir, ...DRAFT_DIR_SEGMENTS);
}

function errnoOf(err: unknown): string | null {
  return (err as NodeJS.ErrnoException | null)?.code ?? null;
}

function isInside(target: string, root: string): boolean {
  return target.startsWith(root + path.sep);
}

/**
 * No existing directory between the common dir and `dir` is a symlink, so a
 * linked `diffstalker`, `pr` or `pr/feature` cannot carry a read or write
 * out. Stops at the first part that does not exist yet.
 */
function assertNoLinkBelow(commonDir: string, dir: string): void {
  const base = path.resolve(commonDir);
  let current = base;
  for (const part of path.relative(base, dir).split(path.sep)) {
    current = path.join(current, part);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (err) {
      const code = errnoOf(err);
      // Not made yet: nothing below it exists either.
      if (code === 'ENOENT' || code === 'ENOTDIR') return;
      throw err;
    }
    if (stat.isSymbolicLink()) {
      throw new DraftBranchError(`${path.relative(base, current)} is a symbolic link`);
    }
    if (!stat.isDirectory()) return;
  }
}

/** The branch's directory, checked. Creates nothing. Throws DraftBranchError. */
export async function resolveDraftDir(commonDir: string, branch: string): Promise<string> {
  const reason = checkDraftBranch(branch);
  if (reason !== null) throw new DraftBranchError(reason);
  const root = path.resolve(draftsRoot(commonDir));
  const dir = path.resolve(root, ...branch.split('/'));
  if (!isInside(dir, root)) throw new DraftBranchError('Branch name leaves the drafts directory');
  assertNoLinkBelow(commonDir, dir);
  return dir;
}

interface DraftFile {
  bytes: Buffer;
  mtimeMs: number;
}

type DraftBytes = Pick<DraftFile, 'bytes'>;

interface DraftFiles {
  top: DraftBytes | null;
  adopted: DraftBytes | null;
  suggested: DraftBytes | null;
  ai: DraftBytes | null;
}

function checkDraftStat(name: string, stat: fs.Stats): void {
  if (!stat.isFile()) throw new DraftFileError(name, `${name} is not a regular file`);
  if (stat.size > MAX_DRAFT_BYTES) {
    throw new DraftFileError(name, `${name} is larger than ${MAX_DRAFT_BYTES} bytes`);
  }
}

/**
 * Open a draft file without following a link, check it, and read it when
 * `read` is set (else `bytes` is empty). Null when there is no file.
 */
function openDraftFile(dir: string, name: string, read: boolean): DraftFile | null {
  let fd: number;
  try {
    fd = fs.openSync(path.join(dir, name), READ_NOFOLLOW);
  } catch (err) {
    const code = errnoOf(err);
    // No file is the normal state for three of the four.
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    if (code === 'ELOOP') throw new DraftFileError(name, `${name} is a symbolic link`);
    throw err;
  }
  try {
    const stat = fs.fstatSync(fd);
    checkDraftStat(name, stat);
    if (!read) return { bytes: Buffer.alloc(0), mtimeMs: stat.mtimeMs };
    const bytes = Buffer.alloc(stat.size);
    let filled = 0;
    while (filled < bytes.length) {
      const got = fs.readSync(fd, bytes, filled, bytes.length - filled, filled);
      if (got === 0) break;
      filled += got;
    }
    return {
      bytes: filled === bytes.length ? bytes : bytes.subarray(0, filled),
      mtimeMs: stat.mtimeMs,
    };
  } finally {
    fs.closeSync(fd);
  }
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function versionOf(top: DraftBytes | null): string {
  return top === null ? DRAFT_VERSION_ABSENT : sha256(top.bytes);
}

function textOf(file: DraftBytes | null): string | null {
  return file === null ? null : file.bytes.toString('utf8');
}

function isAdoptedUnedited(top: DraftBytes | null, adopted: DraftBytes | null): boolean {
  return (
    top !== null && adopted !== null && adopted.bytes.toString('utf8').trim() === sha256(top.bytes)
  );
}

/** All four files. Throws DraftFileError when one cannot be read. */
function readDraftFiles(dir: string): DraftFiles {
  return {
    top: openDraftFile(dir, DRAFT_TOP_FILE, true),
    adopted: openDraftFile(dir, DRAFT_ADOPTED_FILE, true),
    suggested: openDraftFile(dir, DRAFT_SUGGESTED_FILE, true),
    ai: openDraftFile(dir, DRAFT_AI_FILE, true),
  };
}

function toPrDraft(branch: string, files: DraftFiles): PrDraft {
  return {
    branch,
    top: textOf(files.top),
    suggested: textOf(files.suggested),
    ai: textOf(files.ai),
    adoptedUnedited: isAdoptedUnedited(files.top, files.adopted),
    version: versionOf(files.top),
  };
}

export async function readDraft(commonDir: string, branch: string): Promise<PrDraft> {
  return toPrDraft(branch, readDraftFiles(await resolveDraftDir(commonDir, branch)));
}

let tempCounter = 0;

/** Write a temp file beside the target and rename it into place. */
function writeAtomic(dir: string, name: string, data: string | Buffer): void {
  const temp = path.join(dir, `.${name}.${process.pid}.${++tempCounter}.tmp`);
  try {
    // 'wx': a file or link already at the temp name is an error, never followed.
    fs.writeFileSync(temp, data, { flag: 'wx' });
    fs.renameSync(temp, path.join(dir, name));
  } catch (err) {
    fs.rmSync(temp, { force: true });
    throw err;
  }
}

/** Make the branch's directory, then check again that no link is on the way. */
function ensureDraftDir(commonDir: string, dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  assertNoLinkBelow(commonDir, dir);
}

function removeIfPresent(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch (err) {
    // Already gone is what was asked for.
    if (errnoOf(err) !== 'ENOENT') throw err;
  }
}

/** Remove `dir` and its empty parents, up to but not including `root`. */
function removeEmptyDirs(root: string, dir: string): void {
  for (let current = dir; isInside(current, root); current = path.dirname(current)) {
    try {
      fs.rmdirSync(current);
    } catch (err) {
      const code = errnoOf(err);
      // Gone already: its parent may still be empty.
      if (code === 'ENOENT') continue;
      // Something else lives here (ai.md, a branch below it): stop.
      if (code === 'ENOTEMPTY' || code === 'EEXIST' || code === 'ENOTDIR') return;
      throw err;
    }
  }
}

/** The whole draft, read and version-checked before any write, so a bad file changes nothing. */
function readForWrite(dir: string, baseVersion: string): DraftFiles {
  const files = readDraftFiles(dir);
  if (versionOf(files.top) !== baseVersion) throw new DraftConflictError('Draft changed elsewhere');
  return files;
}

/**
 * Empty (after trim) `top` deletes top.md and adopted. Throws DraftConflictError.
 * The answer comes from what was read and written, never a read-back.
 */
export async function writeDraftTop(
  commonDir: string,
  branch: string,
  top: string,
  baseVersion: string
): Promise<PrDraft> {
  const dir = await resolveDraftDir(commonDir, branch);
  const files = readForWrite(dir, baseVersion);
  if (top.trim() === '') {
    removeIfPresent(path.join(dir, DRAFT_TOP_FILE));
    removeIfPresent(path.join(dir, DRAFT_ADOPTED_FILE));
    removeEmptyDirs(path.resolve(draftsRoot(commonDir)), dir);
    return toPrDraft(branch, { ...files, top: null, adopted: null });
  }
  const bytes = Buffer.from(top, 'utf8');
  ensureDraftDir(commonDir, dir);
  writeAtomic(dir, DRAFT_TOP_FILE, bytes);
  return toPrDraft(branch, { ...files, top: { bytes } });
}

/** Copy the suggestion into top.md and record its hash in `adopted`. */
export async function adoptSuggestion(
  commonDir: string,
  branch: string,
  baseVersion: string
): Promise<PrDraft> {
  const dir = await resolveDraftDir(commonDir, branch);
  const files = readForWrite(dir, baseVersion);
  if (files.top !== null && files.top.bytes.toString('utf8').trim() !== '') {
    throw new DraftConflictError('top.md is not empty');
  }
  const suggestion = files.suggested;
  if (suggestion === null || suggestion.bytes.toString('utf8').trim() === '') {
    throw new DraftConflictError('No suggestion to start from');
  }
  const adopted = Buffer.from(`${sha256(suggestion.bytes)}\n`);
  writeAtomic(dir, DRAFT_TOP_FILE, suggestion.bytes);
  writeAtomic(dir, DRAFT_ADOPTED_FILE, adopted);
  return toPrDraft(branch, { ...files, top: suggestion, adopted: { bytes: adopted } });
}

function byBranch(a: DraftFacts, b: DraftFacts): number {
  if (a.branch === b.branch) return 0;
  return a.branch < b.branch ? -1 : 1;
}

function hasText(file: DraftBytes | null): boolean {
  return file !== null && file.bytes.toString('utf8').trim() !== '';
}

/** The facts of one draft directory, or null when it holds no draft file. */
function draftFactsAt(dir: string, branch: string): DraftFacts | null {
  const top = openDraftFile(dir, DRAFT_TOP_FILE, true);
  const adopted = openDraftFile(dir, DRAFT_ADOPTED_FILE, true);
  const suggested = openDraftFile(dir, DRAFT_SUGGESTED_FILE, true);
  const ai = openDraftFile(dir, DRAFT_AI_FILE, true);
  const present = [top, adopted, suggested, ai].filter((f): f is DraftFile => f !== null);
  if (present.length === 0) return null;
  return {
    branch,
    hasTop: hasText(top),
    hasSuggested: hasText(suggested),
    hasAi: hasText(ai),
    top: textOf(top),
    adoptedUnedited: isAdoptedUnedited(top, adopted),
    mtime: Math.max(...present.map((f) => f.mtimeMs)),
  };
}

/** A draft's facts, or null; a draft with a file that cannot be read is logged and left out. */
function draftFactsOrSkip(dir: string, branch: string): DraftFacts | null {
  try {
    return draftFactsAt(dir, branch);
  } catch (err) {
    if (!(err instanceof DraftFileError) && errnoOf(err) === null) throw err;
    const file = err instanceof DraftFileError ? path.join(dir, err.file) : dir;
    logger.warn('Draft left out of the scan', err, { file });
    return null;
  }
}

/** A directory's entries, or null when it is gone or cannot be read (logged). */
async function readDraftsDir(dir: string): Promise<fs.Dirent[] | null> {
  try {
    return await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (err) {
    const code = errnoOf(err);
    // No drafts root yet, or a draft deleted while the walk ran.
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    if (code === null) throw err;
    logger.warn('Draft directory left out of the scan', err, { file: dir });
    return null;
  }
}

interface PendingDir {
  rel: string;
  depth: number;
}

/** The subdirectories to walk next. Links are not directories here, so none is followed. */
function childDirs(entries: fs.Dirent[], parent: PendingDir): PendingDir[] {
  if (parent.depth >= MAX_LIST_DEPTH) return [];
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      rel: parent.rel === '' ? entry.name : `${parent.rel}/${entry.name}`,
      depth: parent.depth + 1,
    }));
}

/** Below the root, holds a draft file, and names a branch that may have a draft. */
function isDraftDir(rel: string, entries: fs.Dirent[]): boolean {
  return (
    rel !== '' &&
    entries.some((e) => e.isFile() && DRAFT_FILE_NAMES.includes(e.name)) &&
    checkDraftBranch(rel) === null
  );
}

/** False, logged, when `diffstalker` or `diffstalker/pr` is a link. */
function draftsRootIsReal(commonDir: string): boolean {
  try {
    assertNoLinkBelow(commonDir, path.resolve(draftsRoot(commonDir)));
    return true;
  } catch (err) {
    if (!(err instanceof DraftBranchError)) throw err;
    logger.warn('Drafts left out of the scan', err, { file: draftsRoot(commonDir) });
    return false;
  }
}

/**
 * Every draft under the drafts root, sorted by branch. Links are not
 * followed; at most 500 directories, 8 levels deep. A draft or directory
 * that cannot be read is left out and logged.
 */
export async function listDrafts(commonDir: string): Promise<DraftFacts[]> {
  if (!draftsRootIsReal(commonDir)) return [];
  const root = draftsRoot(commonDir);
  const drafts: DraftFacts[] = [];
  const pending: PendingDir[] = [{ rel: '', depth: 0 }];
  for (let visited = 0; pending.length > 0 && visited < MAX_LIST_DIRS; visited++) {
    const current = pending.pop()!;
    const dir = path.join(root, current.rel);
    const entries = await readDraftsDir(dir);
    if (entries === null) continue;
    pending.push(...childDirs(entries, current));
    const facts = isDraftDir(current.rel, entries) ? draftFactsOrSkip(dir, current.rel) : null;
    if (facts !== null) drafts.push(facts);
  }
  return drafts.sort(byBranch);
}

const DRAFTS_PREFIX = `${DRAFT_DIR_SEGMENTS.join('/')}/`;

/** The event for a changed entry of the common dir, or null. `rel` is '/'-separated. Pure. */
export function draftChangeOfEntry(rel: string, isDir: boolean): DraftChangeEvent | null {
  if (rel === DRAFT_DIR_SEGMENTS[0] || rel === DRAFTS_PREFIX.slice(0, -1)) {
    return { branch: '', prefix: true };
  }
  if (!rel.startsWith(DRAFTS_PREFIX)) return null;
  const rest = rel.slice(DRAFTS_PREFIX.length);
  if (rest === '') return { branch: '', prefix: true };
  if (isDir) return { branch: rest, prefix: true };
  const slash = rest.lastIndexOf('/');
  if (slash <= 0) return null;
  if (!DRAFT_FILE_NAMES.includes(rest.slice(slash + 1))) return null;
  return { branch: rest.slice(0, slash), prefix: false };
}
