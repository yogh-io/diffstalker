/**
 * Explorer endpoints over a real unix socket: /tree (directory listing with
 * git status), /file (content as flags, never prose), /files (the fuzzy
 * finder source). Self-contained: own daemon, own socket, own fixture repo.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createDaemon, Daemon } from './server.js';
import { createFixtureRepo, removeFixtureRepo, writeFixtureFile, gitExec } from './test-helpers.js';

const FIXTURE = 'daemon-explorer';
const SOCKET = path.join(os.tmpdir(), `diffstalkerd-ex-${process.pid}.sock`);

let daemon: Daemon;
let repoPath: string;
let repoId: string;

interface WireDirEntry {
  name: string;
  path: string;
  type: 'file' | 'dir';
  gitStatus?: string;
  staged?: boolean;
  hasChanges?: boolean;
}

interface WireFileForDisplay {
  content: string;
  binary: boolean;
  truncated: boolean;
  tooLarge: boolean;
  size: number;
  totalLines: number;
}

function request(pathname: string, init?: RequestInit): Promise<Response> {
  const options = { ...init, unix: SOCKET };
  return fetch(`http://localhost${pathname}`, options as RequestInit);
}

beforeAll(async () => {
  repoPath = createFixtureRepo(FIXTURE);
  // *.fifo is gitignored so the manager's working-dir watcher skips the
  // FIFO the DoS test creates: bun's fs.watch blocks the whole event loop
  // when an unignored FIFO appears in a watched dir (node does not — this
  // is a bun-only quirk, unrelated to the /file guard under test).
  writeFixtureFile(repoPath, '.gitignore', '*.log\n*.fifo\n');
  writeFixtureFile(repoPath, 'README.md', 'hello explorer\n');
  writeFixtureFile(repoPath, 'src/main.ts', 'const x = 1;\n');
  writeFixtureFile(repoPath, 'docs/guide.md', 'guide\n');
  fs.writeFileSync(path.join(repoPath, 'blob.bin'), Buffer.from([0x00, 0x01, 0xff, 0x00]));
  gitExec(repoPath, 'add .');
  gitExec(repoPath, 'commit -m "initial"');

  // Working-tree changes the tests assert on
  writeFixtureFile(repoPath, 'src/main.ts', 'const x = 2;\n'); // modified
  writeFixtureFile(repoPath, 'ignored.log', 'noise\n'); // gitignored
  writeFixtureFile(repoPath, 'src/staged.ts', 'const s = 1;\n'); // staged addition
  gitExec(repoPath, 'add src/staged.ts');

  daemon = createDaemon();
  await daemon.listen({ socketPath: SOCKET });

  const res = await request('/repos', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: repoPath }),
  });
  expect(res.status).toBe(201);
  repoId = ((await res.json()) as { id: string }).id;
});

afterAll(async () => {
  await daemon.close();
  removeFixtureRepo(FIXTURE);
  fs.rmSync(SOCKET, { force: true });
});

describe('explorer endpoints', () => {
  test('GET /tree lists the root: dirs first, gitignored/hidden filtered, changed dir marked', async () => {
    const res = await request(`/repos/${repoId}/tree`);
    expect(res.status).toBe(200);
    const entries = (await res.json()) as WireDirEntry[];

    const names = entries.map((e) => e.name);
    // Dirs first (alphabetical), then files (file order is locale collation)
    expect(names.slice(0, 2)).toEqual(['docs', 'src']);
    expect(names.slice(2).toSorted()).toEqual(['README.md', 'blob.bin']);
    expect(names).not.toContain('ignored.log');
    expect(names).not.toContain('.gitignore');

    const src = entries.find((e) => e.name === 'src')!;
    expect(src.type).toBe('dir');
    expect(src.hasChanges).toBe(true); // contains the modified main.ts
    expect(entries.find((e) => e.name === 'docs')!.hasChanges).toBeUndefined();
  });

  test('GET /tree?dir=src shows git status and staged per file', async () => {
    const res = await request(`/repos/${repoId}/tree?dir=src`);
    expect(res.status).toBe(200);
    const entries = (await res.json()) as WireDirEntry[];
    const main = entries.find((e) => e.path === 'src/main.ts')!;
    expect(main.type).toBe('file');
    expect(main.gitStatus).toBe('modified');
    expect(main.staged).toBe(false);
    const staged = entries.find((e) => e.path === 'src/staged.ts')!;
    expect(staged.gitStatus).toBe('added');
    expect(staged.staged).toBe(true);
  });

  test('GET /tree?hidden=true includes dot-prefixed entries', async () => {
    const res = await request(`/repos/${repoId}/tree?hidden=true`);
    expect(res.status).toBe(200);
    const names = ((await res.json()) as WireDirEntry[]).map((e) => e.name);
    expect(names).toContain('.gitignore');
  });

  test('GET /tree?ignored=true includes gitignored entries', async () => {
    const res = await request(`/repos/${repoId}/tree?ignored=true`);
    expect(res.status).toBe(200);
    const names = ((await res.json()) as WireDirEntry[]).map((e) => e.name);
    expect(names).toContain('ignored.log');
    expect(names).not.toContain('.gitignore'); // hidden still filtered
  });

  test('GET /tree with a malformed hidden/ignored param is a 400', async () => {
    const res = await request(`/repos/${repoId}/tree?hidden=1`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('hidden');
  });

  test('GET /tree rejects a path escaping the repo root with 400', async () => {
    const res = await request(`/repos/${repoId}/tree?dir=${encodeURIComponent('../..')}`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('escapes');
  });

  test('GET /tree on a nonexistent directory is 404', async () => {
    const res = await request(`/repos/${repoId}/tree?dir=no-such-dir`);
    expect(res.status).toBe(404);
  });

  test('GET /tree on a file is a 400 (wrong node kind)', async () => {
    const res = await request(`/repos/${repoId}/tree?dir=README.md`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Not a directory');
  });

  test('GET /file returns text content with flags off', async () => {
    const res = await request(`/repos/${repoId}/file?path=README.md`);
    expect(res.status).toBe(200);
    const file = (await res.json()) as WireFileForDisplay;
    expect(file.content).toBe('hello explorer\n');
    expect(file.binary).toBe(false);
    expect(file.truncated).toBe(false);
    expect(file.tooLarge).toBe(false);
    expect(file.size).toBe(15);
  });

  test('GET /file flags a binary file with empty content (no prose)', async () => {
    const res = await request(`/repos/${repoId}/file?path=blob.bin`);
    expect(res.status).toBe(200);
    const file = (await res.json()) as WireFileForDisplay;
    expect(file.binary).toBe(true);
    expect(file.content).toBe('');
  });

  test('GET /file without a path param is a 400', async () => {
    const res = await request(`/repos/${repoId}/file`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('"path"');
  });

  test('GET /file rejects a lexical escape with 400', async () => {
    const res = await request(
      `/repos/${repoId}/file?path=${encodeURIComponent('../../etc/passwd')}`
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('escapes');
  });

  test('GET /file on a missing file is a 404', async () => {
    const res = await request(`/repos/${repoId}/file?path=nope.txt`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toContain('nope.txt');
  });

  test('GET /file on a directory is a 400 (wrong node kind)', async () => {
    const res = await request(`/repos/${repoId}/file?path=src`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('Not a regular file');
  });

  test('GET /file on a FIFO is a prompt 400 and the daemon stays responsive', async () => {
    // A FIFO used to be read like a file: the open blocked bun's event
    // loop until a writer appeared, freezing the daemon for ALL clients.
    // The per-request timeouts make a regression fail fast, not hang.
    const fifoPath = path.join(repoPath, 'pipe.fifo');
    execSync(`mkfifo "${fifoPath}"`);
    try {
      const res = await request(`/repos/${repoId}/file?path=pipe.fifo`, {
        signal: AbortSignal.timeout(2000),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain('Not a regular file');

      const health = await request('/health', { signal: AbortSignal.timeout(2000) });
      expect(health.status).toBe(200);
    } finally {
      fs.rmSync(fifoPath, { force: true });
    }
  });

  test('symlinks out of the repo are 400 on /file and /tree and dropped from listings', async () => {
    // The lexical guard passes these (the path itself stays inside the
    // repo); only a realpath check catches the escape.
    const linkFile = path.join(repoPath, 'link_file');
    const linkDir = path.join(repoPath, 'link_dir');
    fs.symlinkSync('/etc/passwd', linkFile);
    fs.symlinkSync('/etc', linkDir);
    try {
      const file = await request(`/repos/${repoId}/file?path=link_file`);
      expect(file.status).toBe(400);
      expect(((await file.json()) as { error: string }).error).toContain('escapes');

      const tree = await request(`/repos/${repoId}/tree?dir=link_dir`);
      expect(tree.status).toBe(400);
      expect(((await tree.json()) as { error: string }).error).toContain('escapes');

      // A listing never presents entries whose real location escapes.
      const root = await request(`/repos/${repoId}/tree`);
      expect(root.status).toBe(200);
      const names = ((await root.json()) as WireDirEntry[]).map((e) => e.name);
      expect(names).not.toContain('link_file');
      expect(names).not.toContain('link_dir');
    } finally {
      fs.rmSync(linkFile, { force: true });
      fs.rmSync(linkDir, { force: true });
    }
  });

  // Every spelling below reaches .git/config on a raw first-segment check,
  // and that file carries credentials in remote URLs. The guard normalizes
  // first, so they all end at the same refusal.
  const GIT_DIR_SPELLINGS = [
    '.git',
    '.git/config',
    './.git/config',
    'src/../.git/config',
    '.GIT/config',
    '.git./config',
    'worktrees/x/.git/config',
    'src/.git/config',
  ];

  test('GET /file refuses every spelling of the git directory', async () => {
    for (const spelling of GIT_DIR_SPELLINGS) {
      const res = await request(`/repos/${repoId}/file?path=${encodeURIComponent(spelling)}`);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain('git directory');
    }
  });

  test('GET /tree refuses every spelling of the git directory', async () => {
    for (const spelling of GIT_DIR_SPELLINGS) {
      const res = await request(`/repos/${repoId}/tree?dir=${encodeURIComponent(spelling)}`);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain('git directory');
    }
  });

  test('GET /tree?hidden=true does not list the git directory', async () => {
    const res = await request(`/repos/${repoId}/tree?hidden=true`);
    expect(res.status).toBe(200);
    const names = ((await res.json()) as WireDirEntry[]).map((e) => e.name);
    expect(names).toContain('.gitignore'); // other dotfiles still show
    expect(names).not.toContain('.git');
  });

  test('a symlink into the git directory is a 400 on /file and /tree', async () => {
    // Lexically clean: only the realpath + absolute-git-dir check sees it.
    const linkGit = path.join(repoPath, 'link_git');
    fs.symlinkSync(path.join(repoPath, '.git'), linkGit);
    try {
      const file = await request(`/repos/${repoId}/file?path=link_git%2Fconfig`);
      expect(file.status).toBe(400);
      expect(((await file.json()) as { error: string }).error).toContain('git directory');

      const tree = await request(`/repos/${repoId}/tree?dir=link_git`);
      expect(tree.status).toBe(400);
      expect(((await tree.json()) as { error: string }).error).toContain('git directory');
    } finally {
      fs.rmSync(linkGit, { force: true });
    }
  });

  test('GET /file refuses paths git could read as an option or a pathspec', async () => {
    const cases: [string, string][] = [
      ['-foo.png', '"-"'], // git option injection
      ['./-foo.png', '"-"'], // same after normalizing
      [':(glob)**', '":"'], // pathspec magic
      ['README.md\0.png', 'NUL'],
      ['/etc/passwd', 'escapes'],
      ['..', 'escapes'],
      ['.', 'repository root'],
    ];
    for (const [raw, expected] of cases) {
      const res = await request(`/repos/${repoId}/file?path=${encodeURIComponent(raw)}`);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain(expected);
    }
  });

  test('GET /file with an empty path param is a 400', async () => {
    const res = await request(`/repos/${repoId}/file?path=`);
    expect(res.status).toBe(400);
  });

  test('GET /tree?dir=./src normalizes rather than escaping', async () => {
    // The normalized form is what reaches the listing, so an equivalent
    // spelling of a legitimate directory must still work.
    const res = await request(`/repos/${repoId}/tree?dir=${encodeURIComponent('./docs/../src')}`);
    expect(res.status).toBe(200);
    const entries = (await res.json()) as WireDirEntry[];
    expect(entries.map((e) => e.path)).toContain('src/main.ts');
  });

  test('a symlink staying inside the repo still works', async () => {
    const innerLink = path.join(repoPath, 'link_inner');
    fs.symlinkSync(path.join(repoPath, 'README.md'), innerLink);
    try {
      const res = await request(`/repos/${repoId}/file?path=link_inner`);
      expect(res.status).toBe(200);
      expect(((await res.json()) as WireFileForDisplay).content).toBe('hello explorer\n');
    } finally {
      fs.rmSync(innerLink, { force: true });
    }
  });

  test('GET /files returns the finder source with tracked paths', async () => {
    const res = await request(`/repos/${repoId}/files`);
    expect(res.status).toBe(200);
    const files = (await res.json()) as string[];
    expect(files).toContain('src/main.ts');
    expect(files).toContain('README.md');
    expect(files).not.toContain('ignored.log'); // --exclude-standard
  });
});
