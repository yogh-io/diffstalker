/**
 * Whole-file mode on GET /repos/:id/diff — the `whole` parameter.
 *
 * Self-contained: own daemon, own socket, own fixture repo under /tmp.
 * Follow mode is off so no watcher touches anything.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createDaemon, Daemon } from './server.js';

const SOCKET = path.join(os.tmpdir(), `diffstalkerd-whole-${process.pid}.sock`);

let daemon: Daemon;
let repoDir: string;
let repoId: string;
const tempDirs: string[] = [];

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

function request(pathname: string): Promise<Response> {
  return fetch(`http://localhost${pathname}`, { unix: SOCKET } as RequestInit);
}

async function diffLines(query: string): Promise<WireDiffLine[]> {
  const res = await request(`/repos/${repoId}/diff${query}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { lines: WireDiffLine[] }).lines;
}

/** The file is long enough that -U3 cannot possibly cover it. */
const LINE_COUNT = 60;
const BASE = Array.from({ length: LINE_COUNT }, (_, i) => `line${i + 1}`).join('\n') + '\n';
const EDITED = BASE.replace('line2\n', 'EDITED2\n').replace('line55\n', 'EDITED55\n');

beforeAll(async () => {
  repoDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'diffstalkerd-whole-')));
  tempDirs.push(repoDir);
  gitExec(repoDir, 'init --initial-branch=main');
  gitExec(repoDir, 'config user.email "test@test.com"');
  gitExec(repoDir, 'config user.name "Test User"');
  fs.writeFileSync(path.join(repoDir, 'long.txt'), BASE);
  gitExec(repoDir, 'add .');
  gitExec(repoDir, 'commit -m "base"');
  fs.writeFileSync(path.join(repoDir, 'long.txt'), EDITED);
  fs.writeFileSync(path.join(repoDir, 'fresh.txt'), 'brand new\n');

  daemon = createDaemon({ followEnabled: false });
  await daemon.listen({ socketPath: SOCKET });
  const res = await fetch('http://localhost/repos', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: repoDir }),
    unix: SOCKET,
  } as RequestInit);
  expect([200, 201]).toContain(res.status);
  repoId = ((await res.json()) as { id: string }).id;
});

afterAll(async () => {
  await daemon.close();
  fs.rmSync(SOCKET, { force: true });
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe('GET /diff?whole=true', () => {
  test('draws the whole file, not just the hunks around each change', async () => {
    const hunks = await diffLines('?path=long.txt');
    const whole = await diffLines('?path=long.txt&whole=true');

    // Both describe the same two edits...
    const changedOf = (lines: WireDiffLine[]): string[] =>
      lines.filter((l) => l.type === 'addition' || l.type === 'deletion').map((l) => l.content);
    expect(changedOf(whole)).toEqual(changedOf(hunks));

    // ...but only one of them carries every unchanged line in between.
    const contextOf = (lines: WireDiffLine[]): number =>
      lines.filter((l) => l.type === 'context').length;
    expect(contextOf(hunks)).toBeLessThan(LINE_COUNT - 10);
    expect(contextOf(whole)).toBe(LINE_COUNT - 2); // every line but the two replaced
  });

  test('collapses to ONE hunk, where -U3 needs two', async () => {
    const hunks = await diffLines('?path=long.txt');
    const whole = await diffLines('?path=long.txt&whole=true');
    const headers = (lines: WireDiffLine[]): number =>
      lines.filter((l) => l.type === 'hunk').length;
    expect(headers(hunks)).toBe(2);
    expect(headers(whole)).toBe(1);
  });

  test('requires a path — a whole-tree wide diff is refused', async () => {
    // Not a nicety: unbounded `git diff -U100000` over the whole tree
    // behind an unthrottled, CSRF-exempt GET.
    const res = await request(`/repos/${repoId}/diff?whole=true`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('requires a path');
  });

  test('is never stamped with hunk edit times', async () => {
    // stampDiff WRITES into the repo's shared hunk-time map, keyed by a
    // hash of the hunk body. A whole-file diff is one hunk per file, so
    // stamping it would write keys the manager's own -U3 refresh never
    // produces and the file would read back as edited just now.
    const whole = await diffLines('?path=long.txt&whole=true');
    expect(whole.every((l) => l.editedAt === undefined)).toBe(true);

    // The U3 path still stamps: this test must fail if stamping broke
    // generally rather than just for whole-file.
    const hunks = await diffLines('?path=long.txt');
    expect(hunks.some((l) => l.editedAt !== undefined)).toBe(true);
  });

  test('an untracked file is already whole, and whole=true changes nothing', async () => {
    const plain = await diffLines('?path=fresh.txt');
    const whole = await diffLines('?path=fresh.txt&whole=true');
    expect(whole).toEqual(plain);
  });

  test('whole=true is routed on the web API surface too', async () => {
    // The web UI is the only client of this mode, and it reaches the
    // daemon over the port's reduced routing table.
    const webDaemon = createDaemon({ followEnabled: false, apiMode: 'web' });
    await webDaemon.listen({ port: 0, host: '127.0.0.1' });
    try {
      const addr = webDaemon.address();
      if (addr === null || typeof addr === 'string') throw new Error('no TCP address');
      const base = `http://127.0.0.1:${addr.port}`;
      const opened = await fetch(`${base}/repos`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: repoDir }),
      });
      const id = ((await opened.json()) as { id: string }).id;
      const res = await fetch(`${base}/repos/${id}/diff?path=long.txt&whole=true`);
      expect(res.status).toBe(200);
      const lines = ((await res.json()) as { lines: WireDiffLine[] }).lines;
      expect(lines.filter((l) => l.type === 'context').length).toBe(LINE_COUNT - 2);
    } finally {
      await webDaemon.close();
    }
  });
});
