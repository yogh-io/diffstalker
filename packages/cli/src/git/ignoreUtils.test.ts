import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getIgnoredFiles } from './ignoreUtils.js';
import { createFixtureRepo, removeFixtureRepo, writeFixtureFile, gitExec } from './test-helpers.js';

describe('getIgnoredFiles (fixture)', () => {
  const REPO_NAME = 'ignore-utils-test';
  let repoPath: string;

  beforeAll(() => {
    repoPath = createFixtureRepo(REPO_NAME);

    // Create .gitignore
    writeFixtureFile(repoPath, '.gitignore', '*.log\nbuild/\n');
    gitExec(repoPath, 'add .gitignore');
    gitExec(repoPath, 'commit -m "add gitignore"');

    // Create some ignored and non-ignored files
    writeFixtureFile(repoPath, 'app.ts', 'console.log("hi");');
    writeFixtureFile(repoPath, 'debug.log', 'log output');
    writeFixtureFile(repoPath, 'error.log', 'error output');
    writeFixtureFile(repoPath, 'build/output.js', 'built');
    writeFixtureFile(repoPath, 'src/main.ts', 'main');
  });

  afterAll(() => {
    removeFixtureRepo(REPO_NAME);
  });

  it('returns empty set for empty file list', async () => {
    const result = await getIgnoredFiles(repoPath, []);
    expect(result.size).toBe(0);
  });

  it('identifies .log files as ignored', async () => {
    const result = await getIgnoredFiles(repoPath, ['debug.log', 'error.log', 'app.ts']);
    expect(result.has('debug.log')).toBe(true);
    expect(result.has('error.log')).toBe(true);
    expect(result.has('app.ts')).toBe(false);
  });

  it('identifies build/ directory files as ignored', async () => {
    const result = await getIgnoredFiles(repoPath, ['build/output.js', 'src/main.ts']);
    expect(result.has('build/output.js')).toBe(true);
    expect(result.has('src/main.ts')).toBe(false);
  });

  it('returns empty set when no files are ignored', async () => {
    const result = await getIgnoredFiles(repoPath, ['app.ts', 'src/main.ts']);
    expect(result.size).toBe(0);
  });
});
