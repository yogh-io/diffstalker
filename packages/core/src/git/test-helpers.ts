import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const FIXTURES_DIR = path.resolve(import.meta.dirname, '../../test-fixtures');

/**
 * Create a fixture git repo with initial config.
 */
export function createFixtureRepo(name: string): string {
  const repoPath = path.join(FIXTURES_DIR, name);
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

/**
 * Create a bare remote repo and a cloned working repo for branch comparison tests.
 * Returns { remotePath, repoPath }.
 */
export function createRepoWithRemote(name: string): { remotePath: string; repoPath: string } {
  const remotePath = path.join(FIXTURES_DIR, `${name}-remote`);
  const repoPath = path.join(FIXTURES_DIR, name);

  // Create bare remote
  fs.mkdirSync(remotePath, { recursive: true });
  gitExec(remotePath, 'init --bare --initial-branch=main');

  // Clone it
  execSync(`git clone "${remotePath}" "${repoPath}"`, {
    encoding: 'utf-8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });

  // Configure cloned repo
  gitExec(repoPath, 'config user.email "test@test.com"');
  gitExec(repoPath, 'config user.name "Test User"');

  return { remotePath, repoPath };
}

/**
 * Clean up both a repo and its remote.
 */
export function removeRepoWithRemote(name: string): void {
  removeFixtureRepo(name);
  removeFixtureRepo(`${name}-remote`);
}

/** One recorded git call: the directory it ran in, then its argv. */
export interface GitCall {
  cwd: string;
  args: string[];
}

/**
 * Run `body` with a `git` on PATH that records its cwd and argv, then execs
 * the real one. The spawn count is the only witness that a cached listing
 * ran no git for a worktree.
 */
export async function withGitProbe(body: (calls: () => GitCall[]) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diffstalker-worktree-probe-'));
  const logPath = path.join(dir, 'argv.log');
  const realGit = execSync('command -v git', { encoding: 'utf-8' }).trim();
  fs.writeFileSync(
    path.join(dir, 'git'),
    `#!/bin/sh\nprintf '%s\\0' '--call--' "$PWD" "$@" >> '${logPath}'\nexec '${realGit}' "$@"\n`,
    { mode: 0o755 }
  );
  const originalPath = process.env.PATH;
  process.env.PATH = `${dir}:${originalPath ?? ''}`;
  try {
    await body(() => readCalls(logPath));
  } finally {
    process.env.PATH = originalPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function readCalls(logPath: string): GitCall[] {
  if (!fs.existsSync(logPath)) return [];
  const parts = fs.readFileSync(logPath, 'utf-8').split('\0');
  parts.pop();
  const calls: GitCall[] = [];
  for (const part of parts) {
    if (part === '--call--') calls.push({ cwd: '', args: [] });
    else if (calls[calls.length - 1].cwd === '') calls[calls.length - 1].cwd = part;
    else calls[calls.length - 1].args.push(part);
  }
  return calls;
}

/** The git subcommand of a call, past the `-c key=value` pairs. */
export function gitSubcommand(call: GitCall): string {
  const at = call.args.findIndex((a, i) => !a.startsWith('-') && call.args[i - 1] !== '-c');
  return call.args[at];
}
