import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const CACHE_PATH = path.join(os.homedir(), '.cache', 'diffstalker', 'base-branches.json');

interface BaseBranchCache {
  [repoPath: string]: string;
}

function ensureCacheDir(): void {
  const dir = path.dirname(CACHE_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function loadCache(): BaseBranchCache {
  try {
    if (fs.existsSync(CACHE_PATH)) {
      return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8'));
    }
  } catch {
    // Ignore read errors, return empty cache
  }
  return {};
}

function saveCache(cache: BaseBranchCache): void {
  ensureCacheDir();
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2) + '\n');
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
