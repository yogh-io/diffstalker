import { execSync, spawn } from 'node:child_process';
import { simpleGit } from 'simple-git';

export interface DiffLine {
  type: 'header' | 'hunk' | 'addition' | 'deletion' | 'context';
  content: string;
}

export interface DiffResult {
  raw: string;
  lines: DiffLine[];
}

export interface PRDiffStats {
  filesChanged: number;
  additions: number;
  deletions: number;
}

export interface PRFileDiff {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
  diff: DiffResult;
}

export interface PRDiff {
  baseBranch: string;
  stats: PRDiffStats;
  files: PRFileDiff[];
  uncommittedCount: number;
}

function parseDiffLine(line: string): DiffLine {
  if (line.startsWith('diff --git') || line.startsWith('index ') ||
      line.startsWith('---') || line.startsWith('+++') ||
      line.startsWith('new file') || line.startsWith('deleted file')) {
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
    const lines = raw.split('\n').map(parseDiffLine);

    return { raw, lines };
  } catch (error) {
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

    for (const line of contentLines) {
      lines.push({ type: 'addition', content: '+' + line });
    }

    const raw = lines.map(l => l.content).join('\n');
    return { raw, lines };
  } catch {
    return { raw: '', lines: [] };
  }
}

export async function getStagedDiff(repoPath: string): Promise<DiffResult> {
  return getDiff(repoPath, undefined, true);
}

export function spawnPager(pager: string, diff: string): void {
  const [cmd, ...args] = pager.split(' ');
  const proc = spawn(cmd, args, {
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  proc.stdin.write(diff);
  proc.stdin.end();
}

/**
 * Get the best default base branch for PR comparison.
 * Tries origin/main, origin/master, upstream/main, upstream/master in order.
 */
export async function getDefaultBaseBranch(repoPath: string): Promise<string | null> {
  const git = simpleGit(repoPath);
  const candidates = ['origin/main', 'origin/master', 'upstream/main', 'upstream/master'];

  for (const candidate of candidates) {
    try {
      await git.raw(['rev-parse', '--verify', candidate]);
      return candidate;
    } catch {
      // Ref doesn't exist, try next
    }
  }
  return null;
}

/**
 * Get diff between HEAD and a base ref (for PR-like view).
 * Uses three-dot diff (merge-base) to show only changes on current branch.
 */
export async function getDiffBetweenRefs(repoPath: string, baseRef: string): Promise<PRDiff> {
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
  const numstatLines = numstat.trim().split('\n').filter(l => l);
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
  const nameStatusLines = nameStatus.trim().split('\n').filter(l => l);
  const fileStatuses: Map<string, PRFileDiff['status']> = new Map();
  for (const line of nameStatusLines) {
    const parts = line.split('\t');
    if (parts.length >= 2) {
      const statusChar = parts[0][0];
      const filepath = parts[parts.length - 1]; // Use last part for renamed files
      let status: PRFileDiff['status'];
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
  const fileDiffs: PRFileDiff[] = [];
  const diffChunks = rawDiff.split(/(?=^diff --git )/m).filter(chunk => chunk.trim());

  for (const chunk of diffChunks) {
    // Extract file path from the diff header
    const match = chunk.match(/^diff --git a\/.+ b\/(.+)$/m);
    if (!match) continue;

    const filepath = match[1];
    const lines = chunk.split('\n').map(parseDiffLine);
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

  return {
    baseBranch: baseRef,
    stats: {
      filesChanged: fileDiffs.length,
      additions: totalAdditions,
      deletions: totalDeletions,
    },
    files: fileDiffs,
    uncommittedCount,
  };
}
