/**
 * API-mode surface reduction: a `web` daemon (the transport a --port bind
 * uses) routes only what the web UI needs — reads, repo open/release, and
 * file-level stage/unstage. The CLI-only mutations (commit, discard, hunk
 * staging, all remote/branch ops, persisted compare base) are not routed at
 * all, so they 404 as "Unknown route". A `full` daemon routes them.
 *
 * Self-contained: own daemon instances, own sockets, own /tmp fixture repo.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createDaemon, Daemon } from './server.js';

const WEB_SOCKET = path.join(os.tmpdir(), `diffstalkerd-web-${process.pid}.sock`);
const FULL_SOCKET = path.join(os.tmpdir(), `diffstalkerd-full-${process.pid}.sock`);

let webDaemon: Daemon;
let fullDaemon: Daemon;
let repoDir: string;
let repoId: string;

function gitExec(cwd: string, command: string): string {
  return execSync(`git ${command}`, {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}

function req(socket: string, method: string, pathname: string, body?: unknown): Promise<Response> {
  return fetch(`http://localhost${pathname}`, {
    method,
    unix: socket,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  } as RequestInit);
}

async function openOn(socket: string): Promise<string> {
  const res = await req(socket, 'POST', '/repos', { path: repoDir });
  const json = (await res.json()) as { id: string };
  return json.id;
}

beforeAll(async () => {
  repoDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ds-apimode-')));
  gitExec(repoDir, 'init --initial-branch=main');
  gitExec(repoDir, 'config user.email "test@test.com"');
  gitExec(repoDir, 'config user.name "Test User"');
  fs.writeFileSync(path.join(repoDir, 'file.txt'), 'one\n');
  gitExec(repoDir, 'add file.txt');
  gitExec(repoDir, 'commit -m initial');
  // An unstaged modification so POST /stage has a real entry to act on.
  fs.writeFileSync(path.join(repoDir, 'file.txt'), 'one\ntwo\n');

  webDaemon = createDaemon({ apiMode: 'web' });
  fullDaemon = createDaemon({ apiMode: 'full' });
  await webDaemon.listen({ socketPath: WEB_SOCKET });
  await fullDaemon.listen({ socketPath: FULL_SOCKET });
  repoId = await openOn(WEB_SOCKET);
  await openOn(FULL_SOCKET);
});

afterAll(async () => {
  await webDaemon?.close();
  await fullDaemon?.close();
  for (const s of [WEB_SOCKET, FULL_SOCKET]) fs.rmSync(s, { force: true });
  fs.rmSync(repoDir, { recursive: true, force: true });
});

describe('web-mode API surface', () => {
  test('reads still work (status)', async () => {
    const res = await req(WEB_SOCKET, 'GET', `/repos/${repoId}/status`);
    expect(res.status).toBe(200);
  });

  test('file-level stage IS routed', async () => {
    const res = await req(WEB_SOCKET, 'POST', `/repos/${repoId}/stage`, { path: 'file.txt' });
    // Present + succeeds (200); crucially not an "Unknown route" 404.
    expect(res.status).toBe(200);
  });

  test('unstage IS routed', async () => {
    const res = await req(WEB_SOCKET, 'POST', `/repos/${repoId}/unstage`, { path: 'file.txt' });
    expect(res.status).toBe(200);
  });

  const cliOnly: Array<[string, string, unknown]> = [
    ['POST', 'commit', { message: 'x' }],
    ['POST', 'discard', { path: 'file.txt' }],
    ['POST', 'stage-all', undefined],
    ['POST', 'stage-hunk', { patch: 'x' }],
    ['POST', 'push', undefined],
    ['POST', 'pull', undefined],
    ['POST', 'stash', undefined],
    ['POST', 'switch-branch', { branch: 'main' }],
    ['POST', 'soft-reset', { count: 1 }],
    ['POST', 'revert', { hash: 'HEAD' }],
    ['POST', 'abort', undefined],
    ['PUT', 'compare/base', { branch: 'main' }],
  ];

  for (const [method, route, body] of cliOnly) {
    test(`CLI-only ${method} /${route} is NOT routed (404 Unknown route)`, async () => {
      const res = await req(WEB_SOCKET, method, `/repos/${repoId}/${route}`, body);
      expect(res.status).toBe(404);
      const json = (await res.json()) as { error?: string };
      expect(json.error ?? '').toContain('Unknown route');
    });
  }
});

describe('full-mode API surface', () => {
  test('CLI-only routes ARE registered (commit reaches validation, not a route 404)', async () => {
    const res = await req(FULL_SOCKET, 'POST', `/repos/${repoId}/commit`, { message: '' });
    // Empty message -> validation 400; the point is it is NOT "Unknown route".
    const json = (await res.json()) as { error?: string };
    expect(json.error ?? '').not.toContain('Unknown route');
  });

  test('push route IS registered in full mode', async () => {
    const res = await req(FULL_SOCKET, 'POST', `/repos/${repoId}/push`);
    const json = (await res.json()) as { error?: string };
    // No remote configured -> a git failure, but the route exists.
    expect(json.error ?? '').not.toContain('Unknown route');
  });
});
