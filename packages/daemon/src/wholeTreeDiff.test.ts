/**
 * The whole-tree GET /repos/:id/diff is served from the manager's last
 * refresh, not from a git run of its own.
 *
 * Self-contained: own daemon, own socket, own fixture repo under /tmp.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createDaemon, Daemon } from './server.js';

const SOCKET = path.join(os.tmpdir(), `diffstalkerd-wholetree-${process.pid}.sock`);

let daemon: Daemon;
let repoDir: string;
let repoId: string;

interface WireDiffLine {
  type: string;
  content: string;
  editedAt?: number;
}

function gitExec(cwd: string, command: string): string {
  return execSync(`git ${command}`, {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}

function request(pathname: string, init?: RequestInit): Promise<Response> {
  return fetch(`http://localhost${pathname}`, { ...init, unix: SOCKET } as RequestInit);
}

async function diffText(query: string): Promise<string> {
  const res = await request(`/repos/${repoId}/diff${query}`);
  expect(res.status).toBe(200);
  const { lines } = (await res.json()) as { lines: WireDiffLine[] };
  return lines.map((l) => l.content).join('\n');
}

beforeAll(async () => {
  repoDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'diffstalkerd-wholetree-')));
  gitExec(repoDir, 'init --initial-branch=main');
  gitExec(repoDir, 'config user.email "test@test.com"');
  gitExec(repoDir, 'config user.name "Test User"');
  // A tracked file inside an ignored directory: git diffs it, but the
  // working-dir watcher never looks there, so an edit to it reaches the
  // daemon only through a refresh something else asks for.
  fs.writeFileSync(path.join(repoDir, '.gitignore'), 'build\n');
  fs.mkdirSync(path.join(repoDir, 'build'));
  fs.writeFileSync(path.join(repoDir, 'build/out.txt'), 'built\n');
  fs.writeFileSync(path.join(repoDir, 'file.txt'), 'original\n');
  fs.writeFileSync(path.join(repoDir, 'other.txt'), 'other\n');
  gitExec(repoDir, 'add .gitignore file.txt other.txt');
  gitExec(repoDir, 'add -f build/out.txt');
  gitExec(repoDir, 'commit -m "base"');
  fs.writeFileSync(path.join(repoDir, 'file.txt'), 'original\nedited\n');

  daemon = createDaemon({ followEnabled: false });
  await daemon.listen({ socketPath: SOCKET });
});

afterAll(async () => {
  await daemon.close();
  fs.rmSync(SOCKET, { force: true });
  fs.rmSync(repoDir, { recursive: true, force: true });
});

describe('whole-tree GET /diff', () => {
  test('right after open, waits for the first refresh and answers from it', async () => {
    const res = await request('/repos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: repoDir }),
    });
    expect(res.status).toBe(201);
    repoId = ((await res.json()) as { id: string }).id;

    expect(await diffText('')).toContain('+edited');
    const status = await request(`/repos/${repoId}/status`);
    const wire = (await status.json()) as { status: { isRepo: boolean } | null };
    expect(wire.status?.isRepo).toBe(true);
  });

  test('is the last refresh\'s diff, stamped, not a git run of its own', async () => {
    const res = await request(`/repos/${repoId}/diff`);
    const { lines } = (await res.json()) as { lines: WireDiffLine[] };
    const hunk = lines.find((l) => l.type === 'hunk');
    expect(typeof hunk?.editedAt).toBe('number');
    expect(await diffText('?staged=true')).toBe('');

    // Git sees this edit; the watcher does not, so no refresh runs.
    fs.writeFileSync(path.join(repoDir, 'build/out.txt'), 'rebuilt\n');
    expect(gitExec(repoDir, 'diff --stat')).toContain('build/out.txt');
    const unchanged = await diffText('');
    expect(unchanged).not.toContain('rebuilt');
    expect(unchanged).toContain('+edited');

    // A staging mutation refreshes, and the next answer carries the edit.
    const stage = await request(`/repos/${repoId}/stage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'file.txt' }),
    });
    expect(stage.status).toBe(200);
    expect(await diffText('')).toContain('+rebuilt');
    expect(await diffText('?staged=true')).toContain('+edited');
  });
});
