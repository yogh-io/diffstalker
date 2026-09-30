/**
 * Paths git C-quotes, end to end: a tab, a double quote, a backslash and a
 * non-ASCII name. git prints each of these as `"..."` with escapes in
 * patch headers and, without -z, in numstat/name-status output. Every
 * endpoint that names files must still report the raw path — the one
 * `git status` gives — or the file vanishes from Compare and History and
 * gets no counts in Changes. Self-contained: own daemon, socket and repo.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createDaemon, Daemon } from './server.js';
import { createFixtureRepo, removeFixtureRepo, writeFixtureFile, gitExec } from './test-helpers.js';

const FIXTURE = 'daemon-quoted-paths';
const SOCKET = path.join(os.tmpdir(), `diffstalkerd-quoted-${process.pid}.sock`);

const NAMES = ['tab\tname.txt', 'quote"name.txt', 'back\\slash.txt', '日本.txt'];
const MOVED = 'moved\tbase.txt';
const UNTRACKED = ['weird"', 'new\ttab.txt', '新しい.txt'];

let daemon: Daemon;
let repoPath: string;
let repoId: string;
let editHash: string;

interface WireFile {
  path: string;
  status: string;
  staged: boolean;
  insertions?: number;
  deletions?: number;
}

interface WireRow {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  uncommitted?: string;
  diff: { lines: { content: string }[] };
}

function request(pathname: string): Promise<Response> {
  return fetch(`http://localhost${pathname}`, { unix: SOCKET } as RequestInit);
}

async function json<T>(pathname: string): Promise<T> {
  const res = await request(pathname);
  expect(res.status).toBe(200);
  return (await res.json()) as T;
}

function diffText(diff: { lines: { content: string }[] }): string {
  return diff.lines.map((l) => l.content).join('\n');
}

beforeAll(async () => {
  repoPath = createFixtureRepo(FIXTURE);
  for (const name of NAMES) writeFixtureFile(repoPath, name, 'a\n');
  writeFixtureFile(repoPath, 'base.txt', 'keep\n');
  gitExec(repoPath, 'add -A');
  gitExec(repoPath, 'commit -m "base"');
  gitExec(repoPath, 'update-ref refs/remotes/origin/main main');
  gitExec(repoPath, 'checkout -b feature');
  for (const name of NAMES) writeFixtureFile(repoPath, name, 'a\nb\n');
  // A rename onto a name git has to quote, through fs rather than a shell.
  fs.renameSync(path.join(repoPath, 'base.txt'), path.join(repoPath, MOVED));
  gitExec(repoPath, 'add -A');
  gitExec(repoPath, 'commit -m "edit and move"');
  editHash = gitExec(repoPath, 'rev-parse HEAD').trim();
  // Unstaged: one more line in the tab-named file.
  writeFixtureFile(repoPath, NAMES[0], 'a\nb\nc\n');
  // Untracked: names whose synthetic new-file header must be quoted by us
  // exactly as git would quote it.
  for (const name of UNTRACKED) writeFixtureFile(repoPath, name, 'new\n');

  daemon = createDaemon();
  await daemon.listen({ socketPath: SOCKET });
  const res = await fetch('http://localhost/repos', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: repoPath }),
    unix: SOCKET,
  } as RequestInit);
  repoId = ((await res.json()) as { id: string }).id;
});

afterAll(async () => {
  await daemon.close();
  fs.rmSync(SOCKET, { force: true });
  removeFixtureRepo(FIXTURE);
});

describe('Changes: /status and /diff', () => {
  test('the status entry carries the raw path, its counts and a hunk count', async () => {
    const wire = await json<{
      status: { files: WireFile[] };
      hunkCounts: { unstaged: Record<string, number> };
    }>(`/repos/${repoId}/status`);
    const entry = wire.status.files.find((f) => f.path === NAMES[0]);
    expect(entry).toMatchObject({ status: 'modified', staged: false, insertions: 1, deletions: 0 });
    expect(wire.hunkCounts.unstaged[NAMES[0]]).toBe(1);
  });

  test('an untracked file gets a header spelled exactly as git spells it', async () => {
    const wire = await json<{ status: { files: WireFile[] } }>(`/repos/${repoId}/status`);
    for (const name of UNTRACKED) {
      expect(wire.status.files.find((f) => f.path === name)).toMatchObject({
        status: 'untracked',
        insertions: 1,
      });

      const diff = await json<{ lines: { content: string }[] }>(
        `/repos/${repoId}/diff?path=${encodeURIComponent(name)}`
      );
      expect(diffText(diff)).toContain('+new');
      // Exactly what `git diff` prints for the same name once it is added.
      gitExec(repoPath, `add -- "${name.replace(/"/g, '\\"')}"`);
      const real = gitExec(repoPath, 'diff --cached -- .').split('\n');
      gitExec(repoPath, 'reset -q');
      expect(diff.lines[0].content).toBe(real[0]);
    }
  });

  test('GET /diff?path= reads the file by its raw path', async () => {
    const diff = await json<{ lines: { content: string }[] }>(
      `/repos/${repoId}/diff?path=${encodeURIComponent(NAMES[0])}`
    );
    const text = diffText(diff);
    expect(text).toContain('+c');
    // The patch text keeps git's own quoting: a hunk patch built from
    // these lines has to be one `git apply` accepts.
    expect(text).toContain('diff --git "a/tab\\tname.txt" "b/tab\\tname.txt"');
  });
});

describe('History: /commits/:hash', () => {
  test('/files lists every quoted name and the rename by raw path', async () => {
    const rows = await json<WireRow[]>(`/repos/${repoId}/commits/${editHash}/files`);
    const byPath = new Map(rows.map((r) => [r.path, r]));
    for (const name of NAMES) {
      expect(byPath.get(name)).toMatchObject({ status: 'modified', additions: 1, deletions: 0 });
      expect(byPath.get(name)!.diff.lines.length).toBeGreaterThan(0);
    }
    expect(byPath.get(MOVED)?.status).toBe('renamed');
    expect(rows).toHaveLength(NAMES.length + 1);
  });

  test('/diff?path= narrows to a quoted name and keeps a rename a rename', async () => {
    const one = await json<{ lines: { content: string }[] }>(
      `/repos/${repoId}/commits/${editHash}/diff?path=${encodeURIComponent(NAMES[1])}`
    );
    expect(diffText(one)).toContain('+b');
    const moved = await json<{ lines: { content: string }[] }>(
      `/repos/${repoId}/commits/${editHash}/diff?path=${encodeURIComponent(MOVED)}`
    );
    expect(diffText(moved)).toContain('rename from base.txt');
  });
});

describe('Compare: /compare and /compare/file', () => {
  test('/compare lists the committed rows and the unstaged row by raw path', async () => {
    const diff = await json<{ files: WireRow[]; stats: { filesChanged: number } }>(
      `/repos/${repoId}/compare?base=main&unstaged=true`
    );
    for (const name of NAMES) {
      const committed = diff.files.find((f) => f.path === name && !f.uncommitted);
      expect(committed).toMatchObject({ status: 'modified', additions: 1, deletions: 0 });
    }
    expect(diff.files.find((f) => f.path === MOVED)?.status).toBe('renamed');
    const unstaged = diff.files.find((f) => f.path === NAMES[0] && f.uncommitted);
    expect(unstaged).toMatchObject({ uncommitted: 'unstaged', additions: 1, deletions: 0 });
    expect(diff.stats.filesChanged).toBe(NAMES.length + 1);
  });

  test('/compare/file reads one quoted name against the base and against the index', async () => {
    for (const name of NAMES) {
      const row = await json<{ lines: { content: string }[] }>(
        `/repos/${repoId}/compare/file?path=${encodeURIComponent(name)}&base=main`
      );
      expect(diffText(row)).toContain('+b');
    }
    const unstaged = await json<{ lines: { content: string }[] }>(
      `/repos/${repoId}/compare/file?path=${encodeURIComponent(NAMES[0])}&uncommitted=unstaged`
    );
    expect(diffText(unstaged)).toContain('+c');
  });
});

describe('Explorer: /file', () => {
  test('reads a quoted name from disk', async () => {
    for (const name of NAMES) {
      const file = await json<{ content: string }>(
        `/repos/${repoId}/file?path=${encodeURIComponent(name)}`
      );
      expect(file.content.startsWith('a\nb\n')).toBe(true);
    }
  });
});
