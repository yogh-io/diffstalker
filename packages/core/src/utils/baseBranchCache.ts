import * as fs from 'node:fs';
import * as path from 'node:path';
import { cacheDir } from './xdg.js';
import { ensureTargetDir } from './pathUtils.js';
import * as logger from './logger.js';

function cachePath(): string {
  return path.join(cacheDir(), 'base-branches.json');
}

interface BaseBranchCache {
  [repoPath: string]: string;
}

function loadCache(): BaseBranchCache {
  const file = cachePath();
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err) {
    // The file is there but cannot be used: every stored base-branch
    // choice is gone, and the next save overwrites the file. Worth a line.
    logger.warn('Ignoring the base-branch cache', err, { file });
    return {};
  }
}

function saveCache(cache: BaseBranchCache): void {
  ensureTargetDir(cachePath());
  fs.writeFileSync(cachePath(), JSON.stringify(cache, null, 2) + '\n');
}

/**
 * Get the cached base branch for a repository.
 * Returns undefined if no cached value exists.
 */
export function getCachedBaseBranch(repoPath: string): string | undefined {
  const cache = loadCache();
  // Normalize path for consistent lookup
  const normalizedPath = path.resolve(repoPath);
  return cache[normalizedPath];
}

/**
 * Save the selected base branch for a repository to the cache.
 */
export function setCachedBaseBranch(repoPath: string, baseBranch: string): void {
  const cache = loadCache();
  const normalizedPath = path.resolve(repoPath);
  cache[normalizedPath] = baseBranch;
  saveCache(cache);
}
