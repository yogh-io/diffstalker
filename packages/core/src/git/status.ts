import { SimpleGit, StatusResult } from 'simple-git';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createGit, gitEnv } from './gitClient.js';
import { getIgnoredFiles } from './ignoreUtils.js';
import { MAX_FILE_DIFF_BYTES } from './diffParse.js';

export type FileStatus =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'untracked'
  | 'renamed'
  | 'copied'
  /** Unmerged path: a conflict a client must not stage or diff as an ordinary change. */
  | 'conflicted';

interface FileStats {
  insertions: number;
  deletions: number;
}

// Parse git diff --numstat output into a map of path -> stats
export function parseNumstat(output: string): Map<string, FileStats> {
  const stats = new Map<string, FileStats>();
  for (const line of output.trim().split('\n')) {
    if (!line) continue;
    const parts = line.split('\t');
    if (parts.length >= 3) {
      const insertions = parts[0] === '-' ? 0 : parseInt(parts[0], 10);
      const deletions = parts[1] === '-' ? 0 : parseInt(parts[1], 10);
      const filepath = parts.slice(2).join('\t'); // Handle paths with tabs
      stats.set(filepath, { insertions, deletions });
    }
  }
  return stats;
}

/** Cap on the untracked file read below: the same per-file cap the diff path
 *  uses for an untracked file, so one threshold governs "too big to read". */
const MAX_UNTRACKED_COUNT_BYTES = MAX_FILE_DIFF_BYTES;

/**
 * Count lines in a file (for untracked files which don't show in numstat).
 *
 * Returns null when the file was NOT read: not a regular file, over the
 * size cap, or unreadable. Null means "unknown" and the caller then leaves
 * the +/- stats off that entry — reporting 0 for a file we refused to read
 * would show a real file as empty, and a wrong number is worse than none.
 */
async function countFileLines(repoPath: string, filePath: string): Promise<number | null> {
  try {
    const fullPath = path.join(repoPath, filePath);
    // Never read a non-regular file: an untracked FIFO would make this
    // readFile never resolve and wedge the refresh queue forever.
    const stats = await fs.promises.stat(fullPath);
    if (!stats.isFile()) return null;
    // Stat before reading. Slurping the whole file to count its lines put a
    // single call at 919MB RSS for one 405MB untracked file; over the cap
    // the file is never opened.
    if (stats.size > MAX_UNTRACKED_COUNT_BYTES) return null;
    const content = await fs.promises.readFile(fullPath, 'utf-8');
    // Count non-empty lines
    return content.split('\n').filter((line) => line.length > 0).length;
  } catch {
    return null;
  }
}

export interface FileEntry {
  path: string;
  status: FileStatus;
  staged: boolean;
  originalPath?: string; // For renamed files
  insertions?: number;
  deletions?: number;
}

export interface BranchInfo {
  current: string;
  tracking?: string;
  ahead: number;
  behind: number;
}

export interface GitStatus {
  files: FileEntry[];
  branch: BranchInfo;
  isRepo: boolean;
}

/**
 * The seven porcelain code pairs git uses for an unmerged path. Five carry
 * a 'U' in one column, but 'AA' (both added) and 'DD' (both deleted) do
 * not — read one column at a time those look like an ordinary add or
 * delete, so the pair has to be matched as a whole.
 */
const UNMERGED_CODE_PAIRS = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

/** True when the index + worktree code pair marks the path as unmerged. */
export function isUnmergedPair(index: string, workingDir: string): boolean {
  return UNMERGED_CODE_PAIRS.has(`${index}${workingDir}`);
}

/**
 * Status for one column of a porcelain pair. An unmerged pair overrides
 * both columns: neither side of a conflict is an ordinary change a client
 * may stage.
 */
function entryStatus(code: string, conflicted: boolean): FileStatus {
  return conflicted ? 'conflicted' : parseStatusCode(code);
}

export function parseStatusCode(code: string): FileStatus {
  switch (code) {
    case 'M':
      return 'modified';
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case '?':
      return 'untracked';
    case 'R':
      return 'renamed';
    case 'C':
      return 'copied';
    case 'U':
      return 'conflicted';
    default:
      return 'modified';
  }
}

/**
 * Read the repository status. Returns isRepo: false only for a directory
 * that genuinely is not a git repository; any other failure (index.lock
 * contention, permissions, git missing) propagates so callers can surface
 * it without wiping the previous status.
 */
export async function getStatus(repoPath: string): Promise<GitStatus> {
  const git: SimpleGit = createGit(repoPath);

  const isRepo = await git.checkIsRepo();
  if (!isRepo) {
    return {
      files: [],
      branch: { current: '', ahead: 0, behind: 0 },
      isRepo: false,
    };
  }

  const status: StatusResult = await git.status();

  // Build processed file list, filtering ignored files
  const processedFiles: FileEntry[] = [];
  const seen = new Set<string>();

  const untrackedPaths = status.files.filter((f) => f.working_dir === '?').map((f) => f.path);
  const ignoredFiles = await getIgnoredFiles(repoPath, untrackedPaths);

  for (const file of status.files) {
    if (file.index === '!' || file.working_dir === '!' || ignoredFiles.has(file.path)) {
      continue;
    }

    const key = `${file.path}-${file.index !== ' ' && file.index !== '?'}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // An unmerged path keeps its two entries (index side + worktree side);
    // only the status changes, so the file lists' index math is untouched.
    const conflicted = isUnmergedPair(file.index, file.working_dir);

    if (file.index && file.index !== ' ' && file.index !== '?') {
      const status = entryStatus(file.index, conflicted);
      processedFiles.push({
        path: file.path,
        status,
        staged: true,
        // Where the file came from, for a rename or copy. git reports it on
        // the index side only (the working-tree column never carries R/C: a
        // rename is a change to the index, and any later edit shows up as a
        // plain M on the new path), so only the staged entry can carry it.
        // Consumers that need the pre-rename blob — the file lists' "<- old
        // path" suffix, and /media resolving the old side of an image diff —
        // have no other source for it: `path` is already the new name.
        ...(file.from && (status === 'renamed' || status === 'copied')
          ? { originalPath: file.from }
          : {}),
      });
    }

    if (file.working_dir && file.working_dir !== ' ') {
      processedFiles.push({
        path: file.path,
        status: entryStatus(file.working_dir, conflicted),
        staged: false,
      });
    }
  }

  // Fetch line stats for staged and unstaged files
  const [stagedNumstat, unstagedNumstat] = await Promise.all([
    git.diff(['--cached', '--numstat']).catch(() => ''),
    git.diff(['--numstat']).catch(() => ''),
  ]);

  const stagedStats = parseNumstat(stagedNumstat);
  const unstagedStats = parseNumstat(unstagedNumstat);

  for (const file of processedFiles) {
    const stats = file.staged ? stagedStats.get(file.path) : unstagedStats.get(file.path);
    if (stats) {
      file.insertions = stats.insertions;
      file.deletions = stats.deletions;
    }
  }

  // Count lines for untracked files (not in numstat output)
  const untrackedFiles = processedFiles.filter((f) => f.status === 'untracked');
  if (untrackedFiles.length > 0) {
    const lineCounts = await Promise.all(
      untrackedFiles.map((f) => countFileLines(repoPath, f.path))
    );
    for (let i = 0; i < untrackedFiles.length; i++) {
      const count = lineCounts[i];
      // Unknown line count: leave the stats absent rather than claim zero.
      if (count === null) continue;
      untrackedFiles[i].insertions = count;
      untrackedFiles[i].deletions = 0;
    }
  }

  return {
    files: processedFiles,
    branch: {
      current: status.current || 'HEAD',
      tracking: status.tracking || undefined,
      ahead: status.ahead,
      behind: status.behind,
    },
    isRepo: true,
  };
}

export async function stageFile(repoPath: string, filePath: string): Promise<void> {
  const git = createGit(repoPath);
  // '--' keeps a path like '-u' or '-A' from being read as a flag
  await git.add(['--', filePath]);
}

export async function unstageFile(repoPath: string, filePath: string): Promise<void> {
  const git = createGit(repoPath);
  await git.reset(['HEAD', '--', filePath]);
}

export async function stageAll(repoPath: string): Promise<void> {
  const git = createGit(repoPath);
  await git.add('-A');
}

export async function unstageAll(repoPath: string): Promise<void> {
  const git = createGit(repoPath);
  await git.reset(['HEAD']);
}

export async function discardChanges(repoPath: string, filePath: string): Promise<void> {
  const git = createGit(repoPath);
  // Restore the file to its state in HEAD (discard working directory changes)
  await git.checkout(['--', filePath]);
}

export async function deleteUntracked(repoPath: string, filePath: string): Promise<void> {
  const git = createGit(repoPath);
  await git.clean('f', ['--', filePath]);
}

export async function commit(
  repoPath: string,
  message: string,
  amend: boolean = false
): Promise<void> {
  // Runs the user's pre-commit / commit-msg hooks, which are silent for
  // as long as they take. The short idle budget would kill them.
  const git = createGit(repoPath, { longRunning: true });
  const result = await git.commit(message, undefined, amend ? { '--amend': null } : undefined);
  // simple-git swallows "nothing to commit" (exit 1) and resolves with an
  // empty commit hash. Reporting success for a commit that never happened
  // is data loss from the caller's perspective — fail loud instead.
  if (!result.commit) {
    throw new Error('Nothing to commit: no staged changes');
  }
}

export async function getHeadMessage(repoPath: string): Promise<string> {
  const git = createGit(repoPath);
  try {
    const log = await git.log({ n: 1 });
    return log.latest?.message || '';
  } catch {
    return '';
  }
}

export interface CommitInfo {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  date: Date;
  refs: string;
}

export function stageHunk(repoPath: string, patch: string): void {
  execFileSync('git', ['apply', '--cached', '--unidiff-zero'], {
    cwd: repoPath,
    input: patch,
    encoding: 'utf-8',
    env: gitEnv(),
  });
}

export function unstageHunk(repoPath: string, patch: string): void {
  execFileSync('git', ['apply', '--cached', '--reverse', '--unidiff-zero'], {
    cwd: repoPath,
    input: patch,
    encoding: 'utf-8',
    env: gitEnv(),
  });
}

export async function push(repoPath: string): Promise<string> {
  // Talks to a remote, and git is silent while a pack is negotiated (it
  // only writes progress when stderr is a TTY, which it is not here).
  const git = createGit(repoPath, { longRunning: true });
  const result = await git.push();
  // Build a summary string from the push result
  const pushed = result.pushed;
  if (pushed.length === 0) return 'Everything up-to-date';
  return pushed.map((p) => `${p.local} → ${p.remote}`).join(', ');
}

export async function fetchRemote(repoPath: string): Promise<string> {
  // Talks to a remote. See push().
  const git = createGit(repoPath, { longRunning: true });
  await git.fetch();
  return 'Fetch complete';
}

export async function pullRebase(repoPath: string): Promise<string> {
  // Talks to a remote AND runs commit hooks on the rebase. See push().
  const git = createGit(repoPath, { longRunning: true });
  const result = await git.pull(['--rebase']);
  if (
    result.summary.changes === 0 &&
    result.summary.insertions === 0 &&
    result.summary.deletions === 0
  ) {
    return 'Already up-to-date';
  }
  return `${result.summary.changes} file(s) changed`;
}

export async function getCommitHistory(
  repoPath: string,
  count: number = 50
): Promise<CommitInfo[]> {
  const git = createGit(repoPath);
  try {
    const log = await git.log({ n: count });
    return log.all.map((entry) => ({
      hash: entry.hash,
      shortHash: entry.hash.slice(0, 7),
      message: entry.message.split('\n')[0], // First line only
      author: entry.author_name,
      date: new Date(entry.date),
      refs: entry.refs || '',
    }));
  } catch {
    return [];
  }
}

/**
 * One commit by hash (or any rev), or null when it does not resolve.
 * Deep links name a commit that may be far older than any page of the log
 * a client has pulled — resolving it directly beats re-pulling the log at
 * an ever larger count until it appears.
 */
export async function getCommit(repoPath: string, rev: string): Promise<CommitInfo | null> {
  const git = createGit(repoPath);
  try {
    // `--no-walk <rev>`: THAT commit, not the history leading to it, and
    // not a range — `{from, to}` with one rev is `rev..rev`, which is
    // empty by definition.
    const log = await git.log(['--no-walk', rev]);
    const entry = log.all[0];
    if (!entry) return null;
    return {
      hash: entry.hash,
      shortHash: entry.hash.slice(0, 7),
      message: entry.message.split('\n')[0],
      author: entry.author_name,
      date: new Date(entry.date),
      refs: entry.refs || '',
    };
  } catch {
    return null;
  }
}

// Stash operations

export interface StashEntry {
  index: number;
  message: string;
}

export async function getStashList(repoPath: string): Promise<StashEntry[]> {
  const git = createGit(repoPath);
  try {
    const result = await git.stashList();
    return result.all.map((entry, i) => ({
      index: i,
      message: entry.message,
    }));
  } catch {
    return [];
  }
}

export async function stashSave(repoPath: string, message?: string): Promise<string> {
  const git = createGit(repoPath);
  const args = ['push'];
  if (message) args.push('-m', message);
  await git.stash(args);
  return 'Stashed';
}

export async function stashPop(repoPath: string, index: number = 0): Promise<string> {
  const git = createGit(repoPath);
  await git.stash(['pop', `stash@{${index}}`]);
  // A conflicting pop exits 1 but simple-git resolves anyway (proven
  // empirically), which would report success for a working tree full of
  // conflict markers. Detect unmerged paths and fail loud; git keeps the
  // stash entry, so nothing is lost.
  const unmerged = (await git.raw(['diff', '--name-only', '--diff-filter=U'])).trim();
  if (unmerged) {
    throw new Error(`Stash pop hit conflicts in: ${unmerged.split('\n').join(', ')}`);
  }
  return 'Stash popped';
}

// Branch operations

export interface LocalBranch {
  name: string;
  current: boolean;
  tracking?: string;
}

export async function getLocalBranches(repoPath: string): Promise<LocalBranch[]> {
  const git = createGit(repoPath);
  const result = await git.branchLocal();
  return result.all.map((name) => ({
    name,
    current: name === result.current,
    tracking: result.branches[name]?.label || undefined,
  }));
}

export async function switchBranch(repoPath: string, name: string): Promise<string> {
  const git = createGit(repoPath);
  // '--' keeps a name like '-f' from being read as a flag: `git checkout -f`
  // would hard-discard the working tree. `git switch -- <name>` refuses it.
  await git.raw(['switch', '--', name]);
  return `Switched to ${name}`;
}

export async function createBranch(repoPath: string, name: string): Promise<string> {
  const git = createGit(repoPath);
  // `-c` consumes the next argv as the branch name, and git rejects any
  // name starting with '-' as an invalid ref — so a flag-shaped name
  // ('-f', '--detach') can never be parsed as an option here.
  await git.raw(['switch', '-c', name]);
  return `Created ${name}`;
}

// Undo operations

export async function softResetHead(repoPath: string, count: number = 1): Promise<string> {
  const git = createGit(repoPath);
  await git.reset(['--soft', `HEAD~${count}`]);
  return 'Reset done';
}

// History actions

export async function cherryPick(repoPath: string, hash: string): Promise<string> {
  // Runs commit hooks. See commit().
  const git = createGit(repoPath, { longRunning: true });
  // --end-of-options: a hash like '--abort' must never be read as a flag
  await git.raw(['cherry-pick', '--end-of-options', hash]);
  return 'Cherry-picked';
}

export async function revertCommit(repoPath: string, hash: string): Promise<string> {
  // Runs commit hooks. See commit().
  const git = createGit(repoPath, { longRunning: true });
  await git.raw(['revert', '--no-edit', '--end-of-options', hash]);
  return 'Reverted';
}

// In-progress operations (conflicted rebase/cherry-pick/revert/merge)

export type InProgressOperation = 'rebase' | 'cherry-pick' | 'revert' | 'merge';

/**
 * Which multi-step git operation the repo is currently stopped in, if any.
 * Detected from the git dir markers git itself uses.
 */
export async function getInProgressOperation(
  repoPath: string
): Promise<InProgressOperation | null> {
  const git = createGit(repoPath);
  let gitDir: string;
  try {
    gitDir = (await git.raw(['rev-parse', '--absolute-git-dir'])).trim();
  } catch {
    return null;
  }
  const has = (marker: string): boolean => fs.existsSync(path.join(gitDir, marker));
  if (has('rebase-merge') || has('rebase-apply')) return 'rebase';
  if (has('CHERRY_PICK_HEAD')) return 'cherry-pick';
  if (has('REVERT_HEAD')) return 'revert';
  if (has('MERGE_HEAD')) return 'merge';
  return null;
}

/**
 * Abort whatever multi-step operation the repo is stopped in, returning it
 * to the pre-operation state. Throws when nothing is in progress.
 */
export async function abortOperation(repoPath: string): Promise<string> {
  const operation = await getInProgressOperation(repoPath);
  if (!operation) {
    throw new Error('No operation in progress to abort');
  }
  const git = createGit(repoPath);
  await git.raw([operation, '--abort']);
  return `Aborted ${operation}`;
}

/**
 * Continue a stopped rebase after conflicts have been resolved and staged.
 * core.editor=true accepts the prepared commit message — a headless caller
 * cannot open an editor.
 */
export async function rebaseContinue(repoPath: string): Promise<string> {
  // Runs commit hooks. See commit().
  const git = createGit(repoPath, { longRunning: true });
  await git.raw(['-c', 'core.editor=true', 'rebase', '--continue']);
  return 'Rebase continued';
}

/**
 * List all files in the repo: tracked files + untracked (not ignored) files.
 * Uses git ls-files which is fast (git already has the index in memory).
 */
export async function listAllFiles(repoPath: string): Promise<string[]> {
  const git = createGit(repoPath);
  const result = await git.raw(['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  return result.split('\0').filter((f) => f.length > 0);
}
