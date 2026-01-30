import { simpleGit, SimpleGit, StatusResult } from 'simple-git';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getIgnoredFiles } from './ignoreUtils.js';

export type FileStatus = 'modified' | 'added' | 'deleted' | 'untracked' | 'renamed' | 'copied';

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

// Count lines in a file (for untracked files which don't show in numstat)
async function countFileLines(repoPath: string, filePath: string): Promise<number> {
  try {
    const fullPath = path.join(repoPath, filePath);
    const content = await fs.promises.readFile(fullPath, 'utf-8');
    // Count non-empty lines
    return content.split('\n').filter((line) => line.length > 0).length;
  } catch {
    return 0;
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
    default:
      return 'modified';
  }
}

/**
 * Build processed file list from git status, filtering ignored files.
 */
async function buildProcessedFileList(
  statusFiles: StatusResult['files'],
  repoPath: string
): Promise<FileEntry[]> {
  const processedFiles: FileEntry[] = [];
  const seen = new Set<string>();

  const untrackedPaths = statusFiles.filter((f) => f.working_dir === '?').map((f) => f.path);
  const ignoredFiles = await getIgnoredFiles(repoPath, untrackedPaths);

  for (const file of statusFiles) {
    if (file.index === '!' || file.working_dir === '!' || ignoredFiles.has(file.path)) {
      continue;
    }

    const key = `${file.path}-${file.index !== ' ' && file.index !== '?'}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (file.index && file.index !== ' ' && file.index !== '?') {
      processedFiles.push({
        path: file.path,
        status: parseStatusCode(file.index),
        staged: true,
      });
    }

    if (file.working_dir && file.working_dir !== ' ') {
      processedFiles.push({
        path: file.path,
        status: file.working_dir === '?' ? 'untracked' : parseStatusCode(file.working_dir),
        staged: false,
      });
    }
  }

  return processedFiles;
}

/**
 * Apply numstat line counts to file entries.
 */
function applyLineStats(
  files: FileEntry[],
  stagedStats: Map<string, FileStats>,
  unstagedStats: Map<string, FileStats>
): void {
  for (const file of files) {
    const stats = file.staged ? stagedStats.get(file.path) : unstagedStats.get(file.path);
    if (stats) {
      file.insertions = stats.insertions;
      file.deletions = stats.deletions;
    }
  }
}

/**
 * Count lines for untracked files (not in numstat output).
 */
async function countUntrackedFileLines(files: FileEntry[], repoPath: string): Promise<void> {
  const untrackedFiles = files.filter((f) => f.status === 'untracked');
  if (untrackedFiles.length === 0) return;

  const lineCounts = await Promise.all(untrackedFiles.map((f) => countFileLines(repoPath, f.path)));
  for (let i = 0; i < untrackedFiles.length; i++) {
    untrackedFiles[i].insertions = lineCounts[i];
    untrackedFiles[i].deletions = 0;
  }
}

export async function getStatus(repoPath: string): Promise<GitStatus> {
  const git: SimpleGit = simpleGit(repoPath);

  try {
    const isRepo = await git.checkIsRepo();
    if (!isRepo) {
      return {
        files: [],
        branch: { current: '', ahead: 0, behind: 0 },
        isRepo: false,
      };
    }

    const status: StatusResult = await git.status();

    const processedFiles = await buildProcessedFileList(status.files, repoPath);

    const [stagedNumstat, unstagedNumstat] = await Promise.all([
      git.diff(['--cached', '--numstat']).catch(() => ''),
      git.diff(['--numstat']).catch(() => ''),
    ]);

    applyLineStats(processedFiles, parseNumstat(stagedNumstat), parseNumstat(unstagedNumstat));
    await countUntrackedFileLines(processedFiles, repoPath);

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
  } catch {
    return {
      files: [],
      branch: { current: '', ahead: 0, behind: 0 },
      isRepo: false,
    };
  }
}

export async function stageFile(repoPath: string, filePath: string): Promise<void> {
  const git = simpleGit(repoPath);
  await git.add(filePath);
}

export async function unstageFile(repoPath: string, filePath: string): Promise<void> {
  const git = simpleGit(repoPath);
  await git.reset(['HEAD', '--', filePath]);
}

export async function stageAll(repoPath: string): Promise<void> {
  const git = simpleGit(repoPath);
  await git.add('-A');
}

export async function unstageAll(repoPath: string): Promise<void> {
  const git = simpleGit(repoPath);
  await git.reset(['HEAD']);
}

export async function discardChanges(repoPath: string, filePath: string): Promise<void> {
  const git = simpleGit(repoPath);
  // Restore the file to its state in HEAD (discard working directory changes)
  await git.checkout(['--', filePath]);
}

export async function commit(
  repoPath: string,
  message: string,
  amend: boolean = false
): Promise<void> {
  const git = simpleGit(repoPath);
  await git.commit(message, undefined, amend ? { '--amend': null } : undefined);
}

export async function getHeadMessage(repoPath: string): Promise<string> {
  const git = simpleGit(repoPath);
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

export async function getCommitHistory(
  repoPath: string,
  count: number = 50
): Promise<CommitInfo[]> {
  const git = simpleGit(repoPath);
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
