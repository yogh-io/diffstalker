/**
 * How POST /repos treats the path a human typed: ~ expands, and a path that
 * is still relative is refused as such.
 *
 * The daemon is loopback-only with no auth, so its home is the user's home
 * and ~ has exactly one meaning; its working directory, on the other hand,
 * is whatever it inherited (systemd, a shell, a spawn from the CLI), so a
 * relative path has none.
 *
 * The ~ cases here are negative on purpose: nothing may be written into the
 * real home, and $HOME cannot be repointed inside a running process (the
 * runtime resolves the home directory once). A ~ path that really opens is
 * covered end to end in args.test.ts, where the daemon is a child process
 * started with its own HOME.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createDaemon, Daemon } from './server.js';

const SOCKET = path.join(os.tmpdir(), `diffstalkerd-open-${process.pid}.sock`);

let daemon: Daemon;
let repoDir: string;

function openRepo(inputPath: string): Promise<Response> {
  return fetch('http://localhost/repos', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: inputPath }),
    unix: SOCKET,
  } as RequestInit);
}

beforeAll(async () => {
  repoDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'diffstalkerd-open-repo-')));
  const git = (command: string): void => {
    execSync(`git ${command}`, { cwd: repoDir, stdio: 'ignore' });
  };
  git('init --initial-branch=main');
  git('config user.email "test@test.com"');
  git('config user.name "Test User"');

  // No followFile: no chokidar watcher on the hook file.
  daemon = createDaemon();
  await daemon.listen({ socketPath: SOCKET });
});

afterAll(async () => {
  await daemon.close();
  fs.rmSync(SOCKET, { force: true });
  fs.rmSync(repoDir, { recursive: true, force: true });
});

describe('POST /repos path handling', () => {
  test('a ~ path that is not a repo names the expanded path in the error', async () => {
    const res = await openRepo('~/no-such-diffstalker-repo');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe(
      `Not a git repository: ${path.join(os.homedir(), 'no-such-diffstalker-repo')}`
    );
    // The literal tilde never reaches git.
    expect(body.error).not.toContain('~');
  });

  test('a relative path is refused for being relative, not for not being a repo', async () => {
    const res = await openRepo('some/relative/dir');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Repo path must be absolute: some/relative/dir');
  });

  test('an absolute path still opens', async () => {
    const res = await openRepo(repoDir);
    expect([200, 201]).toContain(res.status);
    const body = (await res.json()) as { path: string };
    expect(body.path).toBe(repoDir);
  });
});
