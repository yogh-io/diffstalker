/**
 * A repo whose directory is deleted while it is open.
 *
 * Once the manager has seen the directory gone, every route that would run
 * git answers 410 with the reason, not a 500 with simple-git's stack. The
 * routes a client needs to learn that and let go still work: GET /status
 * (the cached state says why) and DELETE /repos/:id.
 *
 * Self-contained: own daemon, own socket, own temp repo.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createDaemon, Daemon } from './server.js';

const SOCKET = path.join(os.tmpdir(), `diffstalkerd-vanished-${process.pid}.sock`);

let daemon: Daemon;
let repoDir: string;
let repoId: string;

function request(pathname: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`http://localhost${pathname}`, { ...init, unix: SOCKET } as RequestInit);
}

beforeAll(async () => {
  repoDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'diffstalkerd-vanished-')));
  const git = (command: string): void => {
    execSync(`git ${command}`, { cwd: repoDir, stdio: 'ignore' });
  };
  git('init --initial-branch=main');
  git('config user.email "test@test.com"');
  git('config user.name "Test User"');
  fs.writeFileSync(path.join(repoDir, 'a.txt'), 'a\n');
  git('add .');
  git('commit -m "initial"');

  daemon = createDaemon();
  await daemon.listen({ socketPath: SOCKET });
  const res = await request('/repos', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: repoDir }),
  });
  repoId = ((await res.json()) as { id: string }).id;
});

afterAll(async () => {
  await daemon.close();
  fs.rmSync(SOCKET, { force: true });
  fs.rmSync(repoDir, { recursive: true, force: true });
});

describe('a repo whose directory vanished while open', () => {
  test('git routes answer 410 with the reason; status and release still work', async () => {
    fs.rmSync(repoDir, { recursive: true, force: true });
    // The first git run after the delete is where the manager notices.
    await request(`/repos/${repoId}/stage-all`, { method: 'POST' });

    const diff = await request(`/repos/${repoId}/diff`);
    expect(diff.status).toBe(410);
    expect(((await diff.json()) as { error: string }).error).toBe(
      'Repository directory no longer exists'
    );
    expect((await request(`/repos/${repoId}/history`)).status).toBe(410);

    const status = await request(`/repos/${repoId}/status`);
    expect(status.status).toBe(200);
    const state = (await status.json()) as { status: { isRepo: boolean } | null };
    expect(state.status?.isRepo).toBe(false);

    const release = await request(`/repos/${repoId}`, { method: 'DELETE' });
    expect(release.status).toBeLessThan(300);
  });
});
