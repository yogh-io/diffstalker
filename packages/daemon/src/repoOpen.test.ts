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
/** A bare-worktree layout: `<container>/.bare` plus a worktree beside it. */
let bareContainer: string;
let bareWorktree: string;
let plainDir: string;

function openRepo(inputPath: string): Promise<Response> {
  return fetch('http://localhost/repos', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: inputPath }),
    unix: SOCKET,
  } as RequestInit);
}

function resolvePath(inputPath: string): Promise<Response> {
  return fetch(`http://localhost/resolve?path=${encodeURIComponent(inputPath)}`, {
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
  fs.writeFileSync(path.join(repoDir, 'a.txt'), 'a\n');
  git('add .');
  git('commit -m first');
  fs.mkdirSync(path.join(repoDir, 'sub'));

  // A bare container with one worktree beside it: `<container>/.bare` is
  // the git dir, `<container>/main` the working tree. Neither the
  // container nor the .bare dir is a working tree, so both only resolve
  // through the worktree-list fallback.
  bareContainer = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'diffstalkerd-bare-')));
  execSync(`git clone --bare "${repoDir}" "${path.join(bareContainer, '.bare')}"`, {
    stdio: 'ignore',
  });
  bareWorktree = path.join(bareContainer, 'main');
  execSync(`git --git-dir="${path.join(bareContainer, '.bare')}" worktree add "${bareWorktree}" main`, {
    stdio: 'ignore',
  });
  // The `.git` file is what makes the CONTAINER itself a git path: without
  // it, `git -C <container>` discovers upward and finds nothing. This is
  // the layout the daemon is expected to handle (a bare db plus one
  // worktree per branch around it).
  fs.writeFileSync(path.join(bareContainer, '.git'), 'gitdir: ./.bare\n');

  plainDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'diffstalkerd-plain-')));

  // No followFile: no chokidar watcher on the hook file.
  daemon = createDaemon();
  await daemon.listen({ socketPath: SOCKET });
});

afterAll(async () => {
  await daemon.close();
  fs.rmSync(SOCKET, { force: true });
  for (const dir of [repoDir, bareContainer, plainDir]) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

/**
 * GET /resolve: the probe behind the repo picker's Open button — can this
 * exact path be opened, and as what, without opening it.
 *
 * The last test here is the one that matters most. The probe and POST
 * /repos share one resolver (resolveRepoRoot), and this asserts the
 * property that sharing exists for: anything the probe calls openable, the
 * open really opens, at the very root the probe named. A button that
 * promised otherwise would lie at the moment of highest trust.
 */
describe('GET /resolve', () => {
  test('a repo root resolves to itself', async () => {
    const res = await resolvePath(repoDir);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ openable: true, root: repoDir });
  });

  test('a subdirectory resolves to the worktree containing it', async () => {
    const body = (await (await resolvePath(path.join(repoDir, 'sub'))).json()) as {
      openable: boolean;
      root: string;
    };
    expect(body).toEqual({ openable: true, root: repoDir });
  });

  test('a bare container resolves to the worktree it would open', async () => {
    const body = await (await resolvePath(bareContainer)).json();
    expect(body).toEqual({ openable: true, root: bareWorktree });
  });

  test('the .bare directory itself resolves the same way', async () => {
    const body = await (await resolvePath(path.join(bareContainer, '.bare'))).json();
    expect(body).toEqual({ openable: true, root: bareWorktree });
  });

  test('a plain directory is not openable', async () => {
    expect(await (await resolvePath(plainDir)).json()).toEqual({ openable: false, root: null });
  });

  test('a path that does not exist is not openable, even inside a repo', async () => {
    // The whole reason the probe passes mustExist: git places a vanished
    // path in its PARENT worktree, so without the stat this typo would come
    // back openable and the button would offer to open the repo above it.
    const typo = path.join(repoDir, 'no-such-dir');
    expect(await (await resolvePath(typo)).json()).toEqual({ openable: false, root: null });
  });

  test('a path that is still relative after expansion is a 400, not an answer', async () => {
    // `~jorn/x` is not a home reference this daemon expands, so it arrives
    // relative — and the daemon's own working directory means nothing to
    // the client that sent it.
    const res = await resolvePath('~someone/x');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('must be absolute');
  });

  test('everything it calls openable, POST /repos really opens — at the same root', async () => {
    for (const candidate of [repoDir, path.join(repoDir, 'sub'), bareContainer, path.join(bareContainer, '.bare')]) {
      const probe = (await (await resolvePath(candidate)).json()) as {
        openable: boolean;
        root: string | null;
      };
      expect(probe.openable).toBe(true);

      const res = await openRepo(candidate);
      expect([200, 201]).toContain(res.status);
      expect(((await res.json()) as { path: string }).path).toBe(probe.root);
    }
  });
});
