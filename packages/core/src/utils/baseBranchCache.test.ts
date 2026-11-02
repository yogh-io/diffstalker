import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getCachedBaseBranch, setCachedBaseBranch } from './baseBranchCache.js';

describe('base-branch cache', () => {
  const savedCacheHome = process.env.XDG_CACHE_HOME;
  let root: string;

  function makeRepo(name: string): string {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    return dir;
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-base-branch-'));
    process.env.XDG_CACHE_HOME = path.join(root, 'cache');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    if (savedCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = savedCacheHome;
  });

  it('keeps each repo its own choice', () => {
    const first = makeRepo('first');
    const second = makeRepo('second');
    setCachedBaseBranch(first, 'origin/main');
    setCachedBaseBranch(second, 'origin/develop');

    expect(getCachedBaseBranch(first)).toBe('origin/main');
    expect(getCachedBaseBranch(second)).toBe('origin/develop');
  });

  it('forgets a repo that is gone on the next save', () => {
    const gone = makeRepo('gone');
    const kept = makeRepo('kept');
    setCachedBaseBranch(gone, 'origin/main');
    setCachedBaseBranch(kept, 'origin/main');
    fs.rmSync(gone, { recursive: true });

    setCachedBaseBranch(makeRepo('new'), 'origin/main');

    const file = path.join(root, 'cache', 'diffstalker', 'base-branches.json');
    expect(Object.keys(JSON.parse(fs.readFileSync(file, 'utf-8')))).toEqual([
      kept,
      path.join(root, 'new'),
    ]);
  });
});
