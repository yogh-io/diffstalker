import * as fs from 'node:fs';
import * as path from 'node:path';
import { createGit } from './gitClient.js';
import { getDefaultBaseBranch } from './diff.js';
import { getCachedBaseBranch } from '../utils/baseBranchCache.js';

/**
 * A single git worktree, as reported by `git worktree list --porcelain`,
 * before activity data is attached.
 */
export interface RawWorktreeInfo {
  /** Absolute path to the worktree's working directory (or the bare git dir). */
  path: string;
  /** Branch name (without `refs/heads/`), or null when detached or bare. */
  branch: string | null;
  /** Checked-out commit hash, or null for a bare entry. */
  head: string | null;
  /** True for the bare repository entry (has no working tree). */
  isBare: boolean;
}

/** A worktree enriched with its most recent activity. */
export interface WorktreeInfo extends RawWorktreeInfo {
  /** Most recent git index/HEAD activity (epoch ms), or null when it
   * couldn't be determined (bare entry, or nothing stat'able). */
  lastActivity: number | null;
  /** Commits on this worktree's HEAD that aren't on its resolved base
   * branch (the persisted per-worktree choice, or the discovered default —
   * same rule as the Compare tab). Null for a bare entry, or when no base
   * branch could be determined. */
  aheadOfBase: number | null;
}

/**
 * Resolve an arbitrary path — a file, a worktree root, or a subdirectory of a
 * worktree — to the working-tree root that contains it.
 *
 * Returns null when the path is not inside a working tree, i.e. a bare-repo
 * container (like the parent of a bare-worktree layout) or a non-repo dir.
 * Callers should treat null as "ask which worktree" rather than "not a repo".
 */
export async function resolveWorktreeRoot(inputPath: string): Promise<string | null> {
  const dir = toDirectory(inputPath);
  if (!dir) return null;

  try {
    const git = createGit(dir);
    const isBare = (await git.raw(['rev-parse', '--is-bare-repository'])).trim() === 'true';
    if (isBare) return null;
    const top = (await git.raw(['rev-parse', '--show-toplevel'])).trim();
    return top || null;
  } catch {
    return null;
  }
}

/**
 * List the worktrees registered for the repository that `anyRepoPath` belongs
 * to. Works from a worktree root, a subdirectory, or the bare container of a
 * bare-worktree layout (the `.git` file / bare dir is resolved by git).
 *
 * Returns an empty array when the path is not a git repository at all.
 */
export async function listWorktrees(anyRepoPath: string): Promise<WorktreeInfo[]> {
  const dir = toDirectory(anyRepoPath);
  if (!dir) return [];

  try {
    const git = createGit(dir);
    const out = await git.raw(['worktree', 'list', '--porcelain']);
    const raw = parseWorktreePorcelain(out);
    const ahead = await aheadOfBaseCounts(raw, dir);
    return raw.map((wt) => ({
      ...wt,
      lastActivity: wt.isBare ? null : finiteOrNull(lastGitActivity(wt.path)),
      aheadOfBase: ahead.get(wt.path) ?? null,
    }));
  } catch {
    return [];
  }
}

/** `-Infinity` (nothing stat'able) becomes null; a real mtime passes through. */
function finiteOrNull(time: number): number | null {
  return Number.isFinite(time) ? time : null;
}

/**
 * Commits-ahead-of-base for every non-bare worktree, keyed by path.
 *
 * The candidate-base discovery (`getDefaultBaseBranch`) scans recent `git
 * log --all`, which is the expensive part — it runs ONCE per family (from
 * `anyPathInFamily`, since sibling worktrees share the same refs) and is
 * reused for every worktree that has no explicit persisted base-branch
 * choice of its own. A worktree with an explicit choice (set via the
 * Compare tab) uses that instead, same rule as resolveEffectiveBaseBranch.
 */
async function aheadOfBaseCounts(
  worktrees: RawWorktreeInfo[],
  anyPathInFamily: string
): Promise<Map<string, number>> {
  const nonBare = worktrees.filter((wt) => !wt.isBare);
  if (nonBare.length === 0) return new Map();

  const discoveredDefault = await getDefaultBaseBranch(anyPathInFamily).catch(() => null);

  const entries = await Promise.all(
    nonBare.map(async (wt): Promise<[string, number] | null> => {
      const base = getCachedBaseBranch(wt.path) ?? discoveredDefault;
      if (!base) return null;
      try {
        const git = createGit(wt.path);
        const out = await git.raw(['rev-list', '--count', '--end-of-options', `${base}..HEAD`]);
        return [wt.path, parseInt(out.trim(), 10)];
      } catch {
        return null;
      }
    })
  );

  return new Map(entries.filter((e): e is [string, number] => e !== null));
}

/**
 * Pick the worktree to open when a bare container is targeted: the one with
 * the most recent git activity, approximated by the mtime of the worktree's
 * git `index`/`HEAD` (touched by staging, commits, and checkouts), falling
 * back to the working directory's mtime when the git dir can't be resolved.
 * Bare entries are skipped.
 *
 * Returns null when the list contains no usable worktree.
 */
export function pickDefaultWorktree(worktrees: WorktreeInfo[]): WorktreeInfo | null {
  let best: WorktreeInfo | null = null;
  let bestTime = -Infinity;
  for (const wt of worktrees) {
    if (wt.isBare) continue;
    const time = lastGitActivity(wt.path);
    if (time > bestTime) {
      bestTime = time;
      best = wt;
    }
  }
  return best;
}

/**
 * Most recent mtime among the worktree's git `index` and `HEAD`, or of the
 * working directory itself when the git dir can't be resolved. -Infinity when
 * nothing can be stat'ed.
 */
function lastGitActivity(worktreePath: string): number {
  const gitDir = resolveWorktreeGitDir(worktreePath);
  const candidates = gitDir
    ? [path.join(gitDir, 'index'), path.join(gitDir, 'HEAD')]
    : [worktreePath];

  let latest = -Infinity;
  for (const candidate of candidates) {
    try {
      const mtime = fs.statSync(candidate).mtimeMs;
      if (mtime > latest) latest = mtime;
    } catch {
      // Candidate missing (e.g. no index yet) — skip it.
    }
  }
  return latest;
}

/**
 * Resolve a worktree's git dir without spawning git: `.git` itself when it is
 * a directory (a plain repo), or the `gitdir: <path>` target when `.git` is a
 * file (linked worktrees of a bare layout).
 */
function resolveWorktreeGitDir(worktreePath: string): string | null {
  const dotGit = path.join(worktreePath, '.git');
  try {
    if (fs.statSync(dotGit).isDirectory()) return dotGit;
    const match = fs.readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+)$/m);
    if (!match) return null;
    const target = match[1].trim();
    return path.isAbsolute(target) ? target : path.resolve(worktreePath, target);
  } catch {
    return null;
  }
}

export interface GitDirs {
  /** The per-worktree git dir — `HEAD` and `index` live here. For a linked
   * worktree this is `<repo>/.bare/worktrees/<name>`, not `<worktree>/.git`. */
  gitDir: string;
  /** The shared common git dir — `refs/` and `packed-refs` live here (shared
   * across all worktrees). Equals `gitDir` for a plain (non-worktree) repo. */
  commonDir: string;
}

/**
 * Resolve a worktree's real git dirs WITHOUT spawning git (used by the file
 * watcher, which must point at where HEAD/index/refs actually live). A linked
 * worktree's `.git` is a pointer FILE, its `HEAD`/`index` sit in the
 * per-worktree dir, and its refs are shared in the common dir named by the
 * `commondir` file. A plain repo has both in `<repo>/.git`.
 *
 * Returns null when the path is not a git working tree.
 */
export function resolveGitDirs(worktreePath: string): GitDirs | null {
  const gitDir = resolveWorktreeGitDir(worktreePath);
  if (gitDir === null) return null;
  let commonDir = gitDir;
  try {
    const rel = fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim();
    if (rel) commonDir = path.isAbsolute(rel) ? rel : path.resolve(gitDir, rel);
  } catch {
    // No commondir file -> a plain repo; gitDir already IS the common dir.
  }
  return { gitDir, commonDir };
}

/**
 * Parse the output of `git worktree list --porcelain` into structured entries.
 * Records are separated by blank lines; each starts with a `worktree <path>`
 * line followed by `HEAD`, `branch`, `detached`, or `bare` attribute lines.
 */
export function parseWorktreePorcelain(output: string): RawWorktreeInfo[] {
  const result: RawWorktreeInfo[] = [];
  let current: RawWorktreeInfo | null = null;

  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current) result.push(current);
      current = {
        path: line.slice('worktree '.length).trim(),
        branch: null,
        head: null,
        isBare: false,
      };
    } else if (!current) {
      continue;
    } else if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length).trim();
    } else if (line.startsWith('branch ')) {
      current.branch = line
        .slice('branch '.length)
        .trim()
        .replace(/^refs\/heads\//, '');
    } else if (line === 'bare') {
      current.isBare = true;
    }
  }
  if (current) result.push(current);

  return result;
}

/**
 * Reduce a path to a directory: the path itself if it is a directory, otherwise
 * its parent directory. Returns null only when neither exists on disk.
 */
function toDirectory(inputPath: string): string | null {
  try {
    if (fs.statSync(inputPath).isDirectory()) return inputPath;
    return path.dirname(inputPath);
  } catch {
    const parent = path.dirname(inputPath);
    return parent !== inputPath && fs.existsSync(parent) ? parent : null;
  }
}
