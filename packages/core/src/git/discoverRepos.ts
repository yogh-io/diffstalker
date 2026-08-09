/**
 * Repository discovery: find the git repos under a directory the user
 * keeps their projects in.
 *
 * This is deliberately fs-only — no git process, no simple-git. A repo is
 * a directory holding a `.git` entry, and its branch comes from reading
 * `.git/HEAD`, so scanning a root with fifty repos costs fifty stats and
 * fifty small file reads rather than fifty git invocations. The result is
 * a LIST, not open repos: opening one is still POST /repos, which is what
 * starts watchers and git state.
 *
 * The scan stops descending the moment it finds a repo, so a repo's own
 * subdirectories are never walked (and a submodule never shows up as a
 * project of its own). Symlinked directories are not followed at all —
 * that avoids cycles, at the cost of missing a symlinked-in project.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface DiscoveredRepo {
  /** Absolute path of the directory holding `.git`. */
  path: string;
  /** Directory name — the label a client shows. */
  name: string;
  /**
   * Branch from `.git/HEAD`: a branch name, a short sha when detached, or
   * null when HEAD could not be read (an in-progress clone, a permission
   * error, a `.git` shape we don't parse).
   */
  branch: string | null;
  /**
   * Most recent git activity (epoch ms), or null when nothing could be
   * stat'ed. The newest mtime of the git dir's `index` and `HEAD` — the
   * two files every commit, checkout and staging touches — which is the
   * same measure worktree listing uses, so a repo does not read as
   * differently aged depending on which list it appears in.
   *
   * This is what lets a client rank a projects folder: a directory you
   * have not touched in two years is still a repo, but it is not what you
   * are looking for, and an alphabetical list buries the one you want
   * under exactly that.
   */
  lastActivity: number | null;
}

export interface DiscoveryResult {
  repos: DiscoveredRepo[];
  /**
   * True when the cap stopped the scan with directories still unvisited.
   * Clients say so rather than presenting a truncated list as complete.
   */
  capped: boolean;
}

export interface DiscoverOptions {
  /**
   * How many levels below the root to look. 1 = direct children only,
   * 2 (the default) = a child, and one level inside a child that is not
   * itself a repo, so `~/gitRepos/work/projectA` is found.
   */
  depth?: number;
  /** Stop after this many repos. */
  limit?: number;
}

export const DEFAULT_DISCOVERY_DEPTH = 2;
export const MAX_DISCOVERED_REPOS = 500;

/**
 * Directories never descended into. These are the ones that are both
 * common and expensive; anything starting with a dot is skipped too.
 */
const SKIP_DIRS = new Set([
  'node_modules',
  'vendor',
  'target',
  'dist',
  'build',
  'venv',
  '__pycache__',
]);

/** Does this directory hold a `.git` entry (a dir, or a worktree's file)? */
async function hasGitEntry(dir: string): Promise<boolean> {
  try {
    await fs.stat(path.join(dir, '.git'));
    return true;
  } catch {
    return false;
  }
}

/**
 * The git directory for a working tree: `<root>/.git` when it is a real
 * directory, or the path a linked worktree's `.git` FILE points at
 * (`gitdir: …`, which git writes absolute but is allowed to be relative).
 *
 * Null means this directory is not an openable repository — including the
 * leftover case that looks like one: a worktree directory left behind
 * after its git dir was pruned still has a `.git` file, and pointing a
 * user at it would only produce a "not a git repository" error when they
 * clicked it. That link is followed here, so the check costs one stat.
 */
async function resolveGitDir(repoPath: string): Promise<string | null> {
  const dotGit = path.join(repoPath, '.git');
  let stats;
  try {
    stats = await fs.stat(dotGit);
  } catch {
    return null;
  }
  if (stats.isDirectory()) return dotGit;

  try {
    const content = await fs.readFile(dotGit, 'utf-8');
    const match = /^gitdir:\s*(.+)$/m.exec(content);
    if (!match) return null;
    const target = match[1].trim();
    const gitDir = path.isAbsolute(target) ? target : path.resolve(repoPath, target);
    await fs.stat(gitDir); // dangling link: throws, so this is not a repo
    return gitDir;
  } catch {
    return null;
  }
}

/** The branch (or short sha) HEAD names, read straight from the file. */
async function branchFromHead(gitDir: string): Promise<string | null> {
  let head: string;
  try {
    head = (await fs.readFile(path.join(gitDir, 'HEAD'), 'utf-8')).trim();
  } catch {
    return null;
  }

  const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
  if (ref) return ref[1].trim();
  // Detached HEAD: the raw commit, shown short like git does.
  if (/^[0-9a-f]{40}$/i.test(head)) return head.slice(0, 7);
  return null;
}

/**
 * The branch a repo is on, without running git. Null when the directory
 * is not an openable repo, or when HEAD is missing or in a shape we don't
 * parse — a repo with an unreadable HEAD (a clone still in progress) is
 * still a repo, so callers show it without a branch.
 */
export async function readHeadBranch(repoPath: string): Promise<string | null> {
  const gitDir = await resolveGitDir(repoPath);
  return gitDir === null ? null : branchFromHead(gitDir);
}

/**
 * When this repo was last touched: the newest mtime of the git dir's
 * `index` and `HEAD`. Null when neither can be stat'ed.
 */
async function lastActivityOf(gitDir: string): Promise<number | null> {
  const times = await Promise.all(
    ['index', 'HEAD'].map(async (name) => {
      try {
        return (await fs.stat(path.join(gitDir, name))).mtimeMs;
      } catch {
        return null; // missing (a repo with no index yet), or unreadable
      }
    })
  );
  const known = times.filter((time): time is number => time !== null);
  return known.length === 0 ? null : Math.max(...known);
}

/**
 * Describe a directory that has a `.git` entry, or null when that entry
 * turns out not to back a real repository.
 */
async function describeRepo(repoPath: string): Promise<DiscoveredRepo | null> {
  const gitDir = await resolveGitDir(repoPath);
  if (gitDir === null) return null;
  const [branch, lastActivity] = await Promise.all([
    branchFromHead(gitDir),
    lastActivityOf(gitDir),
  ]);
  return { path: repoPath, name: path.basename(repoPath), branch, lastActivity };
}

/** Is this entry a directory worth looking inside? */
function isCandidate(entry: { name: string; isDirectory(): boolean }): boolean {
  if (!entry.isDirectory()) return false; // symlinks included: not followed
  if (entry.name.startsWith('.')) return false;
  return !SKIP_DIRS.has(entry.name);
}

/** One subdirectory, for a client browsing the daemon's filesystem. */
export interface DirectoryEntry {
  name: string;
  path: string;
  /** True when this directory is itself a git repo (it holds a `.git`). */
  isRepo: boolean;
}

/**
 * The subdirectories of `dir`, for picking a watch directory from a
 * browser — which cannot see the daemon's filesystem at all, and cannot be
 * handed an absolute path by any file-picker the platform offers.
 *
 * Directories only, and the same ones the scan would look at (no dot
 * directories, no `node_modules`), so what you browse is what gets
 * scanned. `isRepo` marks a directory that is a project rather than a
 * folder of projects — the thing you almost always want to pick the
 * PARENT of.
 *
 * Throws when `dir` cannot be read; that is the caller's 404.
 */
export async function listDirectories(dir: string): Promise<DirectoryEntry[]> {
  const paths = await childDirs(dir);
  return Promise.all(
    paths.map(async (child) => ({
      name: path.basename(child),
      path: child,
      isRepo: await hasGitEntry(child),
    }))
  );
}

/** The subdirectories worth looking at inside one directory, sorted. */
async function childDirs(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter(isCandidate)
    .map((entry) => path.join(dir, entry.name))
    .sort();
}

/**
 * One breadth-first level: which of these directories are repos, and
 * which directories the next level should look at. `room` is how many
 * more repos the caller will accept; running out is reported as capped
 * rather than trimmed silently.
 */
async function walkLevel(
  dirs: string[],
  descend: boolean,
  room: number
): Promise<{ repos: string[]; next: string[]; capped: boolean }> {
  const repos: string[] = [];
  const next: string[] = [];

  for (const dir of dirs) {
    if (repos.length >= room) return { repos, next, capped: true };
    if (await hasGitEntry(dir)) {
      repos.push(dir); // a repo's insides are its own business
      continue;
    }
    if (!descend) continue;
    try {
      next.push(...(await childDirs(dir)));
    } catch {
      // Unreadable subdirectory: skip it, keep the rest of the scan.
    }
  }
  return { repos, next, capped: false };
}

/**
 * Find the git repos under `root`, breadth-first so the shallowest ones
 * are found first and a cap truncates the deepest.
 *
 * Throws only when `root` itself cannot be read — that is the state a
 * caller must surface (a removed or unreadable watch directory). Failures
 * deeper in the tree are skipped silently: one unreadable project should
 * not blank out the rest.
 */
export async function discoverRepos(
  root: string,
  options: DiscoverOptions = {}
): Promise<DiscoveryResult> {
  const maxDepth = options.depth ?? DEFAULT_DISCOVERY_DEPTH;
  const limit = options.limit ?? MAX_DISCOVERED_REPOS;

  // Throws for the root, and only for the root: every deeper readdir goes
  // through walkLevel, which swallows its failures.
  let level = await childDirs(root);

  const found: string[] = [];
  let capped = false;

  for (let depth = 1; depth <= maxDepth && level.length > 0 && !capped; depth++) {
    const result = await walkLevel(level, depth < maxDepth, limit - found.length);
    found.push(...result.repos);
    capped = result.capped;
    level = result.next.sort();
  }

  // A dangling `.git` (a pruned worktree's leftover directory) drops out
  // here rather than during the walk: it is rare, and finding out costs a
  // read the walk deliberately does not do.
  const described = await Promise.all(found.map(describeRepo));
  return { repos: described.filter((repo): repo is DiscoveredRepo => repo !== null), capped };
}
