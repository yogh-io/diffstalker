import { simpleGit, SimpleGit, StatusResult } from 'simple-git';

export type FileStatus = 'modified' | 'added' | 'deleted' | 'untracked' | 'renamed' | 'copied';

// Check which files from a list are ignored by git
async function getIgnoredFiles(git: SimpleGit, files: string[]): Promise<Set<string>> {
  if (files.length === 0) return new Set();

  try {
    // git check-ignore returns the list of ignored files (one per line)
    // Pass files as arguments (limit batch size to avoid command line length issues)
    const ignoredFiles = new Set<string>();
    const batchSize = 100;

    for (let i = 0; i < files.length; i += batchSize) {
      const batch = files.slice(i, i + batchSize);
      try {
        const result = await git.raw(['check-ignore', ...batch]);
        const ignored = result.trim().split('\n').filter(f => f.length > 0);
        for (const f of ignored) {
          ignoredFiles.add(f);
        }
      } catch {
        // check-ignore exits with code 1 if no files are ignored, which throws
        // Just continue to next batch
      }
    }

    return ignoredFiles;
  } catch {
    // If check-ignore fails entirely, return empty set
    return new Set();
  }
}

export interface FileEntry {
  path: string;
  status: FileStatus;
  staged: boolean;
  originalPath?: string; // For renamed files
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

function parseStatusCode(code: string): FileStatus {
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
    const files: FileEntry[] = [];

    // Process staged files
    for (const file of status.staged) {
      files.push({
        path: file,
        status: 'added',
        staged: true,
      });
    }

    // Process modified staged files
    for (const file of status.modified) {
      // Check if it's in the index (staged)
      const existingStaged = files.find(f => f.path === file && f.staged);
      if (!existingStaged) {
        files.push({
          path: file,
          status: 'modified',
          staged: false,
        });
      }
    }

    // Process deleted files
    for (const file of status.deleted) {
      files.push({
        path: file,
        status: 'deleted',
        staged: false,
      });
    }

    // Process untracked files
    for (const file of status.not_added) {
      files.push({
        path: file,
        status: 'untracked',
        staged: false,
      });
    }

    // Process renamed files
    for (const file of status.renamed) {
      files.push({
        path: file.to,
        originalPath: file.from,
        status: 'renamed',
        staged: true,
      });
    }

    // Use the files array from status for more accurate staging info
    // The status.files array has detailed index/working_dir info
    const processedFiles: FileEntry[] = [];
    const seen = new Set<string>();

    // Collect untracked files to check if they're ignored
    const untrackedPaths = status.files
      .filter(f => f.working_dir === '?')
      .map(f => f.path);

    // Get the set of ignored files
    const ignoredFiles = await getIgnoredFiles(git, untrackedPaths);

    for (const file of status.files) {
      // Skip ignored files (marked with '!' in either column, or detected by check-ignore)
      if (file.index === '!' || file.working_dir === '!' || ignoredFiles.has(file.path)) {
        continue;
      }

      const key = `${file.path}-${file.index !== ' ' && file.index !== '?'}`;
      if (seen.has(key)) continue;
      seen.add(key);

      // Staged changes (index column)
      if (file.index && file.index !== ' ' && file.index !== '?') {
        processedFiles.push({
          path: file.path,
          status: parseStatusCode(file.index),
          staged: true,
        });
      }

      // Unstaged changes (working_dir column)
      if (file.working_dir && file.working_dir !== ' ') {
        processedFiles.push({
          path: file.path,
          status: file.working_dir === '?' ? 'untracked' : parseStatusCode(file.working_dir),
          staged: false,
        });
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
  } catch (error) {
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

export async function commit(repoPath: string, message: string, amend: boolean = false): Promise<void> {
  const git = simpleGit(repoPath);
  const options = amend ? ['--amend', '-m', message] : ['-m', message];
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
