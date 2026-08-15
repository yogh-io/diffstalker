import * as fs from 'node:fs';
import * as path from 'node:path';
import { createGit } from './gitClient.js';
import { getDefaultBaseBranch } from './diff.js';
import { getCachedBaseBranch } from '../utils/baseBranchCache.js';
import { expandPath } from '../utils/pathUtils.js';

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
  /**
   * The repository's MAIN worktree — `git worktree list` always reports it
   * first (for a bare repo, that first entry is the bare git dir itself).
   *
   * This is the family's identity, and it is git's answer rather than a
   * guess from path shape. Clients used to group worktrees by their
   * deepest common parent directory, which only holds for layouts that
   * nest worktrees under the repo; siblings (`…/proj` + `…/proj-fix`)
   * collapse to their shared PARENT, so the project took the name of
   * whatever directory the user happens to keep repos in. Every layout —
   * nested, sibling, bare-with-worktrees, scattered, or no worktrees at
   * all — has exactly one main worktree.
   */
  isMain: boolean;
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
 * What a path resolved to, or why it could not. A refusal carries the
 * EXPANDED path, so an error message can name what was actually looked for
 * (`/home/you/nope`) rather than the `~/nope` the user typed — the literal
 * tilde never reaches git, and the message should not pretend it did.
 */
export type RepoResolution =
  | { ok: true; root: string }
  | { ok: false; reason: 'not-absolute' | 'not-a-repo'; requested: string };

/**
 * Resolve a client-supplied path to the worktree root that opening it would
 * use. THE one answer to "can diffstalker open this path, and as what" —
 * both `RepoRegistry.openRepo` and the `GET /resolve` probe behind the repo
 * picker's Open button call this, so the button cannot promise an open the
 * daemon then refuses. Two copies of the chain, however carefully kept in
 * step, would eventually tell that lie at the moment of highest trust.
 *
 * `~` is expanded here because this is the daemon's trust boundary: the
 * paths arriving are human-typed (the picker's input, the CLI's positional
 * argument, the follow hook file), and the daemon is loopback-only and runs
 * as the user, so its home IS their home. Anything still relative after
 * that is refused — the daemon's working directory means nothing to the
 * client that sent the path.
 *
 * `mustExist` is the ONLY difference between the two callers, and it makes
 * the probe deliberately STRICTER than opening, never looser:
 * `toDirectory` falls back to the PARENT directory of a path that is not on
 * disk, so `<repo>/nope` resolves to `<repo>` and an open of a typo
 * quietly succeeds against the repo above it. That is tolerable when a
 * human asked to open something; it is wrong for a button whose whole
 * contract is that the typed text precisely names a repo. Never flip this
 * to make the probe more permissive than the open.
 */
export async function resolveRepoRoot(
  inputPath: string,
  { mustExist }: { mustExist: boolean }
): Promise<RepoResolution> {
  const requested = expandPath(inputPath);
  if (!path.isAbsolute(requested)) return { ok: false, reason: 'not-absolute', requested };

  if (mustExist && !isExistingDirectory(requested)) {
    return { ok: false, reason: 'not-a-repo', requested };
  }

  const root = await resolveWorktreeRoot(requested);
  if (root) return { ok: true, root };

  // Bare container (or a path git can't place in a working tree): fall back
  // to the default worktree of whatever repo this is.
  const worktree = pickDefaultWorktree(await listWorktreesRaw(requested));
  return worktree
    ? { ok: true, root: worktree.path }
    : { ok: false, reason: 'not-a-repo', requested };
}

function isExistingDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The worktrees registered for the repository `anyRepoPath` belongs to, with
 * nothing attached: git's own answer, parsed.
 *
 * This is the cheap half of `listWorktrees` — one `git worktree list`, no
 * activity stats and no base-branch discovery. Callers that only need to
 * know WHICH worktrees exist (resolving a path to a repo root, in
 * particular) use this; `git log --all` per family is far too much work to
 * answer that question.
 */
export async function listWorktreesRaw(anyRepoPath: string): Promise<RawWorktreeInfo[]> {
  const dir = toDirectory(anyRepoPath);
  if (!dir) return [];

  try {
    const git = createGit(dir);
    return parseWorktreePorcelain(await git.raw(['worktree', 'list', '--porcelain']));
  } catch {
    return [];
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
 *
 * Takes RAW entries (generic, so an enriched `WorktreeInfo[]` still comes
 * back as `WorktreeInfo`): it reads only `path` and `isBare`, and re-derives
 * activity itself, so demanding the enriched shape would have forced every
 * caller to pay for a base-branch scan this function never looks at.
 */
export function pickDefaultWorktree<T extends RawWorktreeInfo>(worktrees: T[]): T | null {
  let best: T | null = null;
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
        // git lists the main worktree first, always.
        isMain: result.length === 0,
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
