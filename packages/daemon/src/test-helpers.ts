import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const FIXTURES_DIR = path.resolve(import.meta.dirname, '../test-fixtures');

/**
 * Create a fixture git repo with initial config.
 */
export function createFixtureRepo(name: string): string {
  const repoPath = path.join(FIXTURES_DIR, name);
  fs.rmSync(repoPath, { recursive: true, force: true });
  fs.mkdirSync(repoPath, { recursive: true });
  gitExec(repoPath, 'init --initial-branch=main');
  gitExec(repoPath, 'config user.email "test@test.com"');
  gitExec(repoPath, 'config user.name "Test User"');
  return repoPath;
}

/**
 * Remove a fixture repo directory.
 */
export function removeFixtureRepo(name: string): void {
  const repoPath = path.join(FIXTURES_DIR, name);
  fs.rmSync(repoPath, { recursive: true, force: true });
}

/**
 * Write a file inside a fixture repo, creating parent directories as needed.
 */
export function writeFixtureFile(repoPath: string, filePath: string, content: string): void {
  const fullPath = path.join(repoPath, filePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

/**
 * Run a git command in a fixture repo.
 */
export function gitExec(repoPath: string, command: string): string {
  return execSync(`git ${command}`, {
    cwd: repoPath,
    encoding: 'utf-8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}
