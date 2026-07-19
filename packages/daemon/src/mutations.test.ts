/**
 * Working-tree mutation endpoints over a real unix socket: stage-all,
 * unstage-all, discard, commit, and hunk-level stage/unstage.
 *
 * Self-contained: one daemon instance on its own socket, and every test
 * builds (and removes) its own fixture repo — no shared repo state or
 * ordering between tests.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createDaemon, Daemon } from './server.js';
import { createFixtureRepo, removeFixtureRepo, writeFixtureFile, gitExec } from './test-helpers.js';

const SOCKET = path.join(os.tmpdir(), `diffstalkerd-mut-${process.pid}.sock`);

let daemon: Daemon;

function request(pathname: string, init?: RequestInit): Promise<Response> {
  const options = { ...init, unix: SOCKET };
  return fetch(`http://localhost${pathname}`, options as RequestInit);
}

function postJson(pathname: string, body: unknown): Promise<Response> {
  return request(pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

interface WireFile {
  path: string;
  status: string;
  staged: boolean;
}

interface WireSharedState {
  status: { files: WireFile[]; isRepo: boolean } | null;
  hunkCounts: {
    staged: Record<string, number>;
    unstaged: Record<string, number>;
  } | null;
  error: string | null;
}

/** Unwrap the unified mutation envelope: the shared state under `state`. */
async function stateOf(res: Response): Promise<WireSharedState> {
  return ((await res.json()) as { state: WireSharedState }).state;
}

/** Open a fixture repo on the daemon; returns its id. */
async function openRepo(repoPath: string): Promise<string> {
  const res = await postJson('/repos', { path: repoPath });
  expect([200, 201]).toContain(res.status);
  return ((await res.json()) as { id: string }).id;
}

/** Close a repo so its manager (and watchers) are disposed. */
async function closeRepo(repoId: string): Promise<void> {
  await request(`/repos/${repoId}`, { method: 'DELETE' });
}

/**
 * A fixture repo with one commit containing base.txt, then: base.txt
 * modified (unstaged) and untracked.txt added.
 */
function makeDirtyRepo(name: string): string {
  const repoPath = createFixtureRepo(name);
  writeFixtureFile(repoPath, 'base.txt', 'line one\n');
  gitExec(repoPath, 'add .');
  gitExec(repoPath, 'commit -m "initial"');
  writeFixtureFile(repoPath, 'base.txt', 'line one\nline two\n');
  writeFixtureFile(repoPath, 'untracked.txt', 'new file\n');
  return repoPath;
}

function entries(state: WireSharedState, filePath: string): WireFile[] {
  return (state.status?.files ?? []).filter((f) => f.path === filePath);
}

/**
 * Split a unified diff into (header, hunks[]). Used to build a
 * single-hunk patch the way a client would.
 */
function splitDiff(diff: string): { header: string; hunks: string[] } {
  const lines = diff.split('\n');
  const hunkStarts: number[] = [];
  lines.forEach((line, i) => {
    if (line.startsWith('@@')) hunkStarts.push(i);
  });
  expect(hunkStarts.length).toBeGreaterThan(0);
  const header = lines.slice(0, hunkStarts[0]).join('\n');
  const hunks = hunkStarts.map((start, idx) => {
    const end = idx + 1 < hunkStarts.length ? hunkStarts[idx + 1] : lines.length;
    const hunkLines = lines.slice(start, end);
    while (hunkLines.length > 0 && hunkLines[hunkLines.length - 1] === '') hunkLines.pop();
    return hunkLines.join('\n');
  });
  return { header, hunks };
}

beforeAll(async () => {
  daemon = createDaemon();
  await daemon.listen({ socketPath: SOCKET });
});

afterAll(async () => {
  await daemon.close();
  fs.rmSync(SOCKET, { force: true });
});

describe('stage-all / unstage-all', () => {
  test('stage-all stages everything; unstage-all reverses it', async () => {
    const name = 'daemon-mut-stage-all';
    const repoPath = makeDirtyRepo(name);
    const repoId = await openRepo(repoPath);
    try {
      const stageRes = await postJson(`/repos/${repoId}/stage-all`, {});
      expect(stageRes.status).toBe(200);
      const staged = await stateOf(stageRes);
      expect(staged.error).toBeNull();
      const files = staged.status?.files ?? [];
      expect(files.length).toBeGreaterThan(0);
      expect(files.every((f) => f.staged)).toBe(true);
      expect(files.some((f) => f.path === 'base.txt')).toBe(true);
      expect(files.some((f) => f.path === 'untracked.txt')).toBe(true);

      const unstageRes = await postJson(`/repos/${repoId}/unstage-all`, {});
      expect(unstageRes.status).toBe(200);
      const unstaged = await stateOf(unstageRes);
      expect(unstaged.error).toBeNull();
      const after = unstaged.status?.files ?? [];
      expect(after.length).toBeGreaterThan(0);
      expect(after.every((f) => !f.staged)).toBe(true);
    } finally {
      await closeRepo(repoId);
      removeFixtureRepo(name);
    }
  });
});

describe('discard', () => {
  test('discard on a modified unstaged file reverts it', async () => {
    const name = 'daemon-mut-discard-modified';
    const repoPath = makeDirtyRepo(name);
    const repoId = await openRepo(repoPath);
    try {
      const res = await postJson(`/repos/${repoId}/discard`, { path: 'base.txt' });
      expect(res.status).toBe(200);
      const state = await stateOf(res);
      expect(state.error).toBeNull();
      expect(entries(state, 'base.txt')).toHaveLength(0);
      expect(fs.readFileSync(path.join(repoPath, 'base.txt'), 'utf-8')).toBe('line one\n');
    } finally {
      await closeRepo(repoId);
      removeFixtureRepo(name);
    }
  });

  test('discard on an untracked file deletes it', async () => {
    const name = 'daemon-mut-discard-untracked';
    const repoPath = makeDirtyRepo(name);
    const repoId = await openRepo(repoPath);
    try {
      const res = await postJson(`/repos/${repoId}/discard`, { path: 'untracked.txt' });
      expect(res.status).toBe(200);
      const state = await stateOf(res);
      expect(state.error).toBeNull();
      expect(entries(state, 'untracked.txt')).toHaveLength(0);
      expect(fs.existsSync(path.join(repoPath, 'untracked.txt'))).toBe(false);
    } finally {
      await closeRepo(repoId);
      removeFixtureRepo(name);
    }
  });

  test('discard on a staged file is a 409, not a silent no-op', async () => {
    const name = 'daemon-mut-discard-staged';
    const repoPath = makeDirtyRepo(name);
    gitExec(repoPath, 'add base.txt');
    const repoId = await openRepo(repoPath);
    try {
      const res = await postJson(`/repos/${repoId}/discard`, { path: 'base.txt' });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('staged');
      // The file kept its staged change — nothing was destroyed.
      expect(fs.readFileSync(path.join(repoPath, 'base.txt'), 'utf-8')).toBe(
        'line one\nline two\n'
      );
    } finally {
      await closeRepo(repoId);
      removeFixtureRepo(name);
    }
  });

  test('discard on a file not in status is a 404', async () => {
    const name = 'daemon-mut-discard-missing';
    const repoPath = makeDirtyRepo(name);
    const repoId = await openRepo(repoPath);
    try {
      const res = await postJson(`/repos/${repoId}/discard`, { path: 'no-such.txt' });
      expect(res.status).toBe(404);
    } finally {
      await closeRepo(repoId);
      removeFixtureRepo(name);
    }
  });
});

describe('commit', () => {
  test('valid message with staged changes commits: HEAD advances, staged clears', async () => {
    const name = 'daemon-mut-commit';
    const repoPath = makeDirtyRepo(name);
    gitExec(repoPath, 'add base.txt');
    const before = gitExec(repoPath, 'rev-parse HEAD').trim();
    const repoId = await openRepo(repoPath);
    try {
      const res = await postJson(`/repos/${repoId}/commit`, { message: 'add line two' });
      expect(res.status).toBe(200);
      const state = await stateOf(res);
      expect(state.error).toBeNull();
      expect((state.status?.files ?? []).every((f) => !f.staged)).toBe(true);

      const after = gitExec(repoPath, 'rev-parse HEAD').trim();
      expect(after).not.toBe(before);
      expect(gitExec(repoPath, 'log -1 --format=%s').trim()).toBe('add line two');
    } finally {
      await closeRepo(repoId);
      removeFixtureRepo(name);
    }
  });

  test('empty message is a 400 before touching git', async () => {
    const name = 'daemon-mut-commit-empty';
    const repoPath = makeDirtyRepo(name);
    gitExec(repoPath, 'add base.txt');
    const repoId = await openRepo(repoPath);
    try {
      for (const message of ['', '   ']) {
        const res = await postJson(`/repos/${repoId}/commit`, { message });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: string };
        expect(body.error).toBe('Commit message cannot be empty');
      }
      // Nothing was committed
      expect(gitExec(repoPath, 'rev-list --count HEAD').trim()).toBe('1');
    } finally {
      await closeRepo(repoId);
      removeFixtureRepo(name);
    }
  });

  test('nothing staged is a 400', async () => {
    const name = 'daemon-mut-commit-nothing';
    const repoPath = makeDirtyRepo(name);
    const repoId = await openRepo(repoPath);
    try {
      const res = await postJson(`/repos/${repoId}/commit`, { message: 'no-op' });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('No changes staged for commit');
      expect(gitExec(repoPath, 'rev-list --count HEAD').trim()).toBe('1');
    } finally {
      await closeRepo(repoId);
      removeFixtureRepo(name);
    }
  });

  test('commit with an index emptied out-of-band is not a false 200', async () => {
    const name = 'daemon-mut-commit-raced';
    const repoPath = makeDirtyRepo(name);
    gitExec(repoPath, 'add base.txt');
    const repoId = await openRepo(repoPath);
    try {
      // Warm the cached status: it now shows base.txt staged.
      const statusRes = await request(`/repos/${repoId}/status`);
      expect(statusRes.status).toBe(200);
      const warm = (await statusRes.json()) as WireSharedState;
      expect((warm.status?.files ?? []).some((f) => f.staged)).toBe(true);

      // Out-of-band reset: the index is empty but the cache says staged.
      gitExec(repoPath, 'reset');

      // Depending on watcher timing this is either caught by the staged
      // count validation (400) or by the commit itself failing loud (409).
      // What it must NEVER be is a 200 with no commit created.
      const res = await postJson(`/repos/${repoId}/commit`, { message: 'phantom' });
      expect(res.status).not.toBe(200);
      expect(gitExec(repoPath, 'rev-list --count HEAD').trim()).toBe('1');
    } finally {
      await closeRepo(repoId);
      removeFixtureRepo(name);
    }
  });

  test('amend:true rewrites the top commit', async () => {
    const name = 'daemon-mut-commit-amend';
    const repoPath = makeDirtyRepo(name);
    gitExec(repoPath, 'add .');
    gitExec(repoPath, 'commit -m "will be amended"');
    writeFixtureFile(repoPath, 'base.txt', 'line one\nline two\nline three\n');
    gitExec(repoPath, 'add base.txt');
    const repoId = await openRepo(repoPath);
    try {
      const res = await postJson(`/repos/${repoId}/commit`, {
        message: 'amended message',
        amend: true,
      });
      expect(res.status).toBe(200);
      expect((await stateOf(res)).error).toBeNull();

      // Same commit count, new top message, and the staged change is in it.
      expect(gitExec(repoPath, 'rev-list --count HEAD').trim()).toBe('2');
      expect(gitExec(repoPath, 'log -1 --format=%s').trim()).toBe('amended message');
      expect(gitExec(repoPath, 'show HEAD:base.txt')).toContain('line three');
    } finally {
      await closeRepo(repoId);
      removeFixtureRepo(name);
    }
  });
});

describe('stage-hunk / unstage-hunk', () => {
  /**
   * A repo whose tracked file has two well-separated modifications, so
   * `git diff` produces two hunks.
   */
  function makeTwoHunkRepo(name: string): string {
    const repoPath = createFixtureRepo(name);
    const base = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
    writeFixtureFile(repoPath, 'big.txt', base);
    gitExec(repoPath, 'add .');
    gitExec(repoPath, 'commit -m "initial"');
    const modified = base
      .replace('line 2', 'line 2 CHANGED-TOP')
      .replace('line 18', 'line 18 CHANGED-BOTTOM');
    writeFixtureFile(repoPath, 'big.txt', modified);
    return repoPath;
  }

  test('staging one hunk stages exactly that hunk; unstage-hunk reverses it', async () => {
    const name = 'daemon-mut-hunks';
    const repoPath = makeTwoHunkRepo(name);
    const { header, hunks } = splitDiff(gitExec(repoPath, 'diff -- big.txt'));
    expect(hunks).toHaveLength(2);
    const patch = `${header}\n${hunks[0]}\n`;

    const repoId = await openRepo(repoPath);
    try {
      const res = await postJson(`/repos/${repoId}/stage-hunk`, { patch });
      expect(res.status).toBe(200);
      const state = await stateOf(res);
      expect(state.error).toBeNull();

      // Partially staged: the file appears on both sides of status.
      const both = entries(state, 'big.txt');
      expect(both.some((f) => f.staged)).toBe(true);
      expect(both.some((f) => !f.staged)).toBe(true);
      expect(state.hunkCounts?.staged['big.txt']).toBe(1);
      expect(state.hunkCounts?.unstaged['big.txt']).toBe(1);

      // Exactly the first hunk is in the index.
      const cached = gitExec(repoPath, 'diff --cached -- big.txt');
      expect(cached).toContain('CHANGED-TOP');
      expect(cached).not.toContain('CHANGED-BOTTOM');

      const undoRes = await postJson(`/repos/${repoId}/unstage-hunk`, { patch });
      expect(undoRes.status).toBe(200);
      const undone = await stateOf(undoRes);
      expect(undone.error).toBeNull();
      expect(entries(undone, 'big.txt').every((f) => !f.staged)).toBe(true);
      expect(gitExec(repoPath, 'diff --cached -- big.txt').trim()).toBe('');
    } finally {
      await closeRepo(repoId);
      removeFixtureRepo(name);
    }
  });

  test('a stale patch is a 409 {error}, not a silent 200', async () => {
    const name = 'daemon-mut-hunks-stale';
    const repoPath = makeTwoHunkRepo(name);
    const { header, hunks } = splitDiff(gitExec(repoPath, 'diff -- big.txt'));
    // Make the patch stale: the working tree moved on after the client
    // captured its diff.
    const stale = `${header}\n${hunks[0].replace('line 1\n', 'line 1 DRIFTED\n')}\n`;
    const repoId = await openRepo(repoPath);
    try {
      const res = await postJson(`/repos/${repoId}/stage-hunk`, { patch: stale });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('Failed to stage hunk');
      expect(body).not.toHaveProperty('success');
      // Nothing got staged
      expect(gitExec(repoPath, 'diff --cached -- big.txt').trim()).toBe('');
    } finally {
      await closeRepo(repoId);
      removeFixtureRepo(name);
    }
  });

  test('missing patch field is a 400', async () => {
    const name = 'daemon-mut-hunks-nopatch';
    const repoPath = makeTwoHunkRepo(name);
    const repoId = await openRepo(repoPath);
    try {
      for (const body of [{}, { patch: 42 }, { patch: '' }]) {
        const res = await postJson(`/repos/${repoId}/stage-hunk`, body);
        expect(res.status).toBe(400);
      }
    } finally {
      await closeRepo(repoId);
      removeFixtureRepo(name);
    }
  });
});
