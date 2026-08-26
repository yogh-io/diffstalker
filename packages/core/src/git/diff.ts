import * as fs from 'node:fs';
import * as path from 'node:path';
import { createGit } from './gitClient.js';
import { CommitInfo } from './status.js';
import { getCachedBaseBranch } from '../utils/baseBranchCache.js';
import { isBinaryContent } from '../utils/binaryDetect.js';
import { getIgnoredFiles } from './ignoreUtils.js';
import {
  capLargeFileDiffs,
  largeDiffNotice,
  parseDiffWithLineNumbers,
  rawFromLines,
  MAX_FILE_DIFF_BYTES,
} from './diffParse.js';
import type { DiffLine, DiffResult } from './diffParse.js';
import type { StatusResult } from 'simple-git';

// Re-export the pure diff/patch parsers so existing importers (the daemon,
// tests) keep working through `git/diff`. The CLI imports them straight from
// `git/diffParse` to avoid pulling this module's simple-git dependency.
export {
  parseDiffLine,
  parseHunkHeader,
  parseDiffWithLineNumbers,
  countHunks,
  countHunksPerFile,
  extractHunkPatch,
} from './diffParse.js';
export type { DiffLine, DiffResult } from './diffParse.js';

/**
 * Thrown by getDiffBetweenRefs when the base ref shares no history with
 * HEAD (empty merge-base, e.g. an orphan branch). Without this the diff
 * would silently collapse to HEAD...HEAD and look like "no changes".
 */
export class NoCommonHistoryError extends Error {
  constructor(baseRef: string) {
    super(`No common history with ${baseRef}`);
    this.name = 'NoCommonHistoryError';
  }
}

export interface CompareDiffStats {
  filesChanged: number;
  additions: number;
  deletions: number;
}

/**
 * Which side of the working tree a compare row came from.
 *
 * `both` is the staged+unstaged pair read as ONE `git diff HEAD` rather
 * than as two diffs: a file changed on both sides produces one row, not
 * two chunks for the same path of which only the first survives.
 */
export type UncommittedSide = 'staged' | 'unstaged' | 'both' | 'untracked';

/**
 * The three categories of uncommitted work a compare can fold in, each
 * asked for independently. All false is the plain branch-vs-base compare.
 */
export interface UncommittedParts {
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
}

export const NO_UNCOMMITTED: UncommittedParts = {
  staged: false,
  unstaged: false,
  untracked: false,
};

export const ALL_UNCOMMITTED: UncommittedParts = {
  staged: true,
  unstaged: true,
  untracked: true,
};

export interface CompareFileDiff {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
  diff: DiffResult;
  /** Set only on rows that are NOT in the branch's commits: which
   *  uncommitted side produced this row. Absent on committed rows. */
  uncommitted?: UncommittedSide;
}

export interface CompareDiff {
  baseBranch: string;
  stats: CompareDiffStats;
  files: CompareFileDiff[];
  commits: CommitInfo[];
  uncommittedCount: number;
}

export interface FileHunkCounts {
  staged: Map<string, number>;
  unstaged: Map<string, number>;
}

/**
 * Context lines every diff in this file asks git for, pinned rather than
 * left to git's default.
 *
 * A user's `diff.context` config would otherwise decide it, and context
 * width is not cosmetic here: it sets where hunks merge and split. That
 * moves hunk COUNT (the per-file badges), hunk IDENTITY (hunkTimes keys a
 * hunk by a hash of its +/- body, so a re-split hunk is a new hunk with a
 * fresh edit time), and the patches extractHunkPatch builds for staging.
 * Pinned, the same repo reads the same on every machine.
 */
export const DIFF_CONTEXT_LINES = 3;

/**
 * Context width for whole-file mode: wide enough that git emits the file
 * as one hunk rather than several, so the reader sees every line with the
 * changed ones marked in place.
 *
 * A number, not `Infinity`: git takes an integer. It is deliberately not
 * user-settable and not a wire parameter — the API carries `whole` as a
 * boolean precisely so "some more context" cannot be expressed. See
 * docs/whole-file-mode.md.
 *
 * The daemon's per-file diff cap (5,000 lines) bounds the payload well
 * below this, so the value only has to exceed any file the cap lets
 * through.
 */
export const WHOLE_FILE_CONTEXT = 100000;

export async function getDiff(
  repoPath: string,
  file?: string,
  staged: boolean = false,
  opts: { context?: number } = {}
): Promise<DiffResult> {
  const git = createGit(repoPath);

  try {
    const args: string[] = [`-U${opts.context ?? DIFF_CONTEXT_LINES}`];
    if (staged) {
      args.push('--cached');
    }
    if (file) {
      args.push('--', file);
    }

    const raw = capLargeFileDiffs(await git.diff(args));
    return { lines: parseDiffWithLineNumbers(raw) };
  } catch {
    return { lines: [] };
  }
}

/** The well-known oid of git's empty tree — the diff base for an unborn HEAD. */
export const EMPTY_TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** Sentinel returned by getHeadOid when HEAD has no commit yet (unborn branch). */
export const UNBORN_HEAD_OID = '(unborn)';

/**
 * `git rev-parse HEAD` failure signatures that mean an unborn HEAD (fresh
 * repo, no commits) rather than a real error. Anything else — spawn
 * failure, non-repo, broken/unreadable HEAD — must propagate: silently
 * mapping it to the sentinel would make the journal diff against the
 * empty tree and record a phantom mass-create.
 */
const UNBORN_HEAD_SIGNATURE =
  /unknown revision|ambiguous argument 'HEAD'|needed a single revision/i;

/**
 * The commit oid HEAD points at, or UNBORN_HEAD_OID when HEAD is unborn
 * (fresh repo, no commits). Any failure that is NOT the unborn signature
 * THROWS so the journal's observation defers. The journal reads this
 * twice around its diff read: two differing reads mean the tree moved
 * under the observation.
 */
export async function getHeadOid(repoPath: string): Promise<string> {
  const git = createGit(repoPath);
  try {
    return (await git.raw(['rev-parse', 'HEAD'])).trim();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (UNBORN_HEAD_SIGNATURE.test(message)) return UNBORN_HEAD_OID;
    throw err;
  }
}

/**
 * Whole-tree worktree-vs-HEAD diff for the journal: `git diff -U3 HEAD --`.
 * Unborn HEAD diffs against the empty tree instead.
 *
 * Context is pinned (DIFF_CONTEXT_LINES) like every other diff here; for
 * the journal it matters most, since a re-split hunk is a new hunk with a
 * new edit time in an append-only log.
 *
 * DELIBERATE CONVENTION BREAK — THIS FUNCTION PROPAGATES ERRORS. Every
 * sibling in this file catches failure into an empty DiffResult, which is
 * indistinguishable from "clean". For the journal that swallow would weld
 * a phantom mass-revert into an append-only log the first time an
 * index.lock race hit. Do NOT "normalize" this to catch-to-empty; the
 * requirement is enforced by test (diff.test.ts).
 */
export async function getDiffAgainstHead(repoPath: string): Promise<DiffResult> {
  const git = createGit(repoPath);
  const head = await getHeadOid(repoPath);
  const base = head === UNBORN_HEAD_OID ? EMPTY_TREE_OID : 'HEAD';
  const raw = capLargeFileDiffs(
    await git.raw(['diff', `-U${DIFF_CONTEXT_LINES}`, base, '--'])
  );
  return { lines: parseDiffWithLineNumbers(raw) };
}

/** Cap on the untracked file read below: the same per-file diff cap every
 *  other path uses, so one threshold governs "too big to show". Over it,
 *  the file is never read — it gets the notice instead. */
const MAX_UNTRACKED_DIFF_BYTES = MAX_FILE_DIFF_BYTES;

/**
 * An untracked file too big to read: git's new-file header shape plus the
 * same notice an oversized tracked diff gets. Line count is unknown (the
 * file is never read) — the notice carries the byte size only.
 */
function tooLargeUntrackedDiff(file: string, bytes: number): DiffResult {
  const lines: DiffLine[] = [
    { type: 'header', content: `diff --git a/${file} b/${file}` },
    { type: 'header', content: 'new file mode 100644' },
    { type: 'header', content: '--- /dev/null' },
    { type: 'header', content: `+++ b/${file}` },
    { type: 'header', content: largeDiffNotice(bytes) },
  ];
  return { lines };
}

/**
 * An untracked binary file, shaped exactly like git's own new-file binary
 * diff. No `---`/`+++` pair: git omits those for a binary file, and every
 * consumer keys off the "Binary files …" marker, so emitting git's wording
 * verbatim is what puts an untracked image on the same path a tracked one
 * already takes.
 */
function binaryUntrackedDiff(file: string): DiffResult {
  const lines: DiffLine[] = [
    { type: 'header', content: `diff --git a/${file} b/${file}` },
    { type: 'header', content: 'new file mode 100644' },
    { type: 'header', content: `Binary files /dev/null and b/${file} differ` },
  ];
  return { lines };
}

/**
 * The path to read for an untracked file, plus its size — or null when it
 * must not be read at all.
 *
 * Defense-in-depth: this branch reads the filesystem directly (git is not
 * involved), so refuse paths that escape the repo root — lexically AND by
 * realpath, so a symlink pointing out of the repo (e.g. at ~/.ssh) cannot
 * leak its target the way /file and /tree already guard. Non-regular files
 * (a FIFO, a device) are refused too: there is nothing to show, and a read
 * could block forever.
 *
 * It sits in its own function so the caller stays one straight line of diff
 * shaping; the guards are the bulk of the branching here.
 */
function resolveUntrackedRead(
  repoPath: string,
  file: string
): { path: string; size: number } | null {
  const root = path.resolve(repoPath);
  const resolved = path.resolve(root, file);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    return null;
  }
  let real: string;
  let realRoot: string;
  try {
    real = fs.realpathSync(resolved);
    realRoot = fs.realpathSync(root);
  } catch {
    // Path or a link target does not resolve: nothing to serve.
    return null;
  }
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
    return null;
  }
  const stat = fs.statSync(real);
  if (!stat.isFile()) {
    return null;
  }
  return { path: resolved, size: stat.size };
}

export async function getDiffForUntracked(repoPath: string, file: string): Promise<DiffResult> {
  try {
    const target = resolveUntrackedRead(repoPath, file);
    if (target === null) {
      return { lines: [] };
    }
    // Never read a huge file into memory: it gets the same "too large"
    // notice a tracked file's oversized diff gets, rather than an empty
    // diff that reads as "no changes".
    if (target.size > MAX_UNTRACKED_DIFF_BYTES) {
      return tooLargeUntrackedDiff(file, target.size);
    }
    // Read bytes, not text. Decoding as utf-8 first turned a newly added
    // PNG — the commonest untracked binary there is — into a wall of
    // replacement characters emitted as additions, and it could never reach
    // the binary marker afterwards because the mojibake has no NUL left in
    // it. Sniff the raw buffer, then decode only once it is known to be text.
    const buffer = fs.readFileSync(target.path);
    if (isBinaryContent(buffer)) {
      return binaryUntrackedDiff(file);
    }
    // For untracked files, show the entire file as additions, shaped like
    // git's own new-file diff: the trailing newline produces no phantom
    // extra "+" line, a file NOT ending in one gets the "\ No newline"
    // marker, and an empty file has no hunk at all.
    const content = buffer.toString('utf-8');
    const lines: DiffLine[] = [
      { type: 'header', content: `diff --git a/${file} b/${file}` },
      { type: 'header', content: 'new file mode 100644' },
      { type: 'header', content: `--- /dev/null` },
      { type: 'header', content: `+++ b/${file}` },
    ];

    const endsWithNewline = content.endsWith('\n');
    const contentLines = content.split('\n');
    if (endsWithNewline) contentLines.pop(); // split's trailing '' is not a line

    if (content.length > 0) {
      lines.push({ type: 'hunk', content: `@@ -0,0 +1,${contentLines.length} @@` });
      let lineNum = 1;
      for (const line of contentLines) {
        lines.push({ type: 'addition', content: '+' + line, newLineNum: lineNum++ });
      }
      if (!endsWithNewline) {
        lines.push({ type: 'context', content: '\\ No newline at end of file' });
      }
    }

    // A file under the byte cap can still blow the line cap (many short
    // lines); capLargeFileDiffs is the one place that decides either way.
    const raw = rawFromLines(lines);
    const capped = capLargeFileDiffs(raw);
    if (capped !== raw) return { lines: parseDiffWithLineNumbers(capped) };
    return { lines };
  } catch {
    return { lines: [] };
  }
}

/**
 * Get candidate base branches for PR comparison.
 * Uses git log to find branches that appear in recent history (likely PR targets).
 */
export async function getCandidateBaseBranches(repoPath: string): Promise<string[]> {
  const git = createGit(repoPath);
  const seen = new Set<string>();
  const candidates: string[] = [];

  try {
    // Get recent commits with decorations to find branches in our history
    const logOutput = await git.raw(['log', '--oneline', '--decorate=short', '--all', '-n', '200']);

    // Extract remote branch refs from decorations like (origin/main, upstream/feature)
    const refPattern = /\(([^)]+)\)/g;
    for (const line of logOutput.split('\n')) {
      const match = refPattern.exec(line);
      if (match) {
        const refs = match[1].split(',').map((r) => r.trim());
        for (const ref of refs) {
          // Skip HEAD, tags, and local branches - only want remote branches
          if (ref.startsWith('HEAD') || ref.startsWith('tag:') || !ref.includes('/')) continue;
          // Clean up "origin/main" from things like "HEAD -> origin/main"
          const cleaned = ref.replace(/^.*-> /, '');
          if (cleaned.includes('/') && !seen.has(cleaned)) {
            seen.add(cleaned);
            candidates.push(cleaned);
          }
        }
      }
      refPattern.lastIndex = 0; // Reset regex state
    }

    // If we found candidates, sort main/master to top, prefer non-origin
    if (candidates.length > 0) {
      candidates.sort((a, b) => {
        const aName = a.split('/').slice(1).join('/');
        const bName = b.split('/').slice(1).join('/');
        const aIsMain = aName === 'main' || aName === 'master';
        const bIsMain = bName === 'main' || bName === 'master';

        // main/master first
        if (aIsMain && !bIsMain) return -1;
        if (!aIsMain && bIsMain) return 1;

        // Among main/master, prefer non-origin
        if (aIsMain && bIsMain) {
          const aIsOrigin = a.startsWith('origin/');
          const bIsOrigin = b.startsWith('origin/');
          if (aIsOrigin && !bIsOrigin) return 1;
          if (!aIsOrigin && bIsOrigin) return -1;
        }

        return 0; // Keep discovery order otherwise
      });
    }
  } catch {
    // Failed to get branches
  }

  // Return unique candidates (Set deduplication)
  return [...new Set(candidates)];
}

/**
 * Get the best default base branch for PR comparison.
 */
export async function getDefaultBaseBranch(repoPath: string): Promise<string | null> {
  const candidates = await getCandidateBaseBranches(repoPath);
  return candidates[0] ?? null;
}

/**
 * The effective compare base for a repo: the persisted per-repo choice,
 * or the discovered default when nothing is persisted. Single source of
 * this rule — used by the daemon's compare endpoints.
 */
export async function resolveEffectiveBaseBranch(repoPath: string): Promise<string | null> {
  return getCachedBaseBranch(repoPath) ?? (await getDefaultBaseBranch(repoPath));
}

/**
 * True when a revision resolves to a commit in the repo. Accepts any
 * commit-ish: a hash (possibly abbreviated), branch, remote ref, or tag.
 */
export async function commitExists(repoPath: string, revision: string): Promise<boolean> {
  const git = createGit(repoPath);
  try {
    // cat-file -e fails loudly ("Not a valid object name") on a miss.
    // rev-parse --verify --quiet would exit 1 silently, which simple-git
    // does not reliably surface as an error. --end-of-options keeps a
    // flag-shaped revision from being parsed as an option.
    await git.raw(['cat-file', '-e', '--end-of-options', `${revision}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get diff between HEAD and a base ref (for PR-like view).
 * Uses three-dot diff (merge-base) to show only changes on current branch.
 */
export async function getDiffBetweenRefs(repoPath: string, baseRef: string): Promise<CompareDiff> {
  const git = createGit(repoPath);

  // Get merge-base for three-dot diff. With no common ancestor git exits 1
  // with empty output (simple-git resolves with ''); the diff would then
  // collapse to HEAD...HEAD and silently report an empty compare.
  const mergeBase = await git.raw(['merge-base', '--end-of-options', baseRef, 'HEAD']);
  const base = mergeBase.trim();
  if (!base) {
    throw new NoCommonHistoryError(baseRef);
  }

  // Get per-file stats with --numstat
  const numstat = await git.raw(['diff', '--numstat', `${base}...HEAD`]);

  // Get file statuses with --name-status
  const nameStatus = await git.raw(['diff', '--name-status', `${base}...HEAD`]);

  // Get full diff
  const rawDiff = capLargeFileDiffs(
    await git.raw(['diff', `-U${DIFF_CONTEXT_LINES}`, `${base}...HEAD`])
  );

  // Parse numstat: "additions deletions filepath" per line
  const numstatLines = numstat
    .trim()
    .split('\n')
    .filter((l) => l);
  const fileStats: Map<string, { additions: number; deletions: number }> = new Map();
  for (const line of numstatLines) {
    const parts = line.split('\t');
    if (parts.length >= 3) {
      const additions = parts[0] === '-' ? 0 : parseInt(parts[0], 10);
      const deletions = parts[1] === '-' ? 0 : parseInt(parts[1], 10);
      const filepath = parts.slice(2).join('\t'); // Handle paths with tabs
      fileStats.set(filepath, { additions, deletions });
    }
  }

  // Parse name-status: "A/M/D/R filepath" per line
  const nameStatusLines = nameStatus
    .trim()
    .split('\n')
    .filter((l) => l);
  const fileStatuses: Map<string, CompareFileDiff['status']> = new Map();
  for (const line of nameStatusLines) {
    const parts = line.split('\t');
    if (parts.length >= 2) {
      const statusChar = parts[0][0];
      const filepath = parts[parts.length - 1]; // Use last part for renamed files
      let status: CompareFileDiff['status'];
      switch (statusChar) {
        case 'A':
          status = 'added';
          break;
        case 'D':
          status = 'deleted';
          break;
        case 'R':
          status = 'renamed';
          break;
        default:
          status = 'modified';
      }
      fileStatuses.set(filepath, status);
    }
  }

  // Split raw diff by file headers
  const fileDiffs: CompareFileDiff[] = [];
  const diffChunks = rawDiff.split(/(?=^diff --git )/m).filter((chunk) => chunk.trim());

  for (const chunk of diffChunks) {
    // Extract file path from the diff header
    const match = chunk.match(/^diff --git a\/.+ b\/(.+)$/m);
    if (!match) continue;

    const filepath = match[1];
    const lines = parseDiffWithLineNumbers(chunk);
    const stats = fileStats.get(filepath) || { additions: 0, deletions: 0 };
    const status = fileStatuses.get(filepath) || 'modified';

    fileDiffs.push({
      path: filepath,
      status,
      additions: stats.additions,
      deletions: stats.deletions,
      diff: { lines },
    });
  }

  // Calculate total stats
  let totalAdditions = 0;
  let totalDeletions = 0;
  for (const file of fileDiffs) {
    totalAdditions += file.additions;
    totalDeletions += file.deletions;
  }

  // Get uncommitted count from status
  const status = await git.status();
  const uncommittedCount = status.files.length;

  // Get commits between base and HEAD
  const log = await git.log({ from: base, to: 'HEAD' });
  const commits: CommitInfo[] = log.all.map((entry) => ({
    hash: entry.hash,
    shortHash: entry.hash.slice(0, 7),
    message: entry.message.split('\n')[0],
    author: entry.author_name,
    date: new Date(entry.date),
    refs: entry.refs || '',
  }));

  // Sort files alphabetically by path
  fileDiffs.sort((a, b) => a.path.localeCompare(b.path));

  return {
    baseBranch: baseRef,
    stats: {
      filesChanged: fileDiffs.length,
      additions: totalAdditions,
      deletions: totalDeletions,
    },
    files: fileDiffs,
    commits,
    uncommittedCount,
  };
}

/**
 * How many commits the compare view would list, without building the diff.
 *
 * The same range getDiffBetweenRefs logs (`<merge-base>..HEAD`, the
 * three-dot base), counted by rev-list instead — so a caller that only
 * wants the number never pays for the numstat, name-status, and per-file
 * diffs behind a full CompareDiff. Same range, same answer; the tab count
 * cannot disagree with the list it labels.
 *
 * Throws NoCommonHistoryError on an unrelated base, exactly as the full
 * compare does — "no shared history" is a real answer, not a count of 0.
 */
export async function getCommitCountBetweenRefs(
  repoPath: string,
  baseRef: string
): Promise<number> {
  const git = createGit(repoPath);

  const mergeBase = await git.raw(['merge-base', '--end-of-options', baseRef, 'HEAD']);
  const base = mergeBase.trim();
  if (!base) {
    throw new NoCommonHistoryError(baseRef);
  }

  const count = await git.raw(['rev-list', '--count', '--end-of-options', `${base}..HEAD`]);
  return Number.parseInt(count.trim(), 10);
}

/**
 * Which two things a single-file diff is between. The three ranges the
 * diff surfaces actually show, named rather than passed as raw revspecs —
 * nothing here lets a caller name an arbitrary ref.
 */
export type DiffRange =
  /** History: what one commit changed, against its parent. */
  | { kind: 'commit'; hash: string }
  /** Compare's committed rows: base…HEAD, three-dot. */
  | { kind: 'compare'; base: string }
  /** Compare's staged+unstaged rows: HEAD against the working tree. */
  | { kind: 'head' }
  /** Compare's staged-only rows: HEAD against the index. */
  | { kind: 'staged' }
  /** Compare's unstaged-only rows: the index against the working tree. */
  | { kind: 'unstaged' };

/**
 * How a range is spelled as git arguments, with the SUBCOMMAND first —
 * one place, so the rename lookup and the diff itself can never disagree
 * about what range they are reading.
 *
 * `extra` is an argument that must sit before `--end-of-options` (which
 * exists so a flag-shaped hash cannot be read as an option).
 */
function rangeArgs(range: DiffRange, flags: string[]): string[] {
  switch (range.kind) {
    case 'commit':
      // Flags must precede --end-of-options, which is what keeps a
      // flag-shaped hash from being read as an option.
      return ['show', '--format=', ...flags, '--end-of-options', range.hash];
    case 'compare':
      return ['diff', ...flags, `${range.base}...HEAD`];
    case 'head':
      return ['diff', ...flags, 'HEAD'];
    case 'staged':
      return ['diff', '--cached', ...flags];
    case 'unstaged':
      return ['diff', ...flags];
  }
}

/**
 * The old path of a file that was RENAMED within a range, or null.
 *
 * This exists because path-scoping destroys rename detection. Verified:
 * after `git mv old.txt new.txt` plus an edit,
 *
 *   git show --name-status -M HEAD                 -> R087  old.txt  new.txt
 *   git show --name-status -M HEAD -- new.txt      -> A     new.txt
 *   git show --name-status -M HEAD -- old.txt new.txt -> R087 old.txt new.txt
 *
 * So asking for one file by its new path alone reports the whole file as
 * an addition. In hunk form that is merely wrong; in whole-file form it
 * turns a rename-with-two-edited-lines into a thousand-line block of
 * additions — a confidently wrong answer from the mode whose entire point
 * is showing the change in context.
 *
 * `--diff-filter=R` keeps this to the renames only, which is a short list
 * in any realistic range.
 */
async function renamedFrom(repoPath: string, range: DiffRange, file: string): Promise<string | null> {
  const git = createGit(repoPath);
  const args = rangeArgs(range, ['--name-status', '-M', '--diff-filter=R']);
  let raw: string;
  try {
    raw = await git.raw(args);
  } catch {
    // A rename lookup that fails must not fail the diff: the worst case
    // is the pre-existing behaviour (the file read as an add).
    return null;
  }
  for (const line of raw.trim().split('\n')) {
    if (!line) continue;
    // "R087\told.txt\tnew.txt"
    const parts = line.split('\t');
    if (parts.length >= 3 && parts[2] === file) return parts[1];
  }
  return null;
}

/**
 * One file's diff within a named range — the read behind whole-file mode
 * in Compare and History, where the stack pulls the range whole and
 * splits it client-side and so has no per-file request of its own.
 *
 * The pathspec carries BOTH sides of a rename (see renamedFrom), which is
 * the whole reason this is not just `getDiff` with a different revspec.
 */
export async function getFileDiffInRange(
  repoPath: string,
  range: DiffRange,
  file: string,
  opts: { context?: number } = {}
): Promise<DiffResult> {
  const git = createGit(repoPath);
  const context = opts.context ?? DIFF_CONTEXT_LINES;
  try {
    const oldPath = await renamedFrom(repoPath, range, file);
    const paths = oldPath === null ? [file] : [oldPath, file];
    const args = rangeArgs(range, ['-M', `-U${context}`]);
    const raw = capLargeFileDiffs(await git.raw([...args, '--', ...paths]));
    return { lines: parseDiffWithLineNumbers(raw) };
  } catch {
    return { lines: [] };
  }
}

/**
 * Get diff for a specific commit.
 * Shows the changes introduced by that commit.
 */
export async function getCommitDiff(repoPath: string, hash: string): Promise<DiffResult> {
  const git = createGit(repoPath);

  try {
    // git show --format="" gives just the diff without commit metadata;
    // --end-of-options keeps a flag-shaped hash from being read as an option,
    // so every real option (-U) has to be spelled before it
    const raw = capLargeFileDiffs(
      await git.raw(['show', '--format=', `-U${DIFF_CONTEXT_LINES}`, '--end-of-options', hash])
    );
    return { lines: parseDiffWithLineNumbers(raw) };
  } catch {
    return { lines: [] };
  }
}


/**
 * Which git range reads one uncommitted side, and how a status pair is
 * read for it. Staged and unstaged asked for TOGETHER are one `git diff
 * HEAD`, never two diffs concatenated: a file changed on both sides would
 * otherwise produce two chunks for the same path, of which only the first
 * survived, so half its edits went missing while the stats still counted
 * them.
 */
function trackedSide(parts: UncommittedParts): Exclude<UncommittedSide, 'untracked'> | null {
  if (parts.staged && parts.unstaged) return 'both';
  if (parts.staged) return 'staged';
  if (parts.unstaged) return 'unstaged';
  return null;
}

function trackedRange(side: Exclude<UncommittedSide, 'untracked'>): DiffRange {
  switch (side) {
    case 'both':
      return { kind: 'head' };
    case 'staged':
      return { kind: 'staged' };
    case 'unstaged':
      return { kind: 'unstaged' };
  }
}

/**
 * The status letter a row shows, read from the porcelain column the row's
 * side actually describes: an `AM` file is an addition to the staged row
 * and a modification to the unstaged one, and labelling both from the
 * index column would call a working-tree edit an add.
 */
function sideStatus(
  side: Exclude<UncommittedSide, 'untracked'>,
  index: string,
  workingDir: string
): CompareFileDiff['status'] {
  const columns = side === 'staged' ? [index] : side === 'unstaged' ? [workingDir] : [index, workingDir];
  if (columns.includes('R')) return 'renamed';
  if (columns.includes('D')) return 'deleted';
  if (columns.includes('A') || columns.includes('?')) return 'added';
  return 'modified';
}

/** Parse `git diff --numstat` output into per-file addition/deletion counts. */
function parseNumstat(raw: string): Map<string, { additions: number; deletions: number }> {
  const stats = new Map<string, { additions: number; deletions: number }>();
  for (const line of raw.trim().split('\n')) {
    if (!line) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const additions = parts[0] === '-' ? 0 : parseInt(parts[0], 10);
    const deletions = parts[1] === '-' ? 0 : parseInt(parts[1], 10);
    stats.set(parts.slice(2).join('\t'), { additions, deletions });
  }
  return stats;
}

/** The tracked (staged and/or unstaged) rows for one side. */
async function readTrackedRows(
  repoPath: string,
  side: Exclude<UncommittedSide, 'untracked'>,
  status: StatusResult
): Promise<CompareFileDiff[]> {
  const git = createGit(repoPath);
  const range = trackedRange(side);
  const stats = parseNumstat(await git.raw(rangeArgs(range, ['--numstat'])));
  const raw = capLargeFileDiffs(
    await git.raw(rangeArgs(range, [`-U${DIFF_CONTEXT_LINES}`]))
  );

  const statusPairs = new Map(status.files.map((f) => [f.path, f]));
  const rows: CompareFileDiff[] = [];
  for (const chunk of raw.split(/(?=^diff --git )/m)) {
    if (!chunk.trim()) continue;
    const match = chunk.match(/^diff --git a\/.+ b\/(.+)$/m);
    if (!match) continue;
    const filepath = match[1];
    const pair = statusPairs.get(filepath);
    rows.push({
      path: filepath,
      status: sideStatus(side, pair?.index ?? '', pair?.working_dir ?? ''),
      ...(stats.get(filepath) ?? { additions: 0, deletions: 0 }),
      diff: { lines: parseDiffWithLineNumbers(chunk) },
      uncommitted: side,
    });
  }
  return rows;
}

/**
 * The untracked rows: git diff never reports them, so each is read from
 * disk and shaped as a new-file diff, the same way the Changes view shows
 * it. Ignored paths are filtered with the same `git check-ignore` pass
 * getStatus applies, so both views agree on what "untracked" means.
 */
async function readUntrackedRows(
  repoPath: string,
  status: StatusResult
): Promise<CompareFileDiff[]> {
  const paths = status.files.filter((f) => f.working_dir === '?').map((f) => f.path);
  const ignored = await getIgnoredFiles(repoPath, paths);
  const rows: CompareFileDiff[] = [];
  for (const filepath of paths) {
    if (ignored.has(filepath)) continue;
    const diff = await getDiffForUntracked(repoPath, filepath);
    // Nothing readable behind the path (a collapsed directory entry, a
    // non-regular file, a symlink out of the repo): no row rather than an
    // empty one that reads as "no changes".
    if (diff.lines.length === 0) continue;
    rows.push({
      path: filepath,
      status: 'added',
      additions: diff.lines.filter((l) => l.type === 'addition').length,
      deletions: 0,
      diff,
      uncommitted: 'untracked',
    });
  }
  return rows;
}

/**
 * The branch-vs-base compare, optionally folding in uncommitted work.
 *
 * The three categories are independent: staged (HEAD vs index), unstaged
 * (index vs working tree) and untracked (files git diff never reports).
 * Asking for none of them is the plain committed compare. Asking for
 * staged AND unstaged reads them as one `git diff HEAD` — see
 * trackedSide for why that must not be two diffs.
 *
 * An uncommitted row is kept SEPARATE from the committed row for the same
 * path rather than merged into it: the two sit against different bases
 * (the merge-base and the index/HEAD), so one merged row would be a diff
 * of nothing in particular.
 */
export async function getCompareDiff(
  repoPath: string,
  baseRef: string,
  parts: UncommittedParts = NO_UNCOMMITTED
): Promise<CompareDiff> {
  const committedDiff = await getDiffBetweenRefs(repoPath, baseRef);
  const side = trackedSide(parts);
  if (side === null && !parts.untracked) return committedDiff;

  const status = await createGit(repoPath).status();
  const uncommittedRows: CompareFileDiff[] = [
    ...(side === null ? [] : await readTrackedRows(repoPath, side, status)),
    ...(parts.untracked ? await readUntrackedRows(repoPath, status) : []),
  ];

  // Committed rows keep their place; an uncommitted row for the same path
  // is listed right after it, and one for a path the branch never
  // committed is appended.
  const committedPaths = new Set(committedDiff.files.map((f) => f.path));
  const mergedFiles: CompareFileDiff[] = [];
  for (const file of committedDiff.files) {
    mergedFiles.push(file);
    mergedFiles.push(...uncommittedRows.filter((f) => f.path === file.path));
  }
  mergedFiles.push(...uncommittedRows.filter((f) => !committedPaths.has(f.path)));

  mergedFiles.sort((a, b) => a.path.localeCompare(b.path));

  // filesChanged counts distinct PATHS: a file listed twice (committed and
  // uncommitted) is still one file changed.
  const seenPaths = new Set(mergedFiles.map((f) => f.path));
  return {
    baseBranch: committedDiff.baseBranch,
    stats: {
      filesChanged: seenPaths.size,
      additions: mergedFiles.reduce((sum, f) => sum + f.additions, 0),
      deletions: mergedFiles.reduce((sum, f) => sum + f.deletions, 0),
    },
    files: mergedFiles,
    commits: committedDiff.commits,
    uncommittedCount: committedDiff.uncommittedCount,
  };
}
