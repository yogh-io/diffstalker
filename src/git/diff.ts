import { execSync } from 'node:child_process';
import { simpleGit } from 'simple-git';
import { CommitInfo } from './status.js';

export interface DiffLine {
  type: 'header' | 'hunk' | 'addition' | 'deletion' | 'context';
  content: string;
  /** Line number in the old file (for deletions and context) */
  oldLineNum?: number;
  /** Line number in the new file (for additions and context) */
  newLineNum?: number;
}

export interface DiffResult {
  raw: string;
  lines: DiffLine[];
}

export interface CompareDiffStats {
  filesChanged: number;
  additions: number;
  deletions: number;
}

export interface CompareFileDiff {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
  diff: DiffResult;
  isUncommitted?: boolean;
}

export interface CompareDiff {
  baseBranch: string;
  stats: CompareDiffStats;
  files: CompareFileDiff[];
  commits: CommitInfo[];
  uncommittedCount: number;
}

export function parseDiffLine(line: string): DiffLine {
  if (
    line.startsWith('diff --git') ||
    line.startsWith('index ') ||
    line.startsWith('---') ||
    line.startsWith('+++') ||
    line.startsWith('new file') ||
    line.startsWith('deleted file')
  ) {
    return { type: 'header', content: line };
  }
  if (line.startsWith('@@')) {
    return { type: 'hunk', content: line };
  }
  if (line.startsWith('+')) {
    return { type: 'addition', content: line };
  }
  if (line.startsWith('-')) {
    return { type: 'deletion', content: line };
  }
  return { type: 'context', content: line };
}

/**
 * Parse a hunk header to extract line numbers.
 * Format: @@ -oldStart,oldCount +newStart,newCount @@
 * Example: @@ -1,5 +1,7 @@ or @@ -10 +10,2 @@
 */
export function parseHunkHeader(line: string): { oldStart: number; newStart: number } | null {
  const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
  if (match) {
    return {
      oldStart: parseInt(match[1], 10),
      newStart: parseInt(match[2], 10),
    };
  }
  return null;
}

/**
 * Parse diff output with line numbers.
 * Tracks line numbers through hunks for proper display.
 */
export function parseDiffWithLineNumbers(raw: string): DiffLine[] {
  const lines = raw.split('\n');
  const result: DiffLine[] = [];

  let oldLineNum = 0;
  let newLineNum = 0;

  for (const line of lines) {
    if (
      line.startsWith('diff --git') ||
      line.startsWith('index ') ||
      line.startsWith('---') ||
      line.startsWith('+++') ||
      line.startsWith('new file') ||
      line.startsWith('deleted file') ||
      line.startsWith('Binary files') ||
      line.startsWith('similarity index') ||
      line.startsWith('rename from') ||
      line.startsWith('rename to')
    ) {
      result.push({ type: 'header', content: line });
    } else if (line.startsWith('@@')) {
      const hunkInfo = parseHunkHeader(line);
      if (hunkInfo) {
        oldLineNum = hunkInfo.oldStart;
        newLineNum = hunkInfo.newStart;
      }
      result.push({ type: 'hunk', content: line });
    } else if (line.startsWith('+')) {
      result.push({
        type: 'addition',
        content: line,
        newLineNum: newLineNum++,
      });
    } else if (line.startsWith('-')) {
      result.push({
        type: 'deletion',
        content: line,
        oldLineNum: oldLineNum++,
      });
    } else {
      // Context line (starts with space) or empty line
      result.push({
        type: 'context',
        content: line,
        oldLineNum: oldLineNum++,
        newLineNum: newLineNum++,
      });
    }
  }

  return result;
}

export async function getDiff(
  repoPath: string,
  file?: string,
  staged: boolean = false
): Promise<DiffResult> {
  const git = simpleGit(repoPath);

  try {
    const args: string[] = [];
    if (staged) {
      args.push('--cached');
    }
    if (file) {
      args.push('--', file);
    }

    const raw = await git.diff(args);
    const lines = parseDiffWithLineNumbers(raw);
    return { raw, lines };
  } catch {
    return { raw: '', lines: [] };
  }
}

export async function getDiffForUntracked(repoPath: string, file: string): Promise<DiffResult> {
  try {
    // For untracked files, show the entire file as additions
    const content = execSync(`cat "${file}"`, { cwd: repoPath, encoding: 'utf-8' });
    const lines: DiffLine[] = [
      { type: 'header', content: `diff --git a/${file} b/${file}` },
      { type: 'header', content: 'new file mode 100644' },
      { type: 'header', content: `--- /dev/null` },
      { type: 'header', content: `+++ b/${file}` },
    ];

    const contentLines = content.split('\n');
    lines.push({ type: 'hunk', content: `@@ -0,0 +1,${contentLines.length} @@` });

    let lineNum = 1;
    for (const line of contentLines) {
      lines.push({ type: 'addition', content: '+' + line, newLineNum: lineNum++ });
    }

    const raw = lines.map((l) => l.content).join('\n');
    return { raw, lines };
  } catch {
    return { raw: '', lines: [] };
  }
}

export async function getStagedDiff(repoPath: string): Promise<DiffResult> {
  return getDiff(repoPath, undefined, true);
}

/**
 * Get candidate base branches for PR comparison.
 * Uses git log to find branches that appear in recent history (likely PR targets).
 */
export async function getCandidateBaseBranches(repoPath: string): Promise<string[]> {
  const git = simpleGit(repoPath);
  const seen = new Set<string>();
  const candidates: string[] = [];

  try {
    // Get recent commits with decorations to find branches in our history
    const logOutput = await git.raw(['log', '--oneline', '--decorate=short', '--all', '-n', '200']);

    // Extract remote branch refs from decorations like (origin/main, upstream/feature)
    // eslint-disable-next-line sonarjs/slow-regex
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
 * Get diff between HEAD and a base ref (for PR-like view).
 * Uses three-dot diff (merge-base) to show only changes on current branch.
 */
export async function getDiffBetweenRefs(repoPath: string, baseRef: string): Promise<CompareDiff> {
  const git = simpleGit(repoPath);

  // Get merge-base for three-dot diff
  const mergeBase = await git.raw(['merge-base', baseRef, 'HEAD']);
  const base = mergeBase.trim();

  // Get per-file stats with --numstat
  const numstat = await git.raw(['diff', '--numstat', `${base}...HEAD`]);

  // Get file statuses with --name-status
  const nameStatus = await git.raw(['diff', '--name-status', `${base}...HEAD`]);

  // Get full diff
  const rawDiff = await git.raw(['diff', `${base}...HEAD`]);

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
      diff: { raw: chunk, lines },
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
 * Get diff for a specific commit.
 * Shows the changes introduced by that commit.
 */
export async function getCommitDiff(repoPath: string, hash: string): Promise<DiffResult> {
  const git = simpleGit(repoPath);

  try {
    // git show <hash> --format="" gives just the diff without commit metadata
    const raw = await git.raw(['show', hash, '--format=']);
    const lines = parseDiffWithLineNumbers(raw);
    return { raw, lines };
  } catch {
    return { raw: '', lines: [] };
  }
}

/**
 * Get PR diff that includes uncommitted changes (staged + unstaged).
 * Merges committed diff with working tree changes.
 */
export async function getCompareDiffWithUncommitted(
  repoPath: string,
  baseRef: string
): Promise<CompareDiff> {
  const git = simpleGit(repoPath);

  const committedDiff = await getDiffBetweenRefs(repoPath, baseRef);

  const stagedRaw = await git.diff(['--cached', '--numstat']);
  const unstagedRaw = await git.diff(['--numstat']);
  const stagedDiff = await git.diff(['--cached']);
  const unstagedDiff = await git.diff([]);

  // Parse uncommitted file stats from numstat output
  const uncommittedFiles: Map<
    string,
    { additions: number; deletions: number; staged: boolean; unstaged: boolean }
  > = new Map();

  for (const line of stagedRaw
    .trim()
    .split('\n')
    .filter((l) => l)) {
    const parts = line.split('\t');
    if (parts.length >= 3) {
      const additions = parts[0] === '-' ? 0 : parseInt(parts[0], 10);
      const deletions = parts[1] === '-' ? 0 : parseInt(parts[1], 10);
      const filepath = parts.slice(2).join('\t');
      uncommittedFiles.set(filepath, { additions, deletions, staged: true, unstaged: false });
    }
  }

  for (const line of unstagedRaw
    .trim()
    .split('\n')
    .filter((l) => l)) {
    const parts = line.split('\t');
    if (parts.length >= 3) {
      const additions = parts[0] === '-' ? 0 : parseInt(parts[0], 10);
      const deletions = parts[1] === '-' ? 0 : parseInt(parts[1], 10);
      const filepath = parts.slice(2).join('\t');
      const existing = uncommittedFiles.get(filepath);
      if (existing) {
        existing.additions += additions;
        existing.deletions += deletions;
        existing.unstaged = true;
      } else {
        uncommittedFiles.set(filepath, { additions, deletions, staged: false, unstaged: true });
      }
    }
  }

  // Build status map from git status
  const status = await git.status();
  const statusMap: Map<string, CompareFileDiff['status']> = new Map();
  for (const file of status.files) {
    if (file.index === 'A' || file.working_dir === '?') {
      statusMap.set(file.path, 'added');
    } else if (file.index === 'D' || file.working_dir === 'D') {
      statusMap.set(file.path, 'deleted');
    } else if (file.index === 'R') {
      statusMap.set(file.path, 'renamed');
    } else {
      statusMap.set(file.path, 'modified');
    }
  }

  // Split uncommitted diffs by file
  const uncommittedFileDiffs: CompareFileDiff[] = [];
  const combinedDiff = stagedDiff + unstagedDiff;
  const diffChunks = combinedDiff.split(/(?=^diff --git )/m).filter((chunk) => chunk.trim());
  const processedFiles = new Set<string>();

  for (const chunk of diffChunks) {
    const match = chunk.match(/^diff --git a\/.+ b\/(.+)$/m);
    if (!match) continue;

    const filepath = match[1];
    if (processedFiles.has(filepath)) continue;
    processedFiles.add(filepath);

    const lines = parseDiffWithLineNumbers(chunk);
    const fileStats = uncommittedFiles.get(filepath) || { additions: 0, deletions: 0 };
    const fileStatus = statusMap.get(filepath) || 'modified';

    uncommittedFileDiffs.push({
      path: filepath,
      status: fileStatus,
      additions: fileStats.additions,
      deletions: fileStats.deletions,
      diff: { raw: chunk, lines },
      isUncommitted: true,
    });
  }

  // Merge: keep committed files, add/replace with uncommitted
  const committedFilePaths = new Set(committedDiff.files.map((f) => f.path));
  const mergedFiles: CompareFileDiff[] = [];

  for (const file of committedDiff.files) {
    const uncommittedFile = uncommittedFileDiffs.find((f) => f.path === file.path);
    if (uncommittedFile) {
      mergedFiles.push(file);
      mergedFiles.push(uncommittedFile);
    } else {
      mergedFiles.push(file);
    }
  }

  for (const file of uncommittedFileDiffs) {
    if (!committedFilePaths.has(file.path)) {
      mergedFiles.push(file);
    }
  }

  // Calculate totals
  let totalAdditions = 0;
  let totalDeletions = 0;
  const seenPaths = new Set<string>();
  for (const file of mergedFiles) {
    seenPaths.add(file.path);
    totalAdditions += file.additions;
    totalDeletions += file.deletions;
  }

  mergedFiles.sort((a, b) => a.path.localeCompare(b.path));

  return {
    baseBranch: committedDiff.baseBranch,
    stats: {
      filesChanged: seenPaths.size,
      additions: totalAdditions,
      deletions: totalDeletions,
    },
    files: mergedFiles,
    commits: committedDiff.commits,
    uncommittedCount: committedDiff.uncommittedCount,
  };
}
