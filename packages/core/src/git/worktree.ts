import * as fs from 'node:fs';
import * as path from 'node:path';
import { GIT_PREFIX, createGit, execGitBytes } from './gitClient.js';
import { pickDefaultBase, remoteMainlines, type Mainline } from './diff.js';
import { loadBaseBranchChoices } from '../utils/baseBranchCache.js';
import { expandPath } from '../utils/pathUtils.js';
import * as logger from '../utils/logger.js';

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
  } catch (err) {
    // Null is the contract (a non-repo path is a normal question), but
    // the reason is kept at debug: with --debug, "Not a git repository"
    // for a path that IS one becomes explainable.
    logger.debug('rev-parse failed', err, { dir });
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
 *
 * `pooled` runs the spawn in the shared git pool, for a scan that spawns
 * many. Opening a repo leaves it off, so it never waits behind a scan.
 */
export async function listWorktreesRaw(
  anyRepoPath: string,
  { pooled = false }: { pooled?: boolean } = {}
): Promise<RawWorktreeInfo[]> {
  const dir = toDirectory(anyRepoPath);
  if (!dir) return [];

  try {
    return await readWorktreeList(dir, pooled);
  } catch (err) {
    // Same contract as resolveWorktreeRoot: empty for a non-repo, reason
    // at debug.
    logger.debug('worktree list failed', err, { dir });
    return [];
  }
}

async function readWorktreeList(dir: string, pooled: boolean): Promise<RawWorktreeInfo[]> {
  const list = () => createGit(dir).raw(['worktree', 'list', '--porcelain']);
  return parseWorktreePorcelain(await (pooled ? gitPool.run(list) : list()));
}

/**
 * List the worktrees registered for the repository that `anyRepoPath` belongs
 * to. Works from a worktree root, a subdirectory, or the bare container of a
 * bare-worktree layout (the `.git` file / bare dir is resolved by git).
 *
 * Returns an empty array when the path is not a git repository at all.
 */
export async function listWorktrees(anyRepoPath: string): Promise<WorktreeInfo[]> {
  return (await listWorktreesWithBase(anyRepoPath)).map(withoutBase);
}

function withoutBase({ baseBranch: _baseBranch, ...info }: WorktreeWithBase): WorktreeInfo {
  return info;
}

/** A worktree with the name of the base its `aheadOfBase` counts against. */
export interface WorktreeWithBase extends WorktreeInfo {
  /** The base `aheadOfBase` counts against, `upstream/main`; null when there is no count. */
  baseBranch: string | null;
}

/** listWorktrees, plus each worktree's base name. */
export async function listWorktreesWithBase(anyRepoPath: string): Promise<WorktreeWithBase[]> {
  const dir = toDirectory(anyRepoPath);
  if (!dir) return [];

  let raw: RawWorktreeInfo[];
  try {
    raw = await readWorktreeList(dir, false);
  } catch (err) {
    logger.debug('worktree list failed', err, { dir });
    return [];
  }
  return withBaseCounts(raw, await readMainlines(dir), loadBaseBranchChoices());
}

/**
 * Each remote's mainline, read once for the whole family: every worktree
 * shares the refs. Null when the read fails, logged.
 */
async function readMainlines(repoDir: string): Promise<Mainline[] | null> {
  try {
    return await remoteMainlines(repoDir);
  } catch (err) {
    logger.warn('default base-branch discovery failed', err, { repo: repoDir });
    return null;
  }
}

/**
 * A family's worktrees with their activity and their ahead-of-base count.
 * `mainlines` is null when they could not be read; `savedBase` gives a
 * worktree's persisted base choice.
 */
export async function withBaseCounts(
  raw: RawWorktreeInfo[],
  mainlines: Mainline[] | null,
  savedBase: (worktreePath: string) => string | undefined
): Promise<WorktreeWithBase[]> {
  const ahead = await aheadOfBaseCounts(raw, mainlines, savedBase);
  return raw.map((wt) => ({
    ...wt,
    lastActivity: wt.isBare ? null : finiteOrNull(lastGitActivity(wt.path)),
    aheadOfBase: ahead.get(wt.path)?.ahead ?? null,
    baseBranch: ahead.get(wt.path)?.base ?? null,
  }));
}

/** `-Infinity` (nothing stat'able) becomes null; a real mtime passes through. */
function finiteOrNull(time: number): number | null {
  return Number.isFinite(time) ? time : null;
}

/**
 * Runs at most `size` tasks at once. Fifty worktrees times a handful of
 * remotes is hundreds of git spawns; started in one tick they block the
 * event loop for the whole listing, so every other request waits.
 */
class TaskPool {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly size: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.size) await new Promise<void>((wake) => this.waiting.push(wake));
    this.active++;
    try {
      return await task();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

/** Git spawns a listing has in flight at once: 8 keeps every stall under 30 ms without slowing a cold listing. */
export const WORKTREE_GIT_CONCURRENCY = 8;

const gitPool = new TaskPool(WORKTREE_GIT_CONCURRENCY);

/** Run a git spawn through the shared pool of 8. */
export function runGitPooled<T>(task: () => Promise<T>): Promise<T> {
  return gitPool.run(task);
}

/**
 * Commit counts, keyed by the directory they ran in and the exact commit
 * ids. Commits never change, so a kept count stays right; a moved HEAD or
 * ref asks for other ids. Per directory, so a shallow clone never answers
 * for a full one. The least recently used goes first past the limit. A
 * Work scan of 436 worktrees uses about 1,100; an entry is a few hundred
 * bytes.
 */
export const COMMIT_COUNT_LIMIT = 8192;

const commitCounts = new Map<string, number>();

const COUNT_MAX_BYTES = 1024 * 1024;

const UNBORN_HEAD = /^0+$/;

/** Drop every cached commit count (tests). */
export function clearCommitCounts(): void {
  commitCounts.clear();
}

/**
 * `count()` once per directory, tip and set of bases; later calls with the
 * same ids are served from memory. A failed count is not kept.
 */
export async function cachedCommitCount(
  cwd: string,
  tip: string,
  bases: readonly string[],
  count: () => Promise<number>
): Promise<number> {
  // A copy: a key cut from git output would keep the whole output alive.
  const key = Buffer.from([cwd, tip, ...[...bases].sort()].join('\n'), 'utf8').toString('utf8');
  const hit = commitCounts.get(key);
  if (hit !== undefined) {
    commitCounts.delete(key);
    commitCounts.set(key, hit);
    return hit;
  }
  const counted = await count();
  commitCounts.set(key, counted);
  if (commitCounts.size > COMMIT_COUNT_LIMIT) {
    commitCounts.delete(commitCounts.keys().next().value!);
  }
  return counted;
}

/**
 * Commits on `tip` that are on none of `bases`, counted in `cwd` through
 * the pool, cached by commit ids. Ids only, never names: a name moves.
 */
export function countNotOn(cwd: string, tip: string, bases: readonly string[]): Promise<number> {
  return cachedCommitCount(cwd, tip, bases, async () => {
    const out = await gitPool.run(() =>
      execGitBytes(
        cwd,
        [...GIT_PREFIX, 'rev-list', '--count', tip, '--not', ...bases],
        COUNT_MAX_BYTES
      )
    );
    return parseInt(out.toString('utf8').trim(), 10);
  });
}

/** A count of commits ahead, and the base it counts against. */
interface AheadOfBase {
  ahead: number;
  base: string;
}

/**
 * The commits a worktree has on top of its default base, counting against
 * the given mainlines. Same selection rule as findDefaultBase. Null when
 * there is no mainline or no HEAD. A failed count is logged and reads as
 * unknown.
 */
async function defaultBaseAhead(
  wt: RawWorktreeInfo,
  mainlines: Mainline[]
): Promise<AheadOfBase | null> {
  // An unborn HEAD (git reports the zero id) has no commits to count.
  if (wt.head === null || UNBORN_HEAD.test(wt.head)) return null;
  const head = wt.head;
  try {
    const counted = await Promise.all(
      mainlines.map(async ({ remote, ref, commit }) => ({
        remote,
        ref,
        ahead: await countNotOn(wt.path, head, [commit]),
      }))
    );
    const picked = pickDefaultBase(counted);
    return picked === null ? null : { ahead: picked.ahead, base: picked.branch };
  } catch (err) {
    logger.warn('default base-branch count failed', err, { worktree: wt.path });
    return null;
  }
}

/** Commits on HEAD past a persisted base choice; null when it is not a ref. */
async function chosenBaseAhead(worktreePath: string, chosen: string): Promise<number | null> {
  try {
    const git = createGit(worktreePath);
    const out = await gitPool.run(() =>
      git.raw(['rev-list', '--count', '--end-of-options', `${chosen}..HEAD`])
    );
    return parseInt(out.trim(), 10);
  } catch {
    // The base is not a ref here (a cached choice for a branch that
    // was deleted): no count, which the picker shows as unknown.
    return null;
  }
}

/**
 * Commits-ahead-of-base for every non-bare worktree, keyed by path. A
 * worktree with an explicit persisted base-branch choice (set via the
 * Compare tab) counts against that; the rest count against their own
 * default base, which depends on each worktree's HEAD. Same rule as
 * resolveEffectiveBaseBranch.
 *
 * Git lists a deleted worktree until it is pruned. It has no count, and
 * trying for one on every listing only fills the log.
 *
 * When the mainlines could not be read, no worktree gets a default-base
 * count; the persisted choices still do.
 */
async function aheadOfBaseCounts(
  worktrees: RawWorktreeInfo[],
  mainlines: Mainline[] | null,
  savedBase: (worktreePath: string) => string | undefined
): Promise<Map<string, AheadOfBase>> {
  const entries = await Promise.all(
    worktrees
      .filter((wt) => !wt.isBare && isExistingDirectory(wt.path))
      .map(async (wt): Promise<[string, AheadOfBase] | null> => {
        const chosen = savedBase(wt.path);
        let counted: AheadOfBase | null = null;
        if (chosen !== undefined) {
          const ahead = await chosenBaseAhead(wt.path, chosen);
          counted = ahead === null ? null : { ahead, base: chosen };
        } else if (mainlines !== null) {
          counted = await defaultBaseAhead(wt, mainlines);
        }
        return counted === null ? null : [wt.path, counted];
      })
  );
  return new Map(entries.filter((e): e is [string, AheadOfBase] => e !== null));
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
 * Most recent mtime among the worktree's `HEAD` and its reflog `logs/HEAD`:
 * a commit, checkout, reset or rebase. Not the `index`: a plain `git status`
 * rewrites it (stat refresh, untracked cache), so an editor or a shell prompt
 * would look like work. The working directory itself when the git dir can't
 * be resolved. -Infinity when nothing can be stat'ed.
 */
function lastGitActivity(worktreePath: string): number {
  const gitDir = resolveWorktreeGitDir(worktreePath);
  const candidates = gitDir
    ? [path.join(gitDir, 'HEAD'), path.join(gitDir, 'logs', 'HEAD')]
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
