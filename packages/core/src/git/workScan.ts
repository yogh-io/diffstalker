/**
 * What one repo holds, for the Work page: worktrees, local branches and
 * whether they were pushed, the GitHub identities of its remotes, and its
 * PR drafts. Facts only; the page decides what is work
 * (docs/work-page.md §5.1).
 *
 * Every git spawn goes through the worktree listing's pool, so a scan of
 * forty repos does not block other requests. Git runs with optional locks
 * off, so a scan never rewrites an index.
 *
 * A plain file edit moves no HEAD or reflog, so a worktree being edited
 * right now can look months old by `lastActivity`. `changedAt` is the
 * newest mtime of its uncommitted paths, from at most MAX_CHANGED_STATS
 * lstats per worktree.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { GIT_PREFIX, execGitBytes } from './gitClient.js';
import { mainlinesOf, type RemoteRef } from './diff.js';
import {
  countNotOn,
  listWorktreesRaw,
  resolveGitDirs,
  runGitPooled,
  withBaseCounts,
  type RawWorktreeInfo,
  type WorktreeWithBase,
} from './worktree.js';
import { listDrafts } from './prDraft.js';
import { loadBaseBranchChoices } from '../utils/baseBranchCache.js';
import { githubIdentity, parseGithubRemote } from '../utils/githubRemote.js';
import * as logger from '../utils/logger.js';
import type { WorkBranch, WorkRepoFacts, WorkWorktree } from '../types/work.js';

/** At most this many local branches per repo. */
export const MAX_WORK_BRANCHES = 500;

/** At most this many uncommitted paths per worktree are read for `changedAt`. */
export const MAX_CHANGED_STATS = 200;

const STATUS_MAX_BYTES = 16 * 1024 * 1024;
const REFS_MAX_BYTES = 16 * 1024 * 1024;
const SMALL_MAX_BYTES = 1024 * 1024;

const LOCAL_PREFIX = 'refs/heads/';
const REMOTE_PREFIX = 'refs/remotes/';

/** A copy that shares no memory with the git output it was cut from. */
function owned(text: string): string {
  return Buffer.from(text, 'utf8').toString('utf8');
}

function git(cwd: string, args: string[], maxBuffer: number): Promise<string> {
  return runGitPooled(async () =>
    (await execGitBytes(cwd, [...GIT_PREFIX, ...args], maxBuffer)).toString('utf8')
  );
}

/** One path per entry of `git status --porcelain -z` output, relative to the worktree. Pure. */
export function porcelainPaths(out: string): string[] {
  const fields = out.split('\0');
  const paths: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (field.length < 3) continue;
    paths.push(field.slice(3));
    // A rename or copy is followed by its old path, which is not an entry.
    if (/[RC]/.test(field.slice(0, 2))) i++;
  }
  return paths;
}

/** A path status lists but that is not on disk: a deleted file, or a parent that became a file. */
function isExpectedMiss(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** Newest mtime of the first MAX_CHANGED_STATS paths; null when none could be read. */
async function newestMtime(worktreePath: string, paths: readonly string[]): Promise<number | null> {
  const files = paths.slice(0, MAX_CHANGED_STATS).map((rel) => path.join(worktreePath, rel));
  const stats = await Promise.allSettled(files.map((file) => fs.promises.lstat(file)));
  let newest: number | null = null;
  let failure: { file: string; err: unknown } | null = null;
  for (let i = 0; i < stats.length; i++) {
    const result = stats[i];
    if (result.status === 'fulfilled') {
      if (newest === null || result.value.mtimeMs > newest) newest = result.value.mtimeMs;
    } else if (!isExpectedMiss(result.reason) && failure === null) {
      failure = { file: files[i], err: result.reason };
    }
  }
  if (failure !== null) {
    logger.warn('Work scan: cannot read a changed file', failure.err, {
      worktree: worktreePath,
      file: failure.file,
    });
  }
  return newest;
}

interface WorktreeChanges {
  uncommitted: number | null;
  changedAt: number | null;
}

async function worktreeChanges(worktree: RawWorktreeInfo): Promise<WorktreeChanges> {
  if (worktree.isBare || !fs.existsSync(worktree.path))
    return { uncommitted: null, changedAt: null };
  let out: string;
  try {
    out = await git(
      worktree.path,
      ['status', '--porcelain', '-z', '--untracked-files=all'],
      STATUS_MAX_BYTES
    );
  } catch (err) {
    logger.warn('Work scan: status failed', err, { worktree: worktree.path });
    return { uncommitted: null, changedAt: null };
  }
  const paths = porcelainPaths(out);
  if (paths.length === 0) return { uncommitted: 0, changedAt: null };
  // The lstats take a slot of the git pool, so a scan's file reads share its budget.
  const changedAt = await runGitPooled(() => newestMtime(worktree.path, paths));
  return { uncommitted: paths.length, changedAt };
}

/** The label for a repo: its main worktree's name, or the bare dir's parent for `.bare`. */
function repoName(main: RawWorktreeInfo): string {
  const base = path.basename(main.path);
  return main.isBare && base.startsWith('.') ? path.basename(path.dirname(main.path)) : base;
}

interface Refs {
  /** Local branch name to tip, sorted by name. */
  locals: Array<[string, string]>;
  /** Branch name to the tips of its remote-tracking copies. */
  copies: Map<string, string[]>;
  /** Every ref under `refs/remotes/` by full name, symrefs too: the mainlines come from these. */
  remotes: Map<string, RemoteRef>;
}

function compareNames(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

async function readRefs(root: string): Promise<Refs> {
  const out = await git(
    root,
    ['for-each-ref', '--format=%(objectname) %(refname) %(symref)', 'refs/heads', 'refs/remotes'],
    REFS_MAX_BYTES
  );
  const locals: Array<[string, string]> = [];
  const copies = new Map<string, string[]>();
  const remotes = new Map<string, RemoteRef>();
  for (const line of out.split('\n')) {
    if (!line) continue;
    // A ref name cannot hold a space, so the split is exact.
    const [tip, refname, symref = ''] = line.split(' ');
    if (refname.startsWith(REMOTE_PREFIX)) remotes.set(refname, { commit: tip, symref });
    if (symref) continue;
    if (refname.startsWith(LOCAL_PREFIX)) {
      locals.push([owned(refname.slice(LOCAL_PREFIX.length)), owned(tip)]);
    } else if (refname.startsWith(REMOTE_PREFIX)) {
      // The remote is the first path segment, as in stack.ts.
      const short = refname.slice(REMOTE_PREFIX.length);
      const name = owned(short.slice(short.indexOf('/') + 1));
      const tips = copies.get(name) ?? [];
      tips.push(owned(tip));
      copies.set(name, tips);
    }
  }
  locals.sort(([a], [b]) => compareNames(a, b));
  return { locals, copies, remotes };
}

/** Commits on `tip` that are on none of the copies. Hashes only, never names. */
async function unpushedCount(root: string, tip: string, copyTips: string[]): Promise<number> {
  if (copyTips.includes(tip)) return 0;
  return countNotOn(root, tip, copyTips);
}

interface Branches {
  branches: WorkBranch[];
  capped: boolean;
}

async function readBranches(root: string, { locals, copies }: Refs): Promise<Branches> {
  const kept = locals.slice(0, MAX_WORK_BRANCHES);
  const branches = await Promise.all(
    kept.map(async ([name, tip]): Promise<WorkBranch> => {
      const copyTips = copies.get(name);
      if (copyTips === undefined) return { name, tip, remoteCopy: false, unpushed: null };
      return { name, tip, remoteCopy: true, unpushed: await unpushedCount(root, tip, copyTips) };
    })
  );
  return { branches, capped: locals.length > kept.length };
}

/** `owner/name` of every GitHub remote, lowercased, no repeats. */
export async function readGithubIdentities(repoPath: string): Promise<string[]> {
  let out: string;
  try {
    out = await git(repoPath, ['config', '--get-regexp', '^remote\\..*\\.url$'], SMALL_MAX_BYTES);
  } catch (err) {
    const failed = err as { code?: unknown; stdout?: Buffer };
    // Exit 1 with nothing printed: no remote has a URL.
    if (failed.code === 1 && (failed.stdout?.length ?? 0) === 0) return [];
    throw err;
  }
  const identities = new Set<string>();
  for (const line of out.split('\n')) {
    const space = line.indexOf(' ');
    if (space === -1) continue;
    const repo = parseGithubRemote(line.slice(space + 1));
    if (repo !== null) identities.add(githubIdentity(repo));
  }
  return [...identities];
}

/** The remote names; null when they cannot be listed, logged. */
async function readRemoteNames(repoPath: string): Promise<string[] | null> {
  try {
    return (await git(repoPath, ['remote'], SMALL_MAX_BYTES)).split('\n').filter(Boolean);
  } catch (err) {
    logger.warn('default base-branch discovery failed', err, { repo: repoPath });
    return null;
  }
}

/** One ref read gives both the mainlines, for the ahead-of-base counts, and the branches. */
async function readCounts(
  repoPath: string,
  listed: RawWorktreeInfo[],
  savedBase: (worktreePath: string) => string | undefined
): Promise<[WorktreeWithBase[], Branches]> {
  const [refs, remotes] = await Promise.all([readRefs(repoPath), readRemoteNames(repoPath)]);
  const mainlines = remotes === null ? null : mainlinesOf(remotes, refs.remotes);
  return Promise.all([withBaseCounts(listed, mainlines, savedBase), readBranches(repoPath, refs)]);
}

function commonDirOf(main: RawWorktreeInfo, repoPath: string): string {
  if (main.isBare) return main.path;
  const dirs = resolveGitDirs(main.path) ?? resolveGitDirs(repoPath);
  if (dirs === null) throw new Error(`Cannot find the git dir of ${repoPath}`);
  return dirs.commonDir;
}

/** null when the path is not a git repo. */
export async function scanWorkRepo(repoPath: string): Promise<WorkRepoFacts | null> {
  const listed = await listWorktreesRaw(repoPath, { pooled: true });
  if (listed.length === 0) return null;
  const main = listed.find((wt) => wt.isMain) ?? listed[0];
  const root = main.path;
  const commonDir = commonDirOf(main, repoPath);

  // Refs and config are shared by every worktree; the asked path exists.
  const [changes, [counted, { branches, capped }], identities, drafts] = await Promise.all([
    Promise.all(listed.map(worktreeChanges)),
    readCounts(repoPath, listed, loadBaseBranchChoices()),
    readGithubIdentities(repoPath),
    listDrafts(commonDir),
  ]);

  const worktrees = counted.map((wt, i): WorkWorktree => ({
    path: wt.path,
    branch: wt.branch,
    head: wt.head,
    isMain: wt.isMain,
    isBare: wt.isBare,
    lastActivity: wt.lastActivity,
    changedAt: changes[i].changedAt,
    aheadOfBase: wt.aheadOfBase,
    base: wt.baseBranch,
    uncommitted: changes[i].uncommitted,
  }));

  return {
    path: repoPath,
    root,
    name: repoName(main),
    worktrees,
    branches,
    branchesCapped: capped,
    identities,
    drafts,
  };
}
