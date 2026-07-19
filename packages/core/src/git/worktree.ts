import * as fs from 'node:fs';
import * as path from 'node:path';
import { simpleGit } from 'simple-git';

/**
 * A single git worktree, as reported by `git worktree list --porcelain`.
 */
export interface WorktreeInfo {
  /** Absolute path to the worktree's working directory (or the bare git dir). */
  path: string;
  /** Branch name (without `refs/heads/`), or null when detached or bare. */
  branch: string | null;
  /** Checked-out commit hash, or null for a bare entry. */
  head: string | null;
  /** True for the bare repository entry (has no working tree). */
  isBare: boolean;
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
    const git = simpleGit(dir);
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
    const git = simpleGit(dir);
    const out = await git.raw(['worktree', 'list', '--porcelain']);
    return parseWorktreePorcelain(out);
  } catch {
    return [];
  }
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

/**
 * Parse the output of `git worktree list --porcelain` into structured entries.
 * Records are separated by blank lines; each starts with a `worktree <path>`
 * line followed by `HEAD`, `branch`, `detached`, or `bare` attribute lines.
 */
export function parseWorktreePorcelain(output: string): WorktreeInfo[] {
  const result: WorktreeInfo[] = [];
  let current: WorktreeInfo | null = null;

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
