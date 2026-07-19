/**
 * Explorer endpoints over a real unix socket: /tree (directory listing with
 * git status), /file (content as flags, never prose), /files (the fuzzy
 * finder source). Self-contained: own daemon, own socket, own fixture repo.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
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
  writeFixtureFile(repoPath, '.gitignore', '*.log\n');
  writeFixtureFile(repoPath, 'README.md', 'hello explorer\n');
  writeFixtureFile(repoPath, 'src/main.ts', 'const x = 1;\n');
  writeFixtureFile(repoPath, 'docs/guide.md', 'guide\n');
  fs.writeFileSync(path.join(repoPath, 'blob.bin'), Buffer.from([0x00, 0x01, 0xff, 0x00]));
  gitExec(repoPath, 'add .');
  gitExec(repoPath, 'commit -m "initial"');

  // Working-tree changes the tests assert on
  writeFixtureFile(repoPath, 'src/main.ts', 'const x = 2;\n'); // modified
  writeFixtureFile(repoPath, 'ignored.log', 'noise\n'); // gitignored

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

  test('GET /tree?dir=src shows the modified file with its git status', async () => {
    const res = await request(`/repos/${repoId}/tree?dir=src`);
    expect(res.status).toBe(200);
    const entries = (await res.json()) as WireDirEntry[];
    const main = entries.find((e) => e.path === 'src/main.ts')!;
    expect(main.type).toBe('file');
    expect(main.gitStatus).toBe('modified');
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

  test('GET /file without path is 400; escape is 400; missing file is 404; a dir is 400', async () => {
    expect((await request(`/repos/${repoId}/file`)).status).toBe(400);

    const escape = await request(
      `/repos/${repoId}/file?path=${encodeURIComponent('../../etc/passwd')}`
    );
    expect(escape.status).toBe(400);
    expect(((await escape.json()) as { error: string }).error).toContain('escapes');

    expect((await request(`/repos/${repoId}/file?path=nope.txt`)).status).toBe(404);
    expect((await request(`/repos/${repoId}/file?path=src`)).status).toBe(400);
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
