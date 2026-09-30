import { createGit } from './gitClient.js';
import * as logger from '../utils/logger.js';

/**
 * Check which files from a list are ignored by git.
 * Uses `git check-ignore` to determine ignored files.
 */
export async function getIgnoredFiles(repoPath: string, files: string[]): Promise<Set<string>> {
  if (files.length === 0) return new Set();

  const git = createGit(repoPath);
  const batchSize = 100;

  const batches: string[][] = [];
  for (let i = 0; i < files.length; i += batchSize) {
    batches.push(files.slice(i, i + batchSize));
  }
  // The batches are independent, so they run together rather than each
  // waiting for the last.
  const results = await Promise.all(
    batches.map(async (batch) => {
      try {
        // '--' keeps a flag-shaped path (a file literally named '-q') from
        // being read as an option
        return await git.raw(['check-ignore', '--', ...batch]);
      } catch (err) {
        // check-ignore exits with code 1 when no file is ignored, which
        // throws — with nothing on stderr. A real failure says why on
        // stderr, and that is the message simple-git throws with. Either
        // way the batch counts as not ignored.
        const message = err instanceof Error ? err.message.trim() : String(err);
        if (message) {
          logger.warn('git check-ignore failed; ignored files may show as untracked', err, {
            repo: repoPath,
          });
        }
        return '';
      }
    })
  );

  const ignoredFiles = new Set<string>();
  for (const result of results) {
    for (const f of result.trim().split('\n')) {
      if (f.length > 0) ignoredFiles.add(f);
    }
  }
  return ignoredFiles;
}
