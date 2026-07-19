import { simpleGit } from 'simple-git';

/**
 * Check which files from a list are ignored by git.
 * Uses `git check-ignore` to determine ignored files.
 */
export async function getIgnoredFiles(repoPath: string, files: string[]): Promise<Set<string>> {
  if (files.length === 0) return new Set();

  const git = simpleGit(repoPath);
  const ignoredFiles = new Set<string>();
  const batchSize = 100;

  for (let i = 0; i < files.length; i += batchSize) {
    const batch = files.slice(i, i + batchSize);
    try {
      const result = await git.raw(['check-ignore', ...batch]);
      const ignored = result
        .trim()
        .split('\n')
        .filter((f) => f.length > 0);
      for (const f of ignored) {
        ignoredFiles.add(f);
      }
    } catch {
      // check-ignore exits with code 1 if no files are ignored, which throws
      // Just continue to next batch
    }
  }

  return ignoredFiles;
}
